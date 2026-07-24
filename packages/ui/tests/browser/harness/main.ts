/**
 * Playwright harness for the report-schema parity test (issue #14 deliverable 6).
 *
 * Exposes `window.__air` driving the REAL local simulation pipeline
 * (`engine/simulate.ts`): compile (air-ts #9) -> WASM ngspice worker (sim-wasm
 * #13) -> report (air-ts report.ts #14) -> retained typed arrays. This is the
 * FULL browser pipeline with NO backend — exactly what the corpus-parity spec
 * runs each design through in a real Chromium.
 *
 * The engine still runs ONLY in the sim-wasm Web Worker; this harness imports the
 * main-thread pipeline orchestrator, never the WASM engine directly.
 */

import { simulateLocal } from "../../../src/engine/simulate";
import { getRun } from "../../../src/engine/waveformStore";
import { waveformCsv, serializeReportJson, parseXmlBytes } from "air-ts";

interface RunDesignOutcome {
  profile: string;
  status: string;
  /** Serialized oracle-schema report JSON (sort_keys), keyed by test id. */
  reportJson: Record<string, string>;
  notes: string[];
  /** CSV exports of every retained waveform, keyed by `${test}_${net}`. */
  csv: Record<string, string>;
}

/**
 * Run one design's default ngspice profile through the full browser pipeline and
 * return the serialized reports + a CSV export of every retained waveform (built
 * from the typed-array store via air-ts `waveformCsv`). Serialization uses
 * air-ts `serializeReportJson` — the same `json.dumps(sort_keys=True)` form the
 * corpus commits — so the spec can diff structure byte-exact + numbers within
 * tolerance.
 */
async function runDesign(xml: string): Promise<RunDesignOutcome> {
  const result = await simulateLocal(xml);
  const run = getRun(result.runId);
  const csv: Record<string, string> = {};
  if (run) {
    for (const [key, wf] of run.waveforms) {
      const samples: [number, number][] = [];
      for (let i = 0; i < wf.values.length; i++) {
        samples.push([wf.time[i] ?? i, wf.values[i] as number]);
      }
      csv[key] = waveformCsv(wf.net, samples);
    }
  }
  const reportJson: Record<string, string> = {};
  for (const report of result.reports) {
    reportJson[report.test] = serializeReportJson(report);
  }
  return {
    profile: result.profile,
    status: result.status,
    reportJson,
    notes: result.notes,
    csv,
  };
}

declare global {
  interface Window {
    __air: {
      runDesign: (xml: string) => Promise<RunDesignOutcome>;
      _ping: () => string;
    };
  }
}

window.__air = { runDesign, _ping: () => "ok" };

// Expose storage layer to test harness
import { useProjectStore } from "../../../src/storage/projectStore";
import { useDesignStore } from "../../../src/agent/designStore";
import { getProject, saveProject, deleteProject, initDatabase, DB_NAME, CURRENT_VERSION } from "../../../src/storage/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__storage = {
  useProjectStore,
  useDesignStore,
  getProject,
  saveProject,
  deleteProject,
  initDatabase,
  DB_NAME,
  CURRENT_VERSION,
  parseXmlBytes,
};

const statusEl = document.getElementById("status");
if (statusEl) statusEl.textContent = "ready";
