# AirSpice MCP server

`packages/mcp-server` is a local, stdio [Model Context Protocol](https://modelcontextprotocol.io)
server that exposes AirSpice's **deterministic engine** to any MCP client
(Claude Code, Claude Desktop, or your own agent). It is thin transport + wiring
over the SAME tool contracts the in-browser agent (issue #18) uses — no forked
validation / simulation / patch / render logic. It runs entirely on your machine
(no hosted mode, no HTTP, no telemetry).

The engine runs for real in Node:

- **air-ts** is isomorphic and used directly (validate / normalize / patch /
  registry / schematic render).
- **sim-wasm** runs the real ngspice WASM engine on a `worker_threads` thread
  (via `sim-wasm/node`), so `run_simulation` returns real measurements, not
  fabricated numbers.

## Build

```bash
npm install
npm --workspace mcp-server run build      # tsc -> packages/mcp-server/dist
```

This produces the `airspice-mcp` binary (`packages/mcp-server/dist/cli.js`). You
can run it directly to confirm it starts (it will wait for MCP frames on stdin):

```bash
node packages/mcp-server/dist/cli.js
# stderr: "airspice-mcp: ready on stdio"
```

## Configure your MCP client

### Claude Code

Add the server to your project (`.mcp.json`) or user config:

```jsonc
{
  "mcpServers": {
    "airspice": {
      "command": "node",
      "args": ["packages/mcp-server/dist/cli.js"]
    }
  }
}
```

or from the CLI:

```bash
claude mcp add airspice -- node /abs/path/to/AirSpice/packages/mcp-server/dist/cli.js
```

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```jsonc
{
  "mcpServers": {
    "airspice": {
      "command": "node",
      "args": ["/abs/path/to/AirSpice/packages/mcp-server/dist/cli.js"]
    }
  }
}
```

Restart Claude Desktop; the AirSpice tools appear in the tool picker.

## The working design (state model)

The browser agent edits a *current design* in the UI. Headlessly, the MCP server
holds an in-process **working design** instead. The stateful tools operate on it:

- `validate_design` and `render_schematic` accept an optional `design_xml`; omit
  it to act on the working design.
- `set_design` / `propose_patch` run the deterministic gate (normalize →
  validate) and stage a proposal; the server then **adopts** the gated result as
  the working design — the headless equivalent of clicking *Apply* in the UI.
- `run_simulation`, `get_design`, and `run_cosim` operate on the working design,
  so stage a design (with `set_design`) before calling them.

## Tools

The first eight are **byte-identical** to the browser agent's tool schemas
(issue #18) — they are imported verbatim from the `agent` package, not
re-declared. The last two are additive, MCP-only capabilities.

| Tool | Purpose | Engine |
| --- | --- | --- |
| `get_design` | Return the working design + live diagnostics | air-ts |
| `set_design` | Stage a full design through the gate (then adopted) | air-ts |
| `validate_design` | Diagnostics for `design_xml` (or the working design) | air-ts |
| `run_simulation` | Run the default ngspice profile → report JSON (#14) | sim-wasm (ngspice) |
| `propose_patch` | Stage an AIR `<patch>` through the gate (then adopted) | air-ts |
| `preview_patch` | Structured op diff + before/after diagnostic deltas | air-ts |
| `read_waveform` | Decimated summary of a probed net from the last run | sim-wasm |
| `list_registry_components` | Component types + MCU parts in the registry | air-ts |
| `render_schematic` | Deterministic, headless **SVG** of the schematic-graph | air-ts |
| `run_cosim` | Firmware ⇄ analog co-sim (see regime note) — **only listed when the working design has a `<firmware>` block** | sim-wasm |

### `render_schematic`

Returns a standalone SVG string built from the same schematic-graph the UI
consumes (`emitSchematicSvg`). It is a deterministic **topology** schematic
(component boxes ↔ net pills), not a pixel copy of the UI's interactive
ELK-placed canvas (that layout is async and browser-only). Same design in → same
SVG bytes out.

### `run_cosim` (regime honesty)

Co-simulation couples the firmware and analog domains by re-solving the analog
netlist per firmware I/O event (ADR 0011). The analog domain here is **real
ngspice**. Executing the MCU firmware to decide GPIO writes needs the MicroPython
WASM runtime (issue #37), which is **not yet available**. So `run_cosim` does not
invent firmware behaviour: it returns the resolved firmware pin bindings and the
real **t=0 analog priming solve**, and explicitly marks `firmware_steps_executed:
0`. When #37 lands it becomes the injected firmware model and the loop advances.

## End-to-end example: "validate this divider, then fix it"

A broken divider that references an undeclared net (the agent would call these
tools; shown here as tool calls):

1. `validate_design({ design_xml: "<system>…</system>" })` → diagnostics JSON
   with the error(s).
2. `preview_patch({ patch_xml: "<patch>…</patch>" })` → confirms the patch
   resolves the error without introducing new ones (`resolved` / `introduced`).
3. `propose_patch({ patch_xml: "<patch>…</patch>" })` → the patched design passes
   the gate and is adopted as the working design.
4. `run_simulation({})` → the report JSON; e.g. the corpus LiPo divider measures
   `battery_sense = 1.04211V` and the test **passes**.
5. `render_schematic({})` → an SVG of the corrected schematic.

For a design with a `<firmware>` block, `run_cosim({})` additionally reports the
ADC pin bindings and the real t=0 analog solve.
