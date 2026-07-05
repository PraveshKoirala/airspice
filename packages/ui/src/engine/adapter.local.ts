/**
 * Local-mode engine adapter entry (issue #86: tree-shakable engine selection).
 *
 * The `vite.config.ts` `resolve.alias` swaps this file in for `./adapter` when
 * the build runs with `VITE_ENGINE=local`. Because the swap happens at build
 * time, only ONE adapter's static-import graph enters the bundle -- the other
 * adapter (and, crucially in server mode, the sim-wasm client + eecircuit-engine
 * + graph.worker chunks it drags in) is fully tree-shaken out.
 *
 * See `./adapter.server.ts` for the mirror file, and `./index.ts` for the
 * facade that imports `createEngine` from this seam.
 */

import type { AirEngine } from './types';
import { createLocalEngine } from './local';

export function createEngine(): AirEngine {
  return createLocalEngine();
}
