/**
 * SPICE netlist importer for air-ts (Milestone M7, issue #33).
 *
 * Parses a standard SPICE deck (.cir / .net / .sp) into canonical AIR XML that
 * PARSES, VALIDATES clean, and SIMULATES through the same air-ts pipeline the
 * rest of the engine uses. This is deliberately not a token-matching stub:
 *
 *  - Physical-line reassembly: SPICE `+` continuation lines are folded onto the
 *    logical line before parsing.
 *  - Comments: full-line `*` and inline `;` / `$` are stripped (ngspice rules).
 *  - Title line: per SPICE convention the first non-blank line is the deck TITLE
 *    (ignored by the solver). Honored by default; opt out for fragments.
 *  - `.model` cards are read so a transistor/diode's model *type* (npn/pnp/
 *    nmos/pmos/d) is known, and we map it onto air-ts's BUILTIN SPICE models
 *    (NPN/PNP/NMOS/PMOS/D). We NEVER emit a `spice_model` naming a part number:
 *    the validator rejects a modelled type whose model is not a builtin
 *    (UNDEFINED_SPICE_MODEL), so a bare 2N2222/BSS138/1N4148 maps to the generic
 *    builtin (spice_model omitted) and simulates. See registry BUILTIN_SPICE_MODELS.
 *  - `.subckt`/`.ends` bodies are skipped (their `X` instances have no builtin
 *    definition and would fail validation) and RECORDED in `dropped` — nothing
 *    is dropped silently.
 *
 * Device coverage: R, C, D, Q (BJT), M (MOSFET), V, I. Unsupported constructs
 * (L — no air-ts inductor primitive; X subckt instances; E/F/G/H/B/S/W/K/T…;
 * unparseable lines) are collected in `dropped` with a human reason.
 *
 * Pin mapping follows the registry required-pin names exactly:
 *   resistor/capacitor 1,2 · voltage_source/current_source p,n ·
 *   diode a,c · bjt C,B,E · mosfet G,D,S.
 */

export interface ParsedSpiceComponent {
  id: string;
  type: string;
  value: string | null;
  spiceModel: string | null;
  pins: Array<{ name: string; net: string }>;
}

/** A line the importer could not represent as a supported AIR component. */
export interface DroppedLine {
  line: string;
  reason: string;
}

export interface SpiceImportResult {
  /** Canonical AIR XML (parses + validates clean + simulates). */
  airXml: string;
  /** The components that were imported. */
  components: ParsedSpiceComponent[];
  /** Distinct nets referenced, with the role the importer inferred. */
  nets: Array<{ id: string; role: string }>;
  /** `.model NAME -> type` cards discovered (type lower-cased, e.g. "pnp"). */
  models: Record<string, string>;
  /** Lines the importer could NOT import, each with a reason (never silent). */
  dropped: DroppedLine[];
}

export interface SpiceImportOptions {
  /**
   * Treat the first non-blank line as the SPICE title (ignored). Default true,
   * matching ngspice deck semantics. Set false when importing a bare fragment
   * whose first line is already a device.
   */
  firstLineIsTitle?: boolean;
  /** Title written into the AIR <metadata>. Default derived from the deck title. */
  title?: string;
}

const GROUND_NODES = new Set(["0", "gnd", "ground", "vss", "agnd", "dgnd"]);
const POWER_NODE_RE =
  /^(vcc|vdd|vdda|vddio|vin|vbat|vbus|vout|vref|vpp|vee|vs|v\+|\+?\d+v\d*|\d+v3?)$/;

const QUANTITY_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[a-zA-Z%]*$/;

function isQuantity(tok: string): boolean {
  return QUANTITY_RE.test(tok);
}

function netRole(node: string): string {
  if (GROUND_NODES.has(node)) return "ground";
  if (POWER_NODE_RE.test(node)) return "power";
  return "signal";
}

function xmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Strip a full-line `*` comment and any inline `;`/`$` trailing comment. */
function stripComment(line: string): string {
  const semi = line.indexOf(";");
  const dollar = line.indexOf("$");
  let cut = -1;
  if (semi >= 0) cut = semi;
  if (dollar >= 0 && (cut < 0 || dollar < cut)) cut = dollar;
  return cut >= 0 ? line.slice(0, cut) : line;
}

/** Fold `+` continuation lines onto the preceding logical line. */
function logicalLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("+")) {
      const cont = trimmed.slice(1).trim();
      if (out.length > 0) out[out.length - 1] = `${out[out.length - 1]} ${cont}`;
      else out.push(cont);
    } else {
      out.push(raw);
    }
  }
  return out;
}

