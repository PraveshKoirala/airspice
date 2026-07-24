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

## Stateless by design

The server holds **no session state** — there is no server-side "current
design". Every tool takes the complete design as a required `design_xml`
argument (patch tools also require `patch_xml`); the calling agent owns the
document and passes it on each call. This is the right shape for a stdio server:
the browser agent's session tools (`get_design` / `set_design` / `read_waveform`)
have no meaning here and are not exposed.

## Firmware co-sim gating (`AIRSPICE_MCP_DESIGN`)

`run_cosim` is listed in `tools/list` **only** when the server was launched with
the env var `AIRSPICE_MCP_DESIGN` set to a path to an AIR XML file whose design
contains a `<firmware>` block. This is *launch-context* gating (read once at
startup), not runtime state. Without it, the six base tools are offered and
`run_cosim` is neither listed nor callable. To enable it:

```jsonc
{
  "mcpServers": {
    "airspice": {
      "command": "node",
      "args": ["packages/mcp-server/dist/cli.js"],
      "env": { "AIRSPICE_MCP_DESIGN": "/abs/path/to/a/firmware-design.air.xml" }
    }
  }
}
```

## Tools

| Tool | Arguments | Purpose | Engine |
| --- | --- | --- | --- |
| `validate_design` | `design_xml*` | Diagnostics (errors + warnings) JSON | air-ts |
| `simulate` | `design_xml*`, `profile?` | Run ngspice → report JSON (#14) | sim-wasm (ngspice) |
| `apply_patch` | `design_xml*`, `patch_xml*` | Gated patched design (`design_xml` out) | air-ts |
| `preview_patch` | `design_xml*`, `patch_xml*` | Op diff + before/after diagnostic deltas | air-ts |
| `render_schematic` | `design_xml*` | Deterministic, headless **SVG** string | air-ts |
| `get_registry` | `query?` | Component types + MCU parts (optional filter) | air-ts |
| `run_cosim` | `design_xml*` | Firmware ⇄ analog co-sim (gated; see below) | sim-wasm |

`*` = required. The **shared parameter sub-schemas** (`design_xml`, `patch_xml`)
are the byte-identical property objects from the browser agent's tool specs
(`AGENT_TOOLS`, issue #18), reused by reference — one source of truth. The tool
names and `required` arrays are the semantic stateless surface; the shared
property schemas are not re-declared.

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

A broken divider (the agent would call these tools; shown here as tool calls):

1. `validate_design({ design_xml: "<system>…</system>" })` → diagnostics JSON
   with the error(s).
2. `preview_patch({ design_xml, patch_xml: "<patch>…</patch>" })` → confirms the
   patch resolves the error without introducing new ones (`resolved` /
   `introduced`).
3. `apply_patch({ design_xml, patch_xml })` → the patched design passes the gate;
   the canonical patched `design_xml` is returned. Feed it into the next call.
4. `simulate({ design_xml: patchedXml })` → the report JSON; e.g. the corpus LiPo
   divider measures `battery_sense = 1.04211V` and the test **passes**.
5. `render_schematic({ design_xml: patchedXml })` → an SVG of the corrected
   schematic.

For a design with a `<firmware>` block (with the server launched under
`AIRSPICE_MCP_DESIGN`), `run_cosim({ design_xml })` reports the ADC pin bindings
and the real t=0 analog solve.
