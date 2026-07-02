# AI Native Spice

CLI-first v0.2 implementation of an AI-Native Intermediate Representation (AIR).

The canonical source artifact is `design.air.xml`. Generated artifacts are written
under `generated/` and can be recreated from the XML IR.

## Recent Updates (v0.2.6 "Native SchematicIR Renderer")

The schematic tab now uses a deterministic SchematicIR pass and native SVG rendering instead of drawing the AIR topology as a generic React Flow graph.

### Native SchematicIR Rendering
- **Motif-Aware Placement:** The renderer detects common motifs such as resistor dividers, shunt capacitors, regulator-to-MCU power paths, transistor switches, loads, sources, and sensors before placing components.
- **Shared Net Trunks:** Nets render as shared rail/trunk/branch structures rather than independent pin-to-net graph edges, reducing wire overlap.
- **Separate Power Rails:** Multiple power nets such as `bat` and `3v3` render on separate rail lanes instead of visually collapsing into one line.
- **Native SVG Symbols:** The active schematic view draws symbols and wires directly in SVG, avoiding the React Flow edge router for schematic layout.
- **Smaller Frontend Bundle:** Removing React Flow from the active schematic path reduced the production JS bundle size for this view.

## Previous Updates (v0.2.5 "Pin-Aware Schematic Renderer")

The active schematic view now renders AIR topology as a pin-aware circuit drawing instead of a generic component graph.

### Pin-Aware Schematic Rendering
- **Pin Metadata Graphs:** The `/graph` compiler now emits component values, SPICE model hints, pin lists, `sourceHandle` IDs, and per-edge pin/net metadata.
- **Circuit Symbols:** The React Flow schematic view draws recognizable resistor, capacitor, diode, voltage source, BJT, MOSFET, regulator, MCU, and generic IC symbols.
- **Real Pin Wiring:** Edges now land on actual component pin handles such as `Q1.B`, `Q1.C`, `Q1.E`, `U_REG.in`, and `U_MCU.GPIO4` instead of generic left/right box ports.
- **Circuit-Oriented Layout:** Power rails, ground symbols, signal junctions, transistor switches, loads, dividers, and MCU/control sections are laid out with schematic-style 90-degree routing.
- **Safer Renderer Strategy:** The active app avoids eager loading the heavier tscircuit runtime that previously broke frontend rendering.

## Previous Updates (v0.2.4 "AI Schema Guardrails")

The AI generation path now treats AIR XML as a strict contract instead of accepting generic circuit XML directly into the schematic.

### AI Schema Guardrails
- **AIR Normalizer:** Converts common generic circuit XML into AIR shape, including net-owned `<node component="..." pin="..."/>` connectivity, `<parameter>` values, lowercase BJT pins, missing net roles, and `<simulation_profile solver="...">`.
- **Validated AI Apply:** The UI sends generated XML through `/normalize-xml` before applying it to the editor/schematic. Invalid XML is rejected and diagnostics are shown instead.
- **Prompt Hardening:** The Gemini agent prompt explicitly requires component-owned `<pin name="..." net="..."/>`, `<value>...</value>`, net roles, AIR `<profile>` syntax, and BJT/MOSFET pin conventions.
- **BJT Simulation Models:** The SPICE compiler emits basic `NPN` and `PNP` models so generated transistor circuits have a model target.
- **Regression Coverage:** The test suite includes the dark-activated transistor lamp XML shape that previously rendered as components with no wires.

## Previous Updates (v0.2.3 "Waveform-Aware Schematic IDE")

The Simulation view now reads generated waveform CSVs and plots them directly in the UI, while the graph compiler is more tolerant of AI-generated XML that references nets before declaring them.

### Waveform Visualization
- **Waveform API:** Added `/waveforms` and `/waveforms/{name}` routes to list generated CSV traces and read them as structured time/value samples.
- **Simulation Charts:** The web Simulation panel now shows selectable SVG voltage/current traces after a simulation run.
- **Trace Artifacts:** Simulation reports now include generated waveform CSV paths alongside compiler artifacts.
- **Renderable AI Designs:** The schematic graph now creates implied net nodes for component pins that reference undeclared nets, preventing missing wires in generated designs.
- **Pin Alias Tolerance:** The parser accepts `pin net="..."`, `pin node="..."`, and `pin ref="..."` so common AI-generated pin forms still produce graph edges.

## Previous Updates (v0.2.2 "Schematic-First IDE")

