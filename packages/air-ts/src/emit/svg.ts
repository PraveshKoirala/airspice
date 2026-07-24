/**
 * Headless schematic SVG emitter (issue #40 — MCP `render_schematic`).
 *
 * The interactive Schematic tab (packages/ui) renders the schematic-graph with
 * React + ELK (async, DOM-bound, browser-only). An external agent talking to
 * AirSpice over MCP has no DOM and no ELK worker, so it needs a HEADLESS,
 * DETERMINISTIC renderer that turns the same schematic-graph (`buildGraphData`,
 * emit/graph.ts) into a standalone SVG string with zero dependencies.
 *
 * WHAT THIS IS (and is not): this is a deterministic TOPOLOGY schematic — a
 * bipartite component/net diagram (component boxes on the left with their pins,
 * net pills on the right coloured by role, one polyline per connected pin). It
 * is a faithful, reproducible view of the design's connectivity — the exact
 * `{nodes, edges}` the UI consumes — NOT a pixel-for-pixel copy of the UI's
 * ELK-placed, symbol-drawn canvas (that layout is inherently async and
 * browser-coupled). Same design in → same SVG bytes out, so an agent can diff
 * renders across edits.
 *
 * Pure model → string; no DOM, no fs, no async (epic #6). Lives in air-ts so the
 * render logic stays in the engine layer, not in any transport/wiring package.
 */

import type { SystemIR } from "../model.js";
import { buildGraphData } from "./graph.js";

interface CompView {
  id: string;
  type: string;
  value: string;
  part: string;
  pins: string[];
}

interface NetView {
  id: string;
  label: string;
  role: string;
}

interface EdgeView {
  component: string;
  net: string;
  pin: string;
}

// Layout lattice (deterministic; no ELK). Two columns: components left, nets
// right, straight polylines between them.
const MARGIN = 24;
const COMP_X = 24;
const COMP_W = 210;
const NET_X = 430;
const NET_W = 150;
const NET_H = 30;
const ROW_GAP = 16;
const HEADER_H = 40;
const PIN_ROW_H = 18;
const CANVAS_W = NET_X + NET_W + MARGIN;

/** XML-escape a text node / attribute value. */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One of the three schematic net colours, keyed by the graph node's role. */
function roleColor(role: string): string {
  const r = role.toLowerCase();
  if (r.includes("ground")) return "#374151";
  if (r.includes("power")) return "#b91c1c";
  return "#1d4ed8";
}

function componentHeight(c: CompView): number {
  return HEADER_H + Math.max(1, c.pins.length) * PIN_ROW_H + 8;
}

/**
 * Render a design's schematic-graph to a standalone, deterministic SVG string.
 *
 * The input is the SAME typed model the whole engine uses; internally it builds
 * the schematic-graph via `buildGraphData` (emit/graph.ts) so the rendered
 * topology is byte-identical to what the UI's Schematic tab consumes.
 */
