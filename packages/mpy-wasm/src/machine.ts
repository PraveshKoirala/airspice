/**
 * JS-backed `machine` + `time` bridges for the MicroPython firmware runtime.
 *
 * These are plain JS objects registered into the real MicroPython WASM via
 * `registerJsModule("machine", …)`. When the firmware does `import machine` /
 * `from machine import Pin, ADC`, MicroPython proxies these objects into Python,
 * so the firmware's REAL Python code calls straight through to the closures
 * below. No Python is interpreted here — this only holds the mutable I/O state
 * (GPIO levels, ADC injections, virtual clock) that the bridges read and write.
 *
 * Determinism: the only time source is {@link MachineBridge.clockMs}, an integer
 * set externally per step. Nothing here reads `Date`, `performance`, wall-clock,
 * or `Math.random`. `sleep`/`sleep_ms`/`sleep_us` are NO-OPS by design (see the
 * README "virtual clock" note): under the tick model the orchestrator advances
 * virtual time, so a firmware `time.sleep_ms(500)` must not block or consult a
 * real clock — it simply returns, and the next step supplies the advanced time.
 */

function toLevel(v: unknown): 0 | 1 {
  return v ? 1 : 0;
}

function toU16(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const n = Math.round(v);
  if (n < 0) return 0;
  if (n > 0xffff) return 0xffff;
  return n;
}

/** A Pin object handed to Python; shares state through the owning bridge. */
interface JsPin {
  id: string;
  mode: unknown;
  value(v?: unknown): 0 | 1 | undefined;
  on(): void;
  off(): void;
  init(): void;
}

/** An ADC object handed to Python; reads the injected uint16 for its pin. */
interface JsAdc {
  read_u16(): number;
}

/**
 * Owns the mutable firmware-facing I/O state and produces the JS module objects
 * registered into MicroPython. One bridge instance per runtime instance.
 */
export class MachineBridge {
  /** pin id → last driven/injected digital level (outputs written, inputs seeded). */
  readonly gpio = new Map<string, 0 | 1>();
  /** pin id → injected ADC reading (uint16), consumed by ADC.read_u16(). */
  readonly adc = new Map<string, number>();
  /** Integer virtual time in ms; the ONLY clock the firmware can observe. */
  private clockMs = 0;

  /** Set the virtual clock (truncated to an integer ms). */
  setClockMs(ms: number): void {
    this.clockMs = Math.trunc(ms);
  }

  /** Current virtual clock in ms. */
  getClockMs(): number {
    return this.clockMs;
  }

  /** Inject an ADC reading (uint16) for a pin id. */
  setAdc(pin: string, value: number): void {
    this.adc.set(pin, toU16(value));
  }

  /** Seed/overwrite a digital level for a pin id (output feedback or input inject). */
  setGpio(pin: string, level: 0 | 1): void {
    this.gpio.set(pin, level);
  }

  /** Read the current digital level for a pin id (0 if never set). */
  getGpio(pin: string): 0 | 1 {
    return this.gpio.get(pin) ?? 0;
  }

  /** Snapshot of all known GPIO levels. */
  snapshotGpio(): Record<string, 0 | 1> {
    const out: Record<string, 0 | 1> = {};
    for (const [k, v] of this.gpio) out[k] = v;
    return out;
  }

  private makePin(id: unknown, mode?: unknown): JsPin {
    const key = String(id);
    const bridge = this;
    return {
      id: key,
      mode,
      value(v?: unknown): 0 | 1 | undefined {
        if (v === undefined) return bridge.getGpio(key);
        bridge.setGpio(key, toLevel(v));
        return undefined;
      },
      on(): void {
        bridge.setGpio(key, 1);
      },
      off(): void {
        bridge.setGpio(key, 0);
      },
      init(): void {
        /* no-op: pin already registered lazily by id */
      },
    };
  }

  private makeAdc(pin: unknown): JsAdc {
    // `pin` may be an int, a str, or a Pin object created above (carrying .id).
    const key =
      pin !== null && typeof pin === "object" && "id" in pin
        ? String((pin as JsPin).id)
        : String(pin);
    const bridge = this;
    return {
      read_u16(): number {
        return bridge.adc.get(key) ?? 0;
      },
    };
  }

  /**
   * The object registered as the Python `machine` module. `Pin.OUT`/`Pin.IN`
   * are provided so firmware written as `Pin(id, Pin.OUT)` resolves; their exact
   * integer values are irrelevant because read/write is decided by whether
   * `.value()` is called with an argument, not by the stored mode.
   */
  machineModule(): unknown {
    const bridge = this;
    const Pin = (id: unknown, mode?: unknown): JsPin => bridge.makePin(id, mode);
    // Constant marker values (arbitrary; firmware uses them symbolically).
    (Pin as unknown as { IN: number; OUT: number; PULL_UP: number; PULL_DOWN: number }).IN = 1;
    (Pin as unknown as { IN: number; OUT: number; PULL_UP: number; PULL_DOWN: number }).OUT = 3;
    (Pin as unknown as { IN: number; OUT: number; PULL_UP: number; PULL_DOWN: number }).PULL_UP = 2;
    (Pin as unknown as { IN: number; OUT: number; PULL_UP: number; PULL_DOWN: number }).PULL_DOWN = 1;
    const ADC = (pin: unknown): JsAdc => bridge.makeAdc(pin);
    return {
      Pin,
      ADC,
      ticks_ms: (): number => bridge.clockMs,
    };
  }

  /**
   * The object registered as both `time` and `utime`. All readings derive from
   * the integer virtual clock; sleeps are no-ops (tick model). Deterministic.
   */
  timeModule(): unknown {
    const bridge = this;
    return {
      ticks_ms: (): number => bridge.clockMs,
      ticks_us: (): number => bridge.clockMs * 1000,
      ticks_diff: (a: number, b: number): number => a - b,
      ticks_add: (t: number, delta: number): number => t + delta,
      sleep: (_s?: number): void => undefined,
      sleep_ms: (_ms?: number): void => undefined,
      sleep_us: (_us?: number): void => undefined,
      time: (): number => Math.trunc(bridge.clockMs / 1000),
    };
  }
}