The web workspace now opens on an electrical schematic canvas instead of a generic app layout. The goal is to make AIR XML feel like a circuit design surface while preserving the CLI/API as the deterministic source of truth.

### Schematic-First GUI
- **Circuit-Like Canvas:** React Flow renders components and nets as schematic symbols with power, signal, and ground styling.
- **Electrical Navigation:** The primary tab is now `Schematic`, with AIR XML, simulation, firmware, artifacts, validation, and repair as supporting views.
- **Full-Viewport IDE Shell:** The UI uses a dense three-pane engineering layout with a project rail, central workspace, and AI assistant.
- **Live XML-to-Graph Sync:** AIR XML edits refresh the schematic through the `/graph` API.
- **Core Regression Fixes:** CLI compatibility commands were restored (`patch`, `generate-template`, `explain`, `repair-context`), analog simulation reports expose `success`, and the ESP32 LDO examples include the stricter registry properties.

## Previous Updates (v0.2.1 "Reactive Agentic IDE")

The platform was upgraded with a deeply integrated AI-driven design experience and a reactive web workspace.

### Reactive Agentic IDE
- **Integrated AI Design Loop:** The AI Agent operates in two modes: `Building circuit...` for new designs and `Editing circuit...` for iterative changes. AI-suggested XML can be applied to the workspace in real time.
- **Reactive Workspace:** The `/graph` API enables synchronization between the XML editor and the schematic graph.
- **Explicit Signal Probing:** Native support for `<analog>` subsystems and `<probe>` tags. Users can ask the AI to monitor a net, and the simulation engine can generate waveform artifacts (`.csv`) for those signals.
- **Improved AI Tool-Use:** Enhanced system instructions and standardized pin conventions (`p/n`, `a/c`, `1/2`) improve first-pass design accuracy.
- **Error Surface Transparency:** API and validation issues are reported with detailed diagnostics in the chat panel.

### High-Fidelity Engine
- **Autonomous AI Repair:** Multi-step reasoning loop (`air autonomous-repair`) that iterates through Simulate -> Diagnose -> Repair until constraints pass.
- **Lockstep Co-Simulation:** Synchronized orchestration between ngspice and Renode using time-sliced analysis.
- **Universal MCU Generation:** Support for ESP32-C3, STM32F103, and others via data-driven JSON specs.

## Web UI

Located in `packages/ui`, providing a modern, reactive IDE experience.

### Features
- **Agentic AI REPL:** Interactive natural language interface with tool-use capabilities, auto-resizing input, and design application.
- **Schematic Canvas:** Circuit-like AIR XML visualization with custom component/net nodes via React Flow.
- **IDE Workspace:** Full-viewport workspace with Monaco XML Editor, Schematic, Simulation, Firmware, Artifacts, Validation, and Repair views.
- **Theme System:** Toggleable dark/light modes.

### Running the Environment
```powershell
# 1. Start the Backend API (Terminal 1)
$env:PYTHONPATH = "packages/core/src"
python -m air.cli serve --host 127.0.0.1 --port 8000

# 2. Start the Frontend (Terminal 2)
cd packages/ui
npm run dev
```

## Roadmap

- [x] **Autonomous AI Reasoning:** Iterative repair loop with mock/provider-backed agents.
- [x] **Reactive AI Design:** Real-time editor updates and "Building/Editing" modes.
- [x] **Explicit Probing:** AI-driven signal monitoring and waveform generation.
- [x] **Schematic-First GUI:** Circuit-like React Flow canvas and full IDE layout.
- [x] **Waveform Visualization:** Interactive time-series charts within the UI to view probed signals.
- [ ] **Thermal Analysis:** Power dissipation calculation and junction temperature validation.
- [ ] **Signal Integrity:** Trace capacitance estimation and timing checks for SPI/UART.
- [ ] **Visual Schematic Editing:** Drag-and-drop component placement and net drawing in the Web UI.
- [ ] **KiCad Exporter:** Generate `.kicad_sch` and `.kicad_pcb` files for physical realization.

---

### Next Agent Focus: **Interactive Schematic Editing**

The native SchematicIR renderer and waveform readback baseline are in place. The next phase should make the schematic editable: persist component positions into `<gui>`, support drag-to-place behavior, expose selected component/net details, and add guarded net editing that writes safe XML patches.

---

*Updated on Saturday, June 6, 2026 (Completion: 96/100)*
