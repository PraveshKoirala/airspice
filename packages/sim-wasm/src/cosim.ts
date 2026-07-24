/**
 * Firmware ⇄ analog lockstep co-simulation orchestrator (Milestone M8, ADR 0011).
 *
 * WHAT THIS IS (and is not): eecircuit-engine is fire-and-forget — it cannot be
 * paused mid-transient to `alter` a source and resume (that is issue #88, the
 * control-capable engine). So this orchestrator uses the technique that is
 * CORRECT for a non-interruptible solver: **quasi-static re-solve per firmware
 * I/O event**. On each virtual-clock tick the firmware reads its ADC inputs,
 * decides new GPIO output levels, those levels become DC drive voltages on the
 * analog netlist's GPIO source devices, the analog engine RE-SOLVES, and the new
 * node voltages feed back as the next ADC reading. This genuinely closes the
 * mixed-signal loop across domains over deterministic virtual time.
 *
 * REGIME / honesty: this is event-driven quasi-static co-sim — appropriate when
 * the MCU samples slowly relative to analog settling (the common case for the
 * education/maker circuits AirSpice targets). Time-accurate, transient-preserving
 * lockstep (halt/alter/resume WITHOUT re-solving from t=0) awaits the
 * control-capable engine (#88). No wall-clock time is ever consulted.
 *
 * The analog engine and firmware model are INJECTED, so the coupling loop is
 * fully unit-testable without WASM (inject an analytic engine + a JS firmware
 * model) and runs against real ngspice in production (inject
 * {@link createSimClientAnalogEngine}). When mpy-wasm (#37) lands it becomes the
 * FirmwareModel; the loop here does not change.
 */

import type { SimClient } from "./client.js";
import type { WaveTable } from "./protocol.js";
import { finalValue } from "./result.js";

/** Maps one MCU pin to a circuit net and (for outputs) its driving source. */
export interface PinBinding {
  mcuPin: string;
  net: string;
  direction: "input" | "output";
  /** Output only: the netlist source device this GPIO drives, e.g. "V_GPIO4". */
  deviceId?: string;
  /** Output HIGH voltage in volts (default 3.3). */
  vHigh?: number;
  /** Input ADC reference in volts (default 3.3). */
  vref?: number;
}

/** Snapshot of the coupled state after a tick. `simTime` is virtual seconds. */
export interface CoSimStepState {
  simTime: number;
  gpio: Record<string, 0 | 1>;
  adc: Record<string, number>;
  voltages: Record<string, number>;
}

export interface CoSimOptions {
  runId: string;
  /** Virtual milliseconds advanced per tick (default 1). */
  stepMs?: number;
  /** Total virtual milliseconds for `run()` (default = one step). */
  durationMs?: number;
  bindings: PinBinding[];
}

/** Inputs to one analog solve: current GPIO drive voltages + virtual time. */
export interface AnalogSolveInput {
  /** deviceId → forced DC voltage (V) from firmware GPIO outputs. */
  drives: Record<string, number>;
  timeMs: number;
}

export interface AnalogSolveOutput {
  /** net id → node voltage (V). */
  voltages: Record<string, number>;
}

/** The analog domain: given GPIO drives, return node voltages. */
export interface AnalogEngine {
  solve(input: AnalogSolveInput): Promise<AnalogSolveOutput>;
}

export interface FirmwareStepInput {
  timeMs: number;
  /** MCU input pin → ADC value (uint16). */
  adc: Record<string, number>;
  /** MCU output pin → current level. */
  gpio: Record<string, 0 | 1>;
}

export interface FirmwareStepOutput {
  /** MCU output pin → new level. Omitted pins keep their prior level. */
  gpio?: Record<string, 0 | 1>;
}

/** The firmware domain: one behavioral step. (mpy-wasm #37 will implement this.) */
export interface FirmwareModel {
  step(input: FirmwareStepInput): FirmwareStepOutput | Promise<FirmwareStepOutput>;
}

function recordFrom<V>(map: Map<string, V>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [k, v] of map.entries()) out[k] = v;
  return out;
}

export class CoSimOrchestrator {
  private readonly analog: AnalogEngine;
  private readonly firmware: FirmwareModel;
  private readonly options: CoSimOptions;
  private readonly stepMs: number;
  private currentSimTimeMs = 0;
  private readonly gpioLevels = new Map<string, 0 | 1>();
  private readonly adcValues = new Map<string, number>();
  private netVoltages: Record<string, number> = {};

  constructor(analog: AnalogEngine, firmware: FirmwareModel, options: CoSimOptions) {
    this.analog = analog;
    this.firmware = firmware;
    this.options = options;
    this.stepMs = options.stepMs ?? 1.0;
    for (const b of options.bindings) {
      if (b.direction === "output") this.gpioLevels.set(b.mcuPin, 0);
      else this.adcValues.set(b.mcuPin, 0);
    }
  }

