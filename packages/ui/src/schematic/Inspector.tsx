/**
 * Inspector panel (issue #22 D).
 *
 * A right-side panel that shows properties of the currently selected
 * schematic entity and offers guarded, gated edits:
 *
 *   - Component selection: id, type, value, part; a list of pins with the
 *     nets they connect to. `id` and `value` are editable text inputs.
 *   - Net selection:       id, role, connected pins.
 *
 * WRITE PATH (issue #96 invariant): every edit is a `<patch>` document
 * (not a string mutation of the design XML), fed through the same
 * previewPatch/applyPatch/gateDesign pipeline the agent uses. When the
 * gate returns errors, the diagnostic renders INLINE next to the field
 * and the design store is UNCHANGED. When the gate passes, the canonical
 * normalized XML lands via `setUserXml` -- the human write path from
 * designStore.ts.
 *
 * The inspector consumes air-ts's patch engine directly on the main
 * thread (same pattern as engineHooks.ts). Round trips run in a few ms
 * on typical designs, well under the 300ms acceptance criterion.
 */

import React, { useMemo, useState } from "react";
import type { SystemIR } from "air-ts";
import { parse } from "air-ts";
import { useDesignStore } from "../agent/designStore";
import { useSchematicUI } from "./interaction";
import { commitPatch } from "./gate";
import type { GuiHint, SchematicIR } from "./types";
import {
  saveHintOp,
  saveHintPatch,
  replaceValuePatch,
  renameComponentPatch,
} from "./patches";
import { X } from "lucide-react";

