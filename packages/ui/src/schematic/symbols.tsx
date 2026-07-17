/**
 * SVG symbol renderers (issue #22 refactor).
 *
 * Extracted verbatim from the pre-refactor Graph.tsx. Each function draws
 * exactly the same path data at exactly the same offsets it did before --
 * this is a package split, not a redesign. The `<ComponentSvg>` dispatcher
 * picks the right renderer by component type and paints ref/value labels,
 * pin dots, and pin-name text.
 *
 * These renderers are stateless and reused by Renderer.tsx; selection
 * highlighting is applied through the outer `<g>` className, so nothing
 * here needs to know about the schematic store.
 */

import React from "react";
import type { PinPoint, SchematicComponent } from "./types";
import { pinOffset, pinPoint } from "./layout";

export function ResistorSvg({ c }: { c: SchematicComponent }) {
  const vertical = c.orientation === "vertical";
  return (
    <g transform={`translate(${c.x} ${c.y}) ${vertical ? "rotate(90)" : ""}`}>
      <path className="symbol-line" d="M-76 0H-46l8-14 16 28 16-28 16 28 16-28 16 28 8-14H76" />
    </g>
  );
}

export function CapacitorSvg({ c }: { c: SchematicComponent }) {
  const vertical = c.orientation === "vertical";
  return (
    <g transform={`translate(${c.x} ${c.y}) ${vertical ? "rotate(90)" : ""}`}>
      <path className="symbol-line" d="M-76 0H-8M-8 -24V24M8 -24V24M8 0H76" />
    </g>
  );
}

export function SourceSvg({ c }: { c: SchematicComponent }) {
  return (
    <g transform={`translate(${c.x} ${c.y})`}>
      <circle className="source-body" cx="0" cy="0" r="42" />
      <path className="symbol-line" d="M0 -74v32M0 42v32M-13 -14h26M0 -27V0M-13 21h26" />
    </g>
  );
}

export function DiodeSvg({ c }: { c: SchematicComponent }) {
  const vertical = c.orientation === "vertical";
  return (
    <g transform={`translate(${c.x} ${c.y}) ${vertical ? "rotate(90)" : ""}`}>
      <path className="symbol-line" d="M-76 0h42M-34 -22l48 22-48 22zM14 -22v44M14 0h62" />
    </g>
  );
}

export function BjtSvg({ c }: { c: SchematicComponent }) {
  const isPnp = c.spiceModel.toUpperCase() === "PNP";
  return (
    <g transform={`translate(${c.x} ${c.y})`}>
      <circle className="symbol-shell" cx="20" cy="0" r="54" />
      <path className="symbol-line" d="M-10 -40v80M-58 0h48M-10 0l48 -58M-10 0l48 58M38 -58v-28M38 58v28" />
      {isPnp ? <path className="symbol-fill" d="M10 -10l23 -1 -13 -18z" /> : <path className="symbol-fill" d="M50 40l16 18 -25 -4z" />}
    </g>
  );
}

export function MosfetSvg({ c }: { c: SchematicComponent }) {
  return (
    <g transform={`translate(${c.x} ${c.y})`}>
      <path className="symbol-line" d="M-26 -48v96M-8 -44v24M-8 -12v24M-8 20v24M-62 0h36M-8 -32h46v-54M-8 32h46v54M16 0h22" />
      <path className="symbol-fill" d="M18 -9l26 9-26 9z" />
    </g>
  );
}

export function IcSvg({ c }: { c: SchematicComponent }) {
  const label = c.type === "mcu" ? "MCU" : c.type.toUpperCase();
  const BL = -74,
    BR = 74,
    BT = -64,
    BB = 64;
  return (
    <g transform={`translate(${c.x} ${c.y})`}>
      <rect className="ic-body" x={BL} y={BT} width={BR - BL} height={BB - BT} rx="4" />
      {c.pins.map((pin) => {
        const off = pinOffset(c.type, c.orientation, c.pins, pin);
        let ex: number, ey: number;
        if (off.x <= BL) {
          ex = BL;
          ey = off.y;
        } else if (off.x >= BR) {
          ex = BR;
          ey = off.y;
        } else if (off.y <= BT) {
          ex = off.x;
          ey = BT;
        } else if (off.y >= BB) {
          ex = off.x;
          ey = BB;
        } else return null;
        return <path key={pin.name} className="ic-pin" d={`M${ex} ${ey}L${off.x} ${off.y}`} />;
      })}
      {/* Pin names just inside the body edge nearest each pin -- the way a
          real IC symbol is annotated. */}
      {c.pins.map((pin) => {
        const off = pinOffset(c.type, c.orientation, c.pins, pin);
        let tx: number, ty: number, anchor: "start" | "middle" | "end";
        if (off.x <= BL) {
          tx = BL + 7;
          ty = off.y + 3.5;
          anchor = "start";
        } else if (off.x >= BR) {
          tx = BR - 7;
          ty = off.y + 3.5;
          anchor = "end";
        } else if (off.y <= BT) {
          tx = off.x;
          ty = BT + 13;
          anchor = "middle";
        } else if (off.y >= BB) {
          tx = off.x;
          ty = BB - 7;
          anchor = "middle";
        } else return null;
        return (
          <text key={`pn:${pin.name}`} className="ic-pin-name" x={tx} y={ty} textAnchor={anchor}>
            {pin.name}
          </text>
        );
      })}
      <text className="ic-name" x="0" y="-6">
        {label}
      </text>
      {c.part && (
        <text className="ic-part" x="0" y="14">
          {c.part}
        </text>
      )}
    </g>
  );
}