  /**
   * Translate an analog node voltage (0..vref) to a MicroPython ADC uint16
   * (0..65535) — the machine.ADC.read_u16() convention.
   */
  translateVoltageToAdc(voltage: number, vref = 3.3): number {
    const clamped = Math.max(0, Math.min(vref, voltage));
    return Math.round((clamped / vref) * 65535);
  }

  /** Current GPIO output levels as drive voltages, keyed by source device id. */
  private currentDrives(): Record<string, number> {
    const drives: Record<string, number> = {};
    for (const b of this.options.bindings) {
      if (b.direction === "output" && b.deviceId) {
        const level = this.gpioLevels.get(b.mcuPin) ?? 0;
        drives[b.deviceId] = level === 1 ? b.vHigh ?? 3.3 : 0.0;
      }
    }
    return drives;
  }

  /** Fold a fresh analog solve into ADC input registers. */
  private applyAnalog(voltages: Record<string, number>): void {
    this.netVoltages = voltages;
    for (const b of this.options.bindings) {
      if (b.direction === "input") {
        const v = voltages[b.net] ?? 0;
        this.adcValues.set(b.mcuPin, this.translateVoltageToAdc(v, b.vref ?? 3.3));
      }
    }
  }

  private snapshot(): CoSimStepState {
    return {
      simTime: this.currentSimTimeMs / 1000.0,
      gpio: recordFrom(this.gpioLevels),
      adc: recordFrom(this.adcValues),
      voltages: { ...this.netVoltages },
    };
  }

  /** Prime the analog state at t=0 (initial solve, firmware not yet stepped). */
  async initialize(): Promise<CoSimStepState> {
    const { voltages } = await this.analog.solve({
      drives: this.currentDrives(),
      timeMs: this.currentSimTimeMs,
    });
    this.applyAnalog(voltages);
    return this.snapshot();
  }

  /**
   * One coupled lockstep tick: advance the virtual clock, let the firmware read
   * ADCs and set GPIOs, then RE-SOLVE the analog domain with the new drives and
   * feed the result back to the ADC registers.
   */
  async advance(): Promise<CoSimStepState> {
    this.currentSimTimeMs += this.stepMs;
    const out = await this.firmware.step({
      timeMs: this.currentSimTimeMs,
      adc: recordFrom(this.adcValues),
      gpio: recordFrom(this.gpioLevels),
    });
    if (out.gpio) {
      for (const [pin, level] of Object.entries(out.gpio)) {
        if (this.gpioLevels.has(pin)) this.gpioLevels.set(pin, level);
      }
    }
    const { voltages } = await this.analog.solve({
      drives: this.currentDrives(),
      timeMs: this.currentSimTimeMs,
    });
    this.applyAnalog(voltages);
    return this.snapshot();
  }

  /**
   * Run the full lockstep co-simulation for `durationMs`, returning the trace
   * (index 0 is the t=0 priming solve, then one entry per tick).
   */
  async run(): Promise<CoSimStepState[]> {
    const trace: CoSimStepState[] = [await this.initialize()];
    const duration = this.options.durationMs ?? this.stepMs;
    const steps = Math.max(1, Math.round(duration / this.stepMs));
    for (let i = 0; i < steps; i++) trace.push(await this.advance());
    return trace;
  }

  /** Current virtual simulation time in seconds. */
  getSimTimeSec(): number {
    return this.currentSimTimeMs / 1000.0;
  }
}

/**
 * Production {@link AnalogEngine}: re-solve the circuit on the real WASM ngspice
 * worker each firmware step. `buildNetlist(drives)` must render a netlist whose
 * GPIO source devices take the given DC drive voltages (the caller owns the
 * templating so the airspice compiler stays the single source of truth for the
 * rest of the netlist); `nets` are the probed input nets to read back.
 */
export function createSimClientAnalogEngine(
  client: Pick<SimClient, "run">,
  buildNetlist: (drives: Record<string, number>) => string,
  nets: string[],
): AnalogEngine {
  return {
    async solve({ drives, timeMs }: AnalogSolveInput): Promise<AnalogSolveOutput> {
      const netlist = buildNetlist(drives);
      const probes = nets.map((n) => ({ id: n, vector: `v(${n})` }));
      let tables: WaveTable[] = [];
      for await (const ev of client.run({ id: `cosim@${timeMs}`, netlist, probes })) {
        if (ev.type === "result") tables = ev.tables;
        else if (ev.type === "error") {
          throw new Error(`analog solve failed at t=${timeMs}ms: ${ev.diagnostic.message}`);
        }
      }
      const voltages: Record<string, number> = {};
      for (const n of nets) voltages[n] = finalValue(tables, `v(${n})`);
      return { voltages };
    },
  };
}