const Inspector: React.FC<{ ir?: SchematicIR | null }> = ({ ir }) => {
  const selection = useSchematicUI((s) => s.selection);
  const clear = useSchematicUI((s) => s.clear);
  const xml = useDesignStore((s) => s.xml);

  // Parse the current design once per xml change; the inspector needs the
  // typed IR to render pin/net details. Failures are surfaced as an empty
  // panel + status message -- typing malformed XML mid-edit is expected.
  const parsed = useMemo<SystemIR | null>(() => {
    if (!xml.trim()) return null;
    try {
      return parse(xml);
    } catch {
      return null;
    }
  }, [xml]);

  const [editError, setEditError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  if (!selection) {
    return (
      <aside className="schematic-inspector empty" data-testid="inspector-empty">
        <div className="inspector-header">
          <span className="eyebrow">Inspector</span>
        </div>
        <p className="muted-copy">
          Click a component or wire to inspect. Press <kbd>Esc</kbd> to clear.
        </p>
      </aside>
    );
  }

  if (!parsed) {
    return (
      <aside className="schematic-inspector" data-testid="inspector-parse-failed">
        <div className="inspector-header">
          <span className="eyebrow">Inspector</span>
          <button className="icon-btn" onClick={clear} title="Clear selection">
            <X size={14} />
          </button>
        </div>
        <p className="diagnostic error">Design XML is not currently parseable.</p>
      </aside>
    );
  }

  // Dispatch: run either the component or net view. Both call runGate on
  // any commit and route through setUserXml so the Monaco editor + engine
  // pipeline (schematic + validation) refresh on the same XML update.
  const commit = (patchXml: string, note: string) => {
    setEditError(null);
    const t0 = performance.now();
    const outcome = commitPatch(patchXml, "inspector", note);
    if (!outcome.ok) {
      setEditError(outcome.message);
      setStatus(null);
      return;
    }
    const dt = Math.round(performance.now() - t0);
    setStatus(`${note} (${dt}ms)`);
  };

  if (selection.kind === "component") {
    const comp = parsed.components.get(selection.id);
    if (!comp) {
      return (
        <aside className="schematic-inspector" data-testid="inspector-missing">
          <div className="inspector-header">
            <span className="eyebrow">Inspector</span>
            <button className="icon-btn" onClick={clear} title="Clear selection">
              <X size={14} />
            </button>
          </div>
          <p className="muted-copy">
            Component <code>{selection.id}</code> not found in current XML.
          </p>
        </aside>
      );
    }

    const onCommitId = (newId: string) => {
      if (newId === comp.id) return;
      if (!newId) {
        setEditError("id: cannot be empty");
        return;
      }
      // A duplicate id is caught by validation, but detect it here so we can
      // fail fast with a clearer message than the raw diagnostic.
      if (parsed.components.has(newId)) {
        setEditError(`id: ${newId} already exists`);
        return;
      }
      // Rewrite the component's id attribute with a targeted <replace>.
      // Doing so ALSO requires updating every <pin ref="OLDID"> elsewhere,
      // which is out of scope for #22 -- pins index nets by net id, not
      // component id, so no cross-reference update is needed today.
      const patch = renameComponentPatch(comp, newId);
      commit(patch, `renamed to ${newId}`);
    };

    const onCommitValue = (newValue: string) => {
      const currentValue = comp.value ?? "";
      if (newValue === currentValue) return;
      const patch = replaceValuePatch(comp.id, newValue);
      commit(patch, `${comp.id}.value = ${newValue || "(cleared)"}`);
    };

    const saveLayoutFromIR = () => {
      if (!ir) {
        setEditError("Layout not ready yet");
        return;
      }
      const placed = ir.components.find((c) => c.id === comp.id);
      if (!placed) {
        setEditError(`No placement for ${comp.id}`);
        return;
      }
      const hint: GuiHint = {
        componentId: comp.id,
        x: placed.x,
        y: placed.y,
        rot: comp.gui?.rot ?? 0,
      };
      commit(saveHintPatch(comp, hint), `Saved <gui> hint for ${comp.id}`);
    };

    const saveAllHints = () => {
      if (!ir) {
        setEditError("Layout not ready yet");
        return;
      }
      // Batch: one <patch> with one op per component that lacks a hint.
      const ops: string[] = [];
      for (const placed of ir.components) {
        const cur = parsed.components.get(placed.id);
        if (!cur) continue;
        const hint: GuiHint = {
          componentId: placed.id,
          x: placed.x,
          y: placed.y,
          rot: cur.gui?.rot ?? 0,
        };
        ops.push(saveHintOp(cur, hint));
      }
      const patch = `<patch>${ops.join("")}</patch>`;
      commit(patch, `Saved <gui> hints for ${ops.length} components`);
    };

    return (
      <aside className="schematic-inspector" data-testid="inspector-component">
        <div className="inspector-header">
          <span className="eyebrow">Component</span>
          <button className="icon-btn" onClick={clear} title="Clear selection">
            <X size={14} />
          </button>
        </div>
        <div className="inspector-body">
          <EditableRow
            label="id"
            initial={comp.id}
            onCommit={onCommitId}
            testId="inspector-id"
          />
          <ReadonlyRow label="type" value={comp.type} />
          {comp.part ? <ReadonlyRow label="part" value={comp.part} /> : null}
          <EditableRow
            label="value"
            initial={comp.value ?? ""}
            onCommit={onCommitValue}
            testId="inspector-value"
          />
          {comp.gui ? (
            <ReadonlyRow
              label="gui"
              value={`x=${comp.gui.x} y=${comp.gui.y} rot=${comp.gui.rot}`}
            />
          ) : null}
          <div className="inspector-section-title">Pins</div>
          <table className="inspector-pins" data-testid="inspector-pins">
            <thead>
              <tr>
                <th>name</th>
                <th>net</th>
              </tr>
            </thead>
            <tbody>
              {[...comp.pins.values()].map((pin) => (
                <tr key={pin.name}>
                  <td>
                    <code>{pin.name}</code>
                  </td>
                  <td>
                    <code>{pin.net}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="inspector-actions">
            <button
              onClick={saveLayoutFromIR}
              data-testid="inspector-save-layout"
              title="Persist the current auto-layout as <gui> hints on this component"
            >
              Save layout for {comp.id}
            </button>
            <button
              onClick={saveAllHints}
              data-testid="inspector-save-all-layouts"
              title="Persist current auto-layout for every un-hinted component"
            >
              Save layout for all
            </button>
          </div>
          {editError ? (
            <div className="diagnostic error" data-testid="inspector-error">
              {editError}
            </div>
          ) : null}
          {status ? (
            <div className="diagnostic success" data-testid="inspector-status">
              {status}
            </div>
          ) : null}
        </div>
      </aside>
    );
  }

  // Net selection view.
  const netId = selection.id;
  const net = parsed.nets.get(netId);
  const connected: Array<{ component: string; pin: string }> = [];
  for (const c of parsed.components.values()) {
    for (const pin of c.pins.values()) {
      if (pin.net === netId) connected.push({ component: c.id, pin: pin.name });
    }
  }
  return (
    <aside className="schematic-inspector" data-testid="inspector-net">
      <div className="inspector-header">
        <span className="eyebrow">Net</span>
        <button className="icon-btn" onClick={clear} title="Clear selection">
          <X size={14} />
        </button>
      </div>
      <div className="inspector-body">
        <ReadonlyRow label="id" value={netId} />
        <ReadonlyRow label="role" value={net?.role ?? "(implicit)"} />
        {net?.nominal_voltage ? (
          <ReadonlyRow label="nominal" value={net.nominal_voltage} />
        ) : null}
        <div className="inspector-section-title">
          Connected pins ({connected.length})
        </div>
        <table className="inspector-pins" data-testid="inspector-net-pins">
          <thead>
            <tr>
              <th>component</th>
              <th>pin</th>
            </tr>
          </thead>
          <tbody>
            {connected.map((entry) => (
              <tr key={`${entry.component}:${entry.pin}`}>
                <td>
                  <code>{entry.component}</code>
                </td>
                <td>
                  <code>{entry.pin}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </aside>
  );
};

interface EditableRowProps {
  label: string;
  initial: string;
  onCommit: (value: string) => void;
  testId?: string;
}

const EditableRow: React.FC<EditableRowProps> = ({ label, initial, onCommit, testId }) => {
  const [value, setValue] = useState(initial);
  // Keep the local buffer in sync when the design changes underneath us
  // (e.g. Monaco edit, agent apply). We only reset when the incoming
  // `initial` differs from what the user has typed since last commit.
  const [lastCommitted, setLastCommitted] = useState(initial);
  if (initial !== lastCommitted && value === lastCommitted) {
    // The design was updated from outside; adopt the new value.
    setValue(initial);
    setLastCommitted(initial);
  }
  const commit = () => {
    if (value === lastCommitted) return;
    setLastCommitted(value);
    onCommit(value);
  };
  return (
    <div className="inspector-row">
      <label>{label}</label>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setValue(lastCommitted);
            (e.target as HTMLInputElement).blur();
          }
        }}
        data-testid={testId}
        spellCheck={false}
      />
    </div>
  );
};

const ReadonlyRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="inspector-row readonly">
    <label>{label}</label>
    <code>{value}</code>
  </div>
);

export default Inspector;