/** Extract a single DC value from a source line's post-node tokens. */
function sourceValue(tokens: string[]): string | null {
  // tokens are everything after the two node names.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.toUpperCase() === "DC" && i + 1 < tokens.length) return tokens[i + 1]!;
  }
  // No explicit DC keyword: first bare quantity that is not an AC/transient tag.
  for (const t of tokens) {
    const up = t.toUpperCase();
    if (up === "AC" || up.startsWith("PULSE") || up.startsWith("SIN") || up.startsWith("PWL") || up.startsWith("EXP"))
      break;
    if (isQuantity(t)) return t;
  }
  return null;
}

/**
 * Import a SPICE netlist into AIR. Returns the AIR XML plus a full accounting of
 * what was imported and what was dropped (and why).
 */
export function importSpiceNetlist(
  netlistText: string,
  options: SpiceImportOptions = {},
): SpiceImportResult {
  const firstLineIsTitle = options.firstLineIsTitle ?? true;
  const components: ParsedSpiceComponent[] = [];
  const dropped: DroppedLine[] = [];
  const models: Record<string, string> = {};
  const nets = new Map<string, string>(); // id -> role
  const usedIds = new Set<string>();

  const addNet = (raw: string): string => {
    const id = raw.toLowerCase();
    if (!nets.has(id)) nets.set(id, netRole(id));
    return id;
  };

  const lines = logicalLines(netlistText);

  // Pre-pass: SPICE `.model` cards are order-independent and may appear AFTER
  // the devices that reference them, so gather all top-level ones first.
  {
    let preDepth = 0;
    let preFirst = false;
    for (const rawLine of lines) {
      const line = stripComment(rawLine).trim();
      if (!line) continue;
      if (!preFirst) {
        preFirst = true;
        if (firstLineIsTitle && !line.startsWith(".")) continue;
      }
      if (line.startsWith("*") || !line.startsWith(".")) continue;
      const p = line.split(/\s+/);
      const dir = p[0]!.toLowerCase();
      if (dir === ".subckt") preDepth++;
      else if (dir === ".ends") {
        if (preDepth > 0) preDepth--;
      } else if (dir === ".model" && preDepth === 0 && p.length >= 3) {
        models[p[1]!.toLowerCase()] = p[2]!.split("(")[0]!.toLowerCase();
      }
    }
  }

  let seenFirstContent = false;
  let deckTitle = "";
  let subcktDepth = 0;

  for (const rawLine of lines) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    // First non-blank line = deck title (ngspice convention).
    if (!seenFirstContent) {
      seenFirstContent = true;
      if (firstLineIsTitle && !line.startsWith(".")) {
        deckTitle = line.replace(/^\*+/, "").trim();
        continue;
      }
    }
    if (line.startsWith("*")) continue; // full-line comment

    // Directives (`.model` already gathered in the pre-pass).
    if (line.startsWith(".")) {
      const parts = line.split(/\s+/);
      const dir = parts[0]!.toLowerCase();
      if (dir === ".subckt") {
        subcktDepth++;
        dropped.push({ line, reason: ".subckt definitions have no builtin AIR equivalent (skipped)" });
      } else if (dir === ".ends" || dir === ".end") {
        if (subcktDepth > 0) subcktDepth--;
      }
      // other directives (.tran/.dc/.options/.include/…) are analysis-level; ignore.
      continue;
    }

    // Skip everything inside a .subckt body.
    if (subcktDepth > 0) continue;

    const parts = line.split(/\s+/);
    const name = parts[0]!;
    const prefix = name.charAt(0).toUpperCase();

    const uniqueId = (id: string): string => {
      let candidate = id;
      let n = 2;
      while (usedIds.has(candidate)) candidate = `${id}_${n++}`;
      usedIds.add(candidate);
      return candidate;
    };

    switch (prefix) {
      case "R":
      case "C": {
        if (parts.length < 4 || !isQuantity(parts[3]!)) {
          dropped.push({ line, reason: `${prefix === "R" ? "resistor" : "capacitor"} needs 2 nodes and a value` });
          break;
        }
        const n1 = addNet(parts[1]!);
        const n2 = addNet(parts[2]!);
        components.push({
          id: uniqueId(name),
          type: prefix === "R" ? "resistor" : "capacitor",
          value: parts[3]!,
          spiceModel: null,
          pins: [{ name: "1", net: n1 }, { name: "2", net: n2 }],
        });
        break;
      }
      case "V":
      case "I": {
        if (parts.length < 4) {
          dropped.push({ line, reason: `${prefix === "V" ? "voltage" : "current"} source needs 2 nodes and a value` });
          break;
        }
        const n1 = addNet(parts[1]!);
        const n2 = addNet(parts[2]!);
        const val = sourceValue(parts.slice(3));
        if (val === null) {
          dropped.push({ line, reason: "could not extract a DC value (AC/PULSE/SIN/PWL sources not supported)" });
          break;
        }
        components.push({
          id: uniqueId(name),
          type: prefix === "V" ? "voltage_source" : "current_source",
          value: val,
          spiceModel: null,
          pins: [{ name: "p", net: n1 }, { name: "n", net: n2 }],
        });
        break;
      }
      case "D": {
        if (parts.length < 3) {
          dropped.push({ line, reason: "diode needs 2 nodes" });
          break;
        }
        const a = addNet(parts[1]!);
        const c = addNet(parts[2]!);
        components.push({
          id: uniqueId(name),
          type: "diode",
          value: null,
          spiceModel: null, // generic builtin D
          pins: [{ name: "a", net: a }, { name: "c", net: c }],
        });
        break;
      }
      case "Q": {
        // Qname nc nb ne [ns] model  (assume 3-terminal: collector base emitter)
        if (parts.length < 5) {
          dropped.push({ line, reason: "BJT needs 3 nodes and a model" });
          break;
        }
        const nc = addNet(parts[1]!);
        const nb = addNet(parts[2]!);
        const ne = addNet(parts[3]!);
        const modelName = parts[4]!.toLowerCase();
        const kind = models[modelName];
        const spiceModel = kind === "pnp" ? "PNP" : null; // else generic NPN
        components.push({
          id: uniqueId(name),
          type: "bjt",
          value: null,
          spiceModel,
          pins: [{ name: "C", net: nc }, { name: "B", net: nb }, { name: "E", net: ne }],
        });
        break;
      }
      case "M": {
        // Mname nd ng ns nb model …  -> D G S (bulk folded to source by the compiler)
        if (parts.length < 6) {
          dropped.push({ line, reason: "MOSFET needs 4 nodes and a model" });
          break;
        }
        const nd = addNet(parts[1]!);
        const ng = addNet(parts[2]!);
        const ns = addNet(parts[3]!);
        const modelName = parts[5]!.toLowerCase();
        const kind = models[modelName];
        const spiceModel = kind === "pmos" ? "PMOS" : null; // else generic NMOS
        components.push({
          id: uniqueId(name),
          type: "mosfet",
          value: null,
          spiceModel,
          pins: [{ name: "G", net: ng }, { name: "D", net: nd }, { name: "S", net: ns }],
        });
        break;
      }
      case "L":
        dropped.push({ line, reason: "no inductor primitive in the air-ts registry" });
        break;
      case "X":
        dropped.push({ line, reason: "subcircuit instance references a .subckt with no builtin definition" });
        break;
      default:
        dropped.push({ line, reason: `unsupported SPICE device prefix '${prefix}'` });
        break;
    }
  }

  const netList = [...nets.entries()]
    .map(([id, role]) => ({ id, role }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const title = options.title ?? (deckTitle || "Imported SPICE Design");
  const airXml = renderAirXml(title, netList, components);

  return { airXml, components, nets: netList, models, dropped };
}

function renderAirXml(
  title: string,
  nets: Array<{ id: string; role: string }>,
  components: ParsedSpiceComponent[],
): string {
  const out: string[] = [];
  out.push('<system name="imported_design" ir_version="0.1">');
  out.push("  <metadata>");
  out.push(`    <title>${xmlText(title)}</title>`);
  out.push("    <description>Imported from a SPICE netlist by air-ts (M7).</description>");
  out.push("  </metadata>");

  out.push("  <nets>");
  for (const net of nets) {
    out.push(`    <net id="${xmlAttr(net.id)}" role="${net.role}"/>`);
  }
  out.push("  </nets>");

  out.push("  <components>");
  for (const c of components) {
    const modelAttr = c.spiceModel ? ` spice_model="${xmlAttr(c.spiceModel)}"` : "";
    out.push(`    <component id="${xmlAttr(c.id)}" type="${c.type}"${modelAttr}>`);
    if (c.value !== null) out.push(`      <value>${xmlText(c.value)}</value>`);
    for (const p of c.pins) {
      out.push(`      <pin name="${xmlAttr(p.name)}" net="${xmlAttr(p.net)}"/>`);
    }
    out.push("    </component>");
  }
  out.push("  </components>");

  // A minimal operating-point test + default ngspice profile so the imported
  // design is simulatable end-to-end, not just parseable.
  out.push("  <tests>");
  out.push('    <test id="imported">');
  out.push('      <run duration="1ms"/>');
  out.push("    </test>");
  out.push("  </tests>");
  out.push("  <simulation_profiles>");
  out.push('    <profile id="default">');
  out.push('      <backend type="ngspice"/>');
  out.push('      <run test="imported"/>');
  out.push("    </profile>");
  out.push("  </simulation_profiles>");

  out.push("</system>");
  return out.join("\n") + "\n";
}

/**
 * Convenience wrapper preserving the original string-returning signature: parse
 * a SPICE netlist and return only the AIR XML. Callers that need the dropped-line
 * accounting should use {@link importSpiceNetlist}.
 */
export function parseSpiceNetlistToAirXml(
  netlistText: string,
  options: SpiceImportOptions = {},
): string {
  return importSpiceNetlist(netlistText, options).airXml;
}
