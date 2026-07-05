/**
 * Server engine (issue #10): the existing FastAPI backend, reached over axios.
 * This is the DEFAULT until M2 (`VITE_ENGINE` unset or "server"), preserving the
 * pre-#10 behaviour exactly -- `toGraph` hits `POST /graph`, `validate` hits
 * `POST /validate-xml`, both with the same `{ xml }` body the UI already sent.
 *
 * Keeping the server path behind the SAME facade interface as the local engine
 * is the point: the rest of the UI calls `engine.toGraph(xml)` and never learns
 * which backend answered.
 */

import axios from 'axios';
import type {
  AirEngine,
  GraphData,
  DiagnosticsPayload,
  EngineMode,
  LocalSimulationResult,
} from './types';
import { NotImplementedError } from './types';

/** Same base the UI used before #10. */
const API_BASE = 'http://127.0.0.1:8000';

class ServerEngine implements AirEngine {
  readonly mode: EngineMode = 'server';

  async toGraph(xml: string): Promise<GraphData> {
    const response = await axios.post(`${API_BASE}/graph`, { xml });
    if (!response.data?.success) {
      throw new Error(response.data?.error || 'graph computation failed');
    }
    return { nodes: response.data.nodes, edges: response.data.edges };
  }

  async validate(xml: string): Promise<DiagnosticsPayload> {
    const response = await axios.post(`${API_BASE}/validate-xml`, { xml });
    if (response.data?.error && response.data?.success === false && !response.data?.diagnostics) {
      // Parser-level failure surfaced as `{ success:false, error }`.
      throw new Error(response.data.error);
    }
    return {
      success: Boolean(response.data?.success),
      diagnostics: response.data?.diagnostics || [],
    };
  }

  simulate(): Promise<LocalSimulationResult> {
    // Simulation over the facade is the LOCAL (zero-backend) pipeline (#14). In
    // server mode the existing Toolbar "Simulate" button still calls /simulate
    // directly (a persist+run backend workflow, out of #14 scope), so the facade
    // simulate stays a loud stub here.
    return Promise.reject(new NotImplementedError('simulate', 'issue #14 (local engine only)'));
  }

  applyPatch(): Promise<never> {
    return Promise.reject(new NotImplementedError('applyPatch', 'issue #11'));
  }

  dispose(): void {
    // No held resources for the server engine.
  }
}

export function createServerEngine(): AirEngine {
  return new ServerEngine();
}