export function emitSchematicSvg(ir: SystemIR): string {
  const graph = buildGraphData(ir);

  const comps: CompView[] = [];
  const nets: NetView[] = [];
  for (const raw of graph.nodes) {
    const node = raw as {
      id: string;
      type: string;
      data: Record<string, unknown>;
    };
    if (node.type === "component") {
      const pins = Array.isArray(node.data["pins"])
        ? (node.data["pins"] as Array<{ name: string }>).map((p) => String(p.name))
        : [];
      comps.push({
        id: node.id,
        type: String(node.data["type"] ?? ""),
        value: String(node.data["value"] ?? ""),
        part: String(node.data["part"] ?? ""),
        pins,
      });
    } else if (node.type === "net") {
      nets.push({
        id: node.id,
        label: String(node.data["label"] ?? node.id),
        role: String(node.data["role"] ?? "signal"),
      });
    }
  }
  const edges: EdgeView[] = graph.edges.map((raw) => {
    const e = raw as { source: string; data: { pin: string; net: string } };
    return { component: e.source, net: `net:${e.data.net}`, pin: e.data.pin };
  });

  // Deterministic vertical placement. Component centres are laid out top-down in
  // graph (id-sorted) order; net centres likewise. Positions are a pure function
  // of the design, so the same design renders to the same bytes.
  const compTop = new Map<string, number>();
  const compMid = new Map<string, number>();
  let y = MARGIN;
  for (const c of comps) {
    compTop.set(c.id, y);
    compMid.set(c.id, y + componentHeight(c) / 2);
    y += componentHeight(c) + ROW_GAP;
  }
  const compsBottom = y;

  const netMid = new Map<string, number>();
  let ny = MARGIN;
  for (const n of nets) {
    netMid.set(n.id, ny + NET_H / 2);
    ny += NET_H + ROW_GAP;
  }
  const netsBottom = ny;

  const canvasH = Math.max(compsBottom, netsBottom, MARGIN * 2) + MARGIN;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS_W} ${canvasH}" ` +
      `width="${CANVAS_W}" height="${canvasH}" font-family="ui-sans-serif, system-ui, sans-serif">`,
  );
  parts.push(
    `<style>` +
      `.comp{fill:#f8fafc;stroke:#0f172a;stroke-width:1.5;rx:6}` +
      `.comp-id{font-size:13px;font-weight:600;fill:#0f172a}` +
      `.comp-sub{font-size:10px;fill:#475569}` +
      `.pin{font-size:10px;fill:#334155}` +
      `.net{stroke:#0f172a;stroke-width:1.25}` +
      `.net-label{font-size:11px;font-weight:600;fill:#ffffff}` +
      `.wire{stroke:#94a3b8;stroke-width:1.25;fill:none}` +
      `.wire-label{font-size:9px;fill:#64748b}` +
      `</style>`,
  );
  parts.push(`<rect x="0" y="0" width="${CANVAS_W}" height="${canvasH}" fill="#ffffff"/>`);

  // Wires first (so nodes draw on top).
  for (const e of edges) {
    const cy = compMid.get(e.component);
    const nyMid = netMid.get(e.net);
    if (cy === undefined || nyMid === undefined) continue;
    const x1 = COMP_X + COMP_W;
    const x2 = NET_X;
    const midX = (x1 + x2) / 2;
    parts.push(
      `<path class="wire" d="M ${x1} ${cy.toFixed(1)} L ${midX} ${cy.toFixed(1)} ` +
        `L ${midX} ${nyMid.toFixed(1)} L ${x2} ${nyMid.toFixed(1)}"/>`,
    );
    parts.push(
      `<text class="wire-label" x="${x1 + 4}" y="${(cy - 3).toFixed(1)}">${esc(e.pin)}</text>`,
    );
  }

  // Component boxes.
  for (const c of comps) {
    const top = compTop.get(c.id) ?? MARGIN;
    const h = componentHeight(c);
    parts.push(
      `<rect class="comp" x="${COMP_X}" y="${top}" width="${COMP_W}" height="${h}" rx="6"/>`,
    );
    parts.push(
      `<text class="comp-id" x="${COMP_X + 10}" y="${top + 18}">${esc(c.id)}</text>`,
    );
    const sub = [c.type, c.part, c.value].filter(Boolean).join("  ·  ");
    parts.push(
      `<text class="comp-sub" x="${COMP_X + 10}" y="${top + 32}">${esc(sub)}</text>`,
    );
    let py = top + HEADER_H + 4;
    for (const pin of c.pins) {
      parts.push(
        `<text class="pin" x="${COMP_X + 14}" y="${py + 10}">${esc(pin)}</text>`,
      );
      py += PIN_ROW_H;
    }
  }

  // Net pills.
  for (const n of nets) {
    const mid = netMid.get(n.id) ?? MARGIN;
    const top = mid - NET_H / 2;
    parts.push(
      `<rect x="${NET_X}" y="${top}" width="${NET_W}" height="${NET_H}" rx="15" ` +
        `fill="${roleColor(n.role)}" class="net"/>`,
    );
    parts.push(
      `<text class="net-label" x="${NET_X + NET_W / 2}" y="${(mid + 4).toFixed(1)}" ` +
        `text-anchor="middle">${esc(n.label)}</text>`,
    );
  }

  parts.push(`</svg>`);
  return parts.join("");
}
