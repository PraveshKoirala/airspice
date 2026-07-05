/**
 * Playwright harness entry. Exposes a small API on `window.__simlab` that drives
 * the REAL SimClient (real Web Worker + real WASM ngspice) so the browser tests
 * can assert corpus parity, cancellation, and main-thread non-blocking. This is
 * test-only glue, NOT a product surface.
 *
 * The WASM engine still runs ONLY in the worker here -- the harness imports the
 * client (main-thread message pump), never the engine.
 */

import { SimClient } from "../../../src/index";
import type { SimEvent, EngineCapabilities } from "../../../src/index";

interface RunOutcome {
  events: Array<{ type: string }>;
  stderr: string[];
  stdout: string[];
  finals: Record<string, number>;
  errorCode: string | null;
  durationMs: number;
  /** Longest main-thread blocking longtask observed during the run (ms). */
  longestBlockMs: number;
}

const client = new SimClient();

function observeLongtasks(): { stop: () => number } {
  let longest = 0;
  let obs: PerformanceObserver | null = null;
  try {
    obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > longest) longest = entry.duration;
      }
    });
    obs.observe({ entryTypes: ["longtask"] });
  } catch {
    // longtask not supported in this browser; report 0 (Firefox lacks it).
  }
  return {
    stop: () => {
      obs?.disconnect();
      return longest;
    },
  };
}

async function runNetlist(
  netlist: string,
  probeVectors: string[],
): Promise<RunOutcome> {
  const id = `run-${Math.random().toString(36).slice(2)}`;
  const probes = probeVectors.map((v) => ({ id: v, vector: v }));
  const events: Array<{ type: string }> = [];
  const stderr: string[] = [];
  const stdout: string[] = [];
  const finals: Record<string, number> = {};
  let errorCode: string | null = null;

  const lt = observeLongtasks();
  const t0 = performance.now();
  for await (const ev of client.run({ id, netlist, probes })) {
    events.push({ type: ev.type });
    if (ev.type === "stderr") stderr.push(ev.line);
    else if (ev.type === "stdout") stdout.push(ev.line);
    else if (ev.type === "error") errorCode = ev.diagnostic.code;
    else if (ev.type === "result") {
      for (const t of ev.tables) {
        finals[t.name.toLowerCase()] =
          t.values.length > 0 ? (t.values[t.values.length - 1] as number) : NaN;
      }
    }
  }
  const durationMs = performance.now() - t0;
  const longestBlockMs = lt.stop();
  return { events, stderr, stdout, finals, errorCode, durationMs, longestBlockMs };
}

// A long transient used by the cancellation test: fine step over a long window
// so runSim takes long enough to cancel mid-flight.
const LONG_NETLIST = `* long transient for cancellation
V1 in 0 DC 1
R1 in out 1k
C1 out 0 1u
.tran 100n 2
.end`;

async function cancelDuringLongRun(): Promise<{
  canceledMs: number;
  errorCode: string | null;
  nextRunWorks: boolean;
  nextFinalMid: number;
}> {
  const id = `cancel-${Math.random().toString(36).slice(2)}`;
  let errorCode: string | null = null;
  const t0 = performance.now();
  const stream = client.run({ id, netlist: LONG_NETLIST });
  // Cancel shortly after the run starts.
  setTimeout(() => client.cancel(id), 50);
  for await (const ev of stream) {
    if (ev.type === "error") errorCode = ev.diagnostic.code;
  }
  const canceledMs = performance.now() - t0;

  // Prove the client is usable after cancel: run the divider and check v(mid).
  const divider = `* voltage divider after cancel
V1 vin 0 DC 5
R1 vin mid 10k
R2 mid 0 10k
.tran 1u 5m
.end`;
  const after = await runNetlist(divider, ["v(mid)"]);
  const nextFinalMid = after.finals["v(mid)"] ?? NaN;
  return {
    canceledMs,
    errorCode,
    nextRunWorks: after.errorCode === null,
    nextFinalMid,
  };
}

declare global {
  interface Window {
    __simlab: {
      preload: () => Promise<EngineCapabilities>;
      run: (netlist: string, probeVectors: string[]) => Promise<RunOutcome>;
      cancelDuringLongRun: typeof cancelDuringLongRun;
      _ping: () => string;
    };
  }
}

window.__simlab = {
  preload: () => client.preload(),
  run: runNetlist,
  cancelDuringLongRun,
  _ping: () => "ok",
};

const statusEl = document.getElementById("status");
if (statusEl) statusEl.textContent = "ready";
void (async () => {
  const caps = await client.preload();
  if (statusEl) statusEl.textContent = `ready: ${caps.engine} ${caps.engineVersion} (ngspice ${caps.ngspiceVersion}), control=${caps.control}`;
})();

// Silence unused-import type-only warning in strict builds.
export type { SimEvent };