/**
 * The full component symbol (body + ref/value labels + pin markers).
 *
 * `onSelect` is optional so the pure refactor commit stays behavior-neutral:
 * when it is `undefined`, no click handler is attached and the group renders
 * exactly as it did in the monolith. Selection wiring lands in commit C via
 * a wrapping `<g>` with a click-through onClick.
 *
 * `selected` toggles the `.selected` class, and `highlightedNets` (a Set of
 * net ids) toggles a per-pin dot class so the connected pins are visually
 * called out when a net-highlight is active. Both default to no-op values.
 */
export function ComponentSvg({
  component,
  selected = false,
  highlightedNets,
  onSelect,
  onPointerDown,
  onPinPointerDown,
}: {
  component: SchematicComponent;
  selected?: boolean;
  highlightedNets?: Set<string>;
  /**
   * Click handler. `shift` is true when the user held Shift -- used by the
   * multi-select flow to toggle instead of replace (issue #23).
   */
  onSelect?: (shift: boolean) => void;
  /**
   * Pointer-down handler that starts a drag on this component (issue #23).
   * When present the outer `<g>` becomes the pointer target so the
   * Renderer's SVG-level pointer-capture takes effect on this element.
   */
  onPointerDown?: (event: React.PointerEvent<SVGGElement>) => void;
  /**
   * Pointer-down handler on an INDIVIDUAL PIN marker (issue #24 wiring).
   * When present, a pointer-down on the pin's hitbox begins a wire-draw
   * gesture rather than a component drag. The Renderer wires this to its
   * wiring state machine. Called with the pin's owning component id + pin
   * name so the caller doesn't need to reverse-look it up.
   */
  onPinPointerDown?: (
    compId: string,
    pinName: string,
    event: React.PointerEvent<SVGCircleElement>,
  ) => void;
}) {
  const c = component;
  let symbol: React.ReactNode;
  if (c.type === "resistor" || c.type === "generic_load") symbol = <ResistorSvg c={c} />;
  else if (c.type === "capacitor") symbol = <CapacitorSvg c={c} />;
  else if (c.type === "diode") symbol = <DiodeSvg c={c} />;
  else if (c.type === "voltage_source" || c.type === "current_source" || c.type === "battery") symbol = <SourceSvg c={c} />;
  else if (c.type === "bjt") symbol = <BjtSvg c={c} />;
  else if (c.type === "mosfet") symbol = <MosfetSvg c={c} />;
  else symbol = <IcSvg c={c} />;

  const isPassive = ["resistor", "capacitor", "diode", "generic_load"].includes(c.type);
  const isSource = ["voltage_source", "current_source", "battery"].includes(c.type);
  const isTransistor = c.type === "bjt" || c.type === "mosfet";
  const isIc = !isPassive && !isSource && !isTransistor;
  const isVerticalPassive = isPassive && c.orientation === "vertical";
  const labelRight = isVerticalPassive && c.labelSide === "right";

  // Ref/value placement: side labels for vertical passives, left of the
  // circle for sources, above the body for ICs, below for transistors.
  let labelX: number;
  let labelY: number;
  if (isVerticalPassive) {
    labelX = c.x + (labelRight ? 62 : -62);
    labelY = c.y - 2;
  } else if (isSource) {
    labelX = c.x - 56;
    labelY = c.y - 4;
  } else if (isTransistor) {
    labelX = c.x + 26;
    labelY = c.y + 122;
  } else if (isIc) {
    labelX = c.x;
    labelY = c.y - 86;
  } else {
    // horizontal passive: below the symbol
    labelX = c.x;
    labelY = c.y + 34;
  }
  // ICs print their part number inside the body (IcSvg), so only an
  // explicit value is repeated outside.
  const value = c.value || (isIc || c.type === "mcu" ? "" : c.part);
  const showPinText = isTransistor;
  // Side labels anchor away from the symbol: end (grows left) on the left, start (grows right) on the right.
  const sideAnchor = labelRight ? "start" : isVerticalPassive || isSource ? "end" : undefined;
  // Selection highlight is a class on the outer group; base rendering is
  // unchanged so the byte-parity refactor holds when nothing is selected.
  const groupClass = `schematic-component ${c.type}${selected ? " selected" : ""}`;
  const groupProps: React.SVGProps<SVGGElement> = { className: groupClass };
  if (onSelect) {
    groupProps.onClick = (event) => {
      event.stopPropagation();
      onSelect(event.shiftKey);
    };
    groupProps.style = { cursor: onPointerDown ? "grab" : "pointer" };
  }
  if (onPointerDown) {
    groupProps.onPointerDown = onPointerDown;
  }

  // Transparent hit area over the symbol core so clicking "the resistor"
  // works anywhere on the body, not only on the thin zigzag stroke. ICs
  // don't need one -- their body rect is a solid fill already. Kept to the
  // CORE (not the leads) so it never sits on top of a passing wire's
  // click hitbox.
  let hitBox: { x: number; y: number; w: number; h: number } | null = null;
  if (isPassive) {
    const core = c.type === "capacitor" ? 26 : c.type === "diode" ? 32 : 50;
    const across = 20;
    hitBox =
      c.orientation === "vertical"
        ? { x: -across, y: -core, w: across * 2, h: core * 2 }
        : { x: -core, y: -across, w: core * 2, h: across * 2 };
  } else if (isSource) {
    hitBox = { x: -44, y: -44, w: 88, h: 88 };
  } else if (isTransistor) {
    hitBox = { x: -36, y: -58, w: 112, h: 116 };
  }

  return (
    <g {...groupProps} data-component-id={c.id}>
      {hitBox && (
        <rect
          className="symbol-hit"
          x={c.x + hitBox.x}
          y={c.y + hitBox.y}
          width={hitBox.w}
          height={hitBox.h}
          fill="transparent"
          pointerEvents="all"
        />
      )}
      {symbol}
      <text
        className={`component-ref ${isVerticalPassive ? "side-label" : ""}`}
        x={labelX}
        y={labelY}
        style={sideAnchor ? { textAnchor: sideAnchor } : undefined}
      >
        {c.id}
      </text>
      {value && (
        <text
          className={`component-value ${isVerticalPassive ? "side-label" : ""}`}
          x={labelX}
          y={labelY + 16}
          style={sideAnchor ? { textAnchor: sideAnchor } : undefined}
        >
          {value}
        </text>
      )}
      {c.pins.map((pin) => {
        const point: PinPoint = pinPoint(c, pin);
        const highlighted = highlightedNets?.has(pin.net) ?? false;
        return (
          <g
            key={`${c.id}:${pin.name}`}
            className={`pin-marker${highlighted ? " on-highlighted-net" : ""}`}
            data-pin-comp={c.id}
            data-pin-name={pin.name}
            data-pin-net={pin.net}
            data-pin-x={point.x}
            data-pin-y={point.y}
          >
            <title>{pin.name}</title>
            {/*
             * Wider transparent circle receives pointer events so tapping
             * near the pin (not exactly on the 3px dot) still initiates a
             * wire-draw. The visible dot on top stays 3px. Both live under
             * the same group so highlight/selection classes apply uniformly.
             * Wiring hit target only exists when onPinPointerDown is wired
             * (interactive mode); parity commit renders no hitbox.
             */}
            <circle className="pin-dot" cx={point.x} cy={point.y} r="3" />
            {/* The hitbox is painted last so a press at the exact pin
                centre hits it (not the visible dot) and starts a wire. */}
            {onPinPointerDown ? (
              <circle
                className="pin-hitbox"
                cx={point.x}
                cy={point.y}
                r="10"
                fill="transparent"
                pointerEvents="all"
                data-testid={`pin-hit-${c.id}-${pin.name}`}
                onPointerDown={(event) => onPinPointerDown(c.id, pin.name, event)}
              />
            ) : null}
            {showPinText && (
              <text x={point.x + 5} y={point.y - 5}>
                {pin.name}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}
