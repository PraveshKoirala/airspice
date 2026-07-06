/**
 * Server-mode engine adapter entry (issue #86: tree-shakable engine selection).
 *
 * The `vite.config.ts` `resolve.alias` swaps this file in for `./adapter` when
 * the build runs without `VITE_ENGINE=local` (i.e. server mode, the default).
 * Because the swap happens at build time, only the server adapter's
 * static-import graph enters the bundle -- the local adapter (and the sim-wasm
 * client, eecircuit-engine WASM chunk, and graph.worker chunk it drags in) is
 * fully tree-shaken out.
 *
 * See `./adapter.local.ts` for the mirror file, and `./index.ts` for the
 * facade that imports `createEngine` from this seam.
 */

import type { AirEngine } from './types';
import { createServerEngine } from './server';

export function createEngine(): AirEngine {
  return createServerEngine();
}
