/// <reference lib="webworker" />
/**
 * air-ts engine Web Worker (issue #10, AGENTS.md rule 8: "the main thread is
 * sacred"). XML -> graph and XML -> diagnostics both run HERE, off the main
 * thread, so typing in Monaco never stutters while a design is (re)parsed.
 *
 * air-ts is DOM-free by construction (epic #6), so it imports and runs cleanly
 * in a Worker. This file is the ONLY worker wrapper; the emitter/validator logic
 * lives in air-ts, not here (issue guardrail: "the emitter lives in air-ts, the
 * UI only renders").
 *
 * Imported as a module worker (`new Worker(url, { type: 'module' })`), which
 * Vite bundles via the `?worker`/`new URL` convention.
 */

import { toGraph, validate, buildDiagnosticsPayload } from 'air-ts';
import type { EngineRequest, EngineResponse } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (event: MessageEvent<EngineRequest>) => {
  const { id, method, xml } = event.data;
  try {
    let result: EngineResponse['ok'] extends true ? unknown : unknown;
    if (method === 'toGraph') {
      // air-ts returns { nodes, edges } as JSON values; the UI treats them as
      // reactflow Node/Edge (structural superset). No shaping happens here.
      result = toGraph(xml);
    } else if (method === 'validate') {
      // buildDiagnosticsPayload -> { success: !hasErrors, diagnostics }.
      result = buildDiagnosticsPayload(validate(xml));
    } else {
      throw new Error(`unknown engine method: ${String(method)}`);
    }
    const response: EngineResponse = { id, ok: true, result: result as never };
    ctx.postMessage(response);
  } catch (error) {
    // Parse/validation errors (malformed XML, etc.) are expected while the user
    // is mid-edit -- surface them as a settled error, never an unhandled throw.
    const message = error instanceof Error ? error.message : String(error);
    const response: EngineResponse = { id, ok: false, error: message };
    ctx.postMessage(response);
  }
});
