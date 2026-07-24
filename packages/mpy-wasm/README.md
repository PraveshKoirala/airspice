# mpy-wasm

Real **MicroPython WASM** firmware runtime with a **deterministic virtual clock**
(issue #37). It executes a design's firmware Python (`setup()` / `loop()`)
through the actual [`@micropython/micropython-webassembly-pyscript`][pkg] port —
no hand-rolled interpreter, no stubbed execution — and exposes a
**`FirmwareModel`-compatible** `step()` so #38's `CoSimOrchestrator`
(`packages/sim-wasm/src/cosim.ts`) can drive firmware ⇄ analog lockstep.

The firmware's own Python threshold logic decides the GPIO. Feed a cold ADC
reading and a thermostat drives its heater pin HIGH; feed a warm one and it goes
LOW — because real MicroPython ran the `if reading < THRESHOLD` branch.

## Runtime model — tick-based virtual clock

Firmware is Arduino/MicroPython-style: `setup()` runs once, `loop()` runs once
per virtual tick. This avoids intercepting `utime.sleep` and keeps time
deterministic.

- `init(firmwareSource, bindings?)` loads MicroPython, installs the JS-backed
  `machine` / `time` / `utime` modules, runs the firmware source, and calls
  `setup()` at virtual `t = 0`.
- `step({ timeMs, adc, gpio })` injects the ADC readings and digital input
  levels, sets the virtual clock to `timeMs`, calls `loop()`, and returns the
  GPIO levels the firmware set: `{ gpio }`.

### The `machine` / `time` bridges

Registered into MicroPython via `registerJsModule(...)` before the firmware runs,
so `import machine` / `from machine import Pin, ADC` resolve to plain JS objects:

| Firmware call                | Backed by                                                        |
| ---------------------------- | ---------------------------------------------------------------- |
| `machine.Pin(id, mode)`      | JS Pin object; `.value(v)` writes a 0/1 into a JS GPIO map        |
| `pin.value()` (no arg)       | reads the current level (injected input, or last-written output) |
| `pin.on()` / `pin.off()`     | write 1 / 0                                                       |
| `machine.ADC(pin)`           | JS ADC; `pin` may be an int or a `Pin` object                    |
| `adc.read_u16()`             | returns the injected uint16 for that pin (0..65535)              |
| `machine.ticks_ms()`         | the **virtual** clock (integer ms)                               |
| `time` / `utime.ticks_ms()`  | the virtual clock                                                |
| `time.ticks_us()`            | `ticks_ms * 1000`                                                |
| `time.ticks_diff/ticks_add`  | plain integer arithmetic                                         |
| `time.sleep / sleep_ms / sleep_us` | **no-op** (see below)                                      |

### Why `sleep_*` is a no-op

Under the tick model the *orchestrator* advances virtual time (`stepMs` per
tick); the firmware never waits in real time. A `time.sleep_ms(500)` inside
`loop()` therefore returns immediately — it does **not** block and **never**
consults a wall clock. The advanced virtual time arrives as the next step's
`timeMs`. This is what makes a tight co-sim loop fast and reproducible: 5 steps
each calling `sleep_ms(500)` complete in well under a millisecond of wall time,
while `ticks_ms()` still reports `1000, 2000, 3000, …`.

### Determinism

Given the same firmware source and the same sequence of injected ADC/GPIO
values, the sequence of GPIO outputs and virtual timestamps is **identical**
across runs. The only time source is an integer `clockMs` set from each step's
`timeMs`. Nothing in the bridges reads `Date`, `performance`, wall-clock, or
`Math.random`.

## Interface (drop-in for #38)

`MpyFirmwareRuntime` implements the `FirmwareModel` contract from
`packages/sim-wasm/src/cosim.ts` — mirrored in `src/types.ts`
(`FirmwareStepInput` / `FirmwareStepOutput` / `FirmwareModel`), so an instance
can be handed straight to `new CoSimOrchestrator(analog, runtime, options)`:

```ts
import { createNodeRuntime } from "mpy-wasm/node";
import { CoSimOrchestrator } from "sim-wasm";

const runtime = createNodeRuntime({ stepMs: 100 });
await runtime.init(thermostatSource, [
  { mcuPin: "15", direction: "output" },
  { mcuPin: "26", direction: "input" },
]);

const orch = new CoSimOrchestrator(analogEngine, runtime, {
  runId: "demo",
  stepMs: 100,
  durationMs: 1500,
  bindings: [
    { mcuPin: "15", net: "SENSOR", direction: "output", deviceId: "V_HEAT", vHigh: 3.3 },
    { mcuPin: "26", net: "SENSOR", direction: "input", vref: 3.3 },
  ],
});
const trace = await orch.run(); // real MicroPython closing the mixed-signal loop
```

`step()` on `MpyFirmwareRuntime` is **synchronous**; `FirmwareModel.step` also
permits a `Promise`, which is what the browser worker path returns.

## Environments

The MicroPython instance is **injected** via a `MicroPythonLoader`, so the same
runtime core (`src/runtime.ts` + `src/machine.ts`) runs in both environments:

- **Node** (`mpy-wasm/node`) — **verified**. `nodeMicroPythonLoader` resolves the
  packaged `micropython.wasm` via `createRequire` and `loadMicroPython({ url })`.
  This is the environment the co-sim tests run against. `createNodeRuntime()` is
  the convenience factory.
- **Browser worker** (`mpy-wasm/worker`, `src/runtime.worker.ts`) — wired by
  construction (same runtime core, same real WASM, off the main thread) and
  driven through `MpyWorkerFirmware` (`src/worker-client.ts`), itself a
  `FirmwareModel`. The host app supplies the bundler-resolved wasm URL, e.g.
  `import wasmUrl from "@micropython/micropython-webassembly-pyscript/micropython.wasm?url"`.
  End-to-end browser execution depends on that bundler asset wiring and is not
  exercised by the Node test suite.

## Real package API (discovered)

`@micropython/micropython-webassembly-pyscript@1.28.0-6` ships no `.d.ts`; the
API below was read out of its `micropython.mjs` (ambient types in
`src/micropython.d.ts`):

- `loadMicroPython(options?) → Promise<instance>` — options include `url` (path
  to the `.wasm`; else derived from the `.mjs` location), `stdout`, `stderr`,
  `linebuffer`, `heapsize`, `pystack`. It auto-detects Node.
- The instance exposes `registerJsModule(name, module)`, `runPython(code)`,
  `runPythonAsync(code)`, `pyimport(name)`, `globals` (`get`/`set`/`delete` over
  the `__main__` namespace), and `FS`.

The runtime registers `machine`/`time`/`utime` with `registerJsModule`, runs the
firmware with `runPython`, then holds the `setup`/`loop` function proxies from
`globals.get(...)` and calls them directly each step.

## Files

- `src/machine.ts` — `MachineBridge`: the JS-backed `machine`/`time` modules and
  the mutable GPIO/ADC/clock state. Pure JS, no WASM.
- `src/runtime.ts` — `MpyFirmwareRuntime`: `init()` + `step()`, `FirmwareModel`.
- `src/types.ts` — the mirrored FirmwareModel contract + public types.
- `src/loader-browser.ts` / `src/node/index.ts` — env-specific WASM loaders.
- `src/runtime.worker.ts` — browser Web Worker entry.
- `src/worker-client.ts` — `MpyWorkerFirmware`, the main-thread handle.
- `src/protocol.ts` — worker message protocol.

[pkg]: https://www.npmjs.com/package/@micropython/micropython-webassembly-pyscript
