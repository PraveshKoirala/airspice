/**
 * Component palette (issue #24 D3).
 *
 * A searchable list of the components in air-ts's compiled COMPONENT_SPECS
 * registry. Click-to-place inserts a fresh component at cursor position via
 * placeComponentPatch (see schematic/wiring.ts). Every placement flows
 * through the same runGate + setUserXml pipeline that Inspector/drag/wire
 * use, so undo/redo and validation are automatic.
 *
 * SEARCH is simple prefix + substring matching over the display name and
 * the internal type key. No fuse.js -- the registry has ~10 entries; a
 * fuzzy matcher would be net negative bundle size for the same feel.
 *
 * PLACEMENT POSITION: the palette does not know where the user's cursor
 * is; it receives a "cursor position provider" via the `getPlacementHint`
 * prop. The App wires that to the last-observed pointer position on the
 * SVG canvas. When no pointer position is available (initial page load),
 * placement falls back to a default coordinate at the canvas midpoint.
 */

import React, { useMemo, useState } from "react";
import { COMPONENT_SPECS, parse } from "air-ts";
import type { SystemIR } from "air-ts";
import { useDesignStore } from "../agent/designStore";
import { paletteEntries, placeComponentPatch, type PaletteEntry } from "./wiring";
import { commitPatch } from "./gate";
import type { GuiHint } from "./types";

interface PaletteProps {
  /**
   * Returns the current cursor `<gui>` hint for a fresh component. Called
   * once per placement (a click on a palette entry). When no cursor is
   * available, return null and the palette falls back to a default.
   */
  getPlacementHint: () => GuiHint | null;
  /** Fired after a successful placement so the app can log/report status. */
  onPlaced?: (compId: string, entry: PaletteEntry) => void;
  /** Fired on gate rejection so the app can surface the diagnostic. */
  onError?: (message: string) => void;
}

const DEFAULT_PLACEMENT: GuiHint = {
  componentId: "",
  x: 480,
  y: 320,
  rot: 0,
};

const Palette: React.FC<PaletteProps> = ({ getPlacementHint, onPlaced, onError }) => {
  const [query, setQuery] = useState("");
  const xml = useDesignStore((s) => s.xml);

  // Full palette from the compiled registry -- COMPONENT_SPECS is bundled
  // at build time (registry/data.generated.ts), so this is instant.
  const allEntries = useMemo<PaletteEntry[]>(
    () => paletteEntries(COMPONENT_SPECS),
    [],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allEntries;
    return allEntries.filter((entry) => {
      const name = entry.displayName.toLowerCase();
      const type = entry.type.toLowerCase();
      return (
        name.startsWith(q) ||
        type.startsWith(q) ||
        name.includes(q) ||
        type.includes(q)
      );
    });
  }, [allEntries, query]);

  const place = (entry: PaletteEntry) => {
    let parsed: SystemIR;
    try {
      parsed = parse(xml);
    } catch (err) {
      onError?.(`palette: parse failed: ${(err as Error).message}`);
      return;
    }
    const hintRaw = getPlacementHint() ?? DEFAULT_PLACEMENT;
    const hint: GuiHint = {
      componentId: "",
      x: hintRaw.x,
      y: hintRaw.y,
      rot: hintRaw.rot,
    };
    const { patchXml, newComponentId } = placeComponentPatch(parsed, entry, hint);
    const outcome = commitPatch(patchXml, "palette", `placed ${entry.type} as ${newComponentId}`);
    if (!outcome.ok) {
      onError?.(`palette: ${outcome.message}`);
      return;
    }
    onPlaced?.(newComponentId, entry);
  };

  return (
    <aside className="schematic-palette" data-testid="schematic-palette">
      <div className="palette-header">
        <span className="eyebrow">Palette</span>
      </div>
      <input
        className="palette-search"
        type="search"
        placeholder="Search components..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        data-testid="palette-search"
        spellCheck={false}
      />
      <ul className="palette-list" data-testid="palette-list">
        {filtered.length === 0 ? (
          <li className="palette-empty muted-copy">No matches.</li>
        ) : (
          filtered.map((entry) => (
            <li key={entry.type}>
              <button
                type="button"
                className="palette-item"
                onClick={() => place(entry)}
                data-testid={`palette-${entry.type}`}
                title={`${entry.displayName}: pins ${entry.requiredPins.join(", ")}`}
              >
                <strong>{entry.displayName}</strong>
                <span className="muted-copy">
                  {entry.type} - {entry.requiredPins.join(", ")}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
      <p className="muted-copy palette-hint">
        Click to place at cursor. Every placement flows through the same
        validation gate as an inspector edit.
      </p>
    </aside>
  );
};

export default Palette;
