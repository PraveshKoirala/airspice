import { memo } from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import { Cpu } from 'lucide-react';

type Pin = {
  name: string;
  net: string;
  function?: string;
};

type PortSpec = {
  side: Position;
  top?: number;
  left?: number;
  right?: number;
  bottom?: number;
};

const PIN_ALIASES: Record<string, string> = {
  P: '+',
  POS: '+',
  PLUS: '+',
  N: '-',
  NEG: '-',
  MINUS: '-',
};

function normalizedPin(pin: string): string {
  const key = pin.toUpperCase();
  return PIN_ALIASES[key] || key;
}

function portForPin(type: string, pinName: string, index: number, total: number): PortSpec {
  const pin = normalizedPin(pinName);
  const spread = total <= 1 ? 50 : 24 + (index * 52) / Math.max(total - 1, 1);

  if (type === 'bjt') {
    if (pin === 'B') return { side: Position.Left, left: -7, top: 50 };
    if (pin === 'C') return { side: Position.Top, top: -7, left: 70 };
    if (pin === 'E') return { side: Position.Bottom, bottom: -7, left: 70 };
  }

  if (type === 'mosfet') {
    if (pin === 'G') return { side: Position.Left, left: -7, top: 50 };
    if (pin === 'D') return { side: Position.Top, top: -7, left: 70 };
    if (pin === 'S') return { side: Position.Bottom, bottom: -7, left: 70 };
  }

  if (type === 'voltage_source' || type === 'current_source' || type === 'battery') {
    if (pin === '+' || pin === '1') return { side: Position.Top, top: -7, left: 50 };
    if (pin === '-' || pin === '2') return { side: Position.Bottom, bottom: -7, left: 50 };
  }

  if (type === 'ldo') {
    if (pin === 'IN') return { side: Position.Left, left: -7, top: 38 };
    if (pin === 'OUT') return { side: Position.Right, right: -7, top: 38 };
    if (pin === 'GND') return { side: Position.Bottom, bottom: -7, left: 50 };
  }

  if (type === 'mcu') {
    if (pin.includes('GND')) return { side: Position.Bottom, bottom: -7, left: spread };
    if (pin.includes('3V') || pin.includes('VCC') || pin.includes('VDD')) return { side: Position.Top, top: -7, left: spread };
    if (pin.includes('ADC') || pin.includes('GPIO4')) return { side: Position.Left, left: -7, top: spread };
    return { side: Position.Right, right: -7, top: spread };
  }

  if (pin === '1' || pin === 'A' || pin === 'ANODE') return { side: Position.Left, left: -7, top: 50 };
  if (pin === '2' || pin === 'K' || pin === 'CATHODE') return { side: Position.Right, right: -7, top: 50 };

  return index % 2 === 0
    ? { side: Position.Left, left: -7, top: spread }
    : { side: Position.Right, right: -7, top: spread };
}

function pinLabel(pin: Pin): string {
  if (pin.function) return `${pin.name} ${pin.function}`;
  return pin.name;
}

function ResistorSymbol() {
  return (
    <svg width="128" height="34" viewBox="0 0 128 34" className="schematic-symbol">
      <path d="M0 17H22l6-11 12 22 12-22 12 22 12-22 12 22 6-11h34" />
    </svg>
  );
}

function CapacitorSymbol() {
  return (
    <svg width="118" height="48" viewBox="0 0 118 48" className="schematic-symbol">
      <path d="M0 24h48M48 8v32M58 8v32M58 24h60" />
    </svg>
  );
}

function DiodeSymbol() {
  return (
    <svg width="118" height="50" viewBox="0 0 118 50" className="schematic-symbol">
      <path d="M0 25h38M80 25h38M38 10l38 25V10zM80 8v34" />
    </svg>
  );
}

function SourceSymbol() {
  return (
    <svg width="98" height="98" viewBox="0 0 98 98" className="schematic-symbol source-symbol">
      <circle cx="49" cy="49" r="30" />
      <path d="M49 14v14M49 70v14M40 41h18M49 32v18M40 62h18" />
    </svg>
  );
}

function BjtSymbol({ spiceModel }: { spiceModel?: string }) {
  const isPnp = spiceModel?.toUpperCase() === 'PNP';
  return (
    <svg width="138" height="118" viewBox="0 0 138 118" className="schematic-symbol transistor-symbol">
      <circle cx="72" cy="60" r="38" className="symbol-shell" />
      <path d="M48 28v64M0 60h48M48 60l50-34M48 60l50 34M98 26v-22M98 94v20" />
      {isPnp ? <path className="filled" d="M62 53l14-1-8-12z" /> : <path className="filled" d="M88 82l10 12-16-2z" />}
    </svg>
  );
}

function MosfetSymbol() {
  return (
    <svg width="138" height="118" viewBox="0 0 138 118" className="schematic-symbol transistor-symbol">
      <path d="M30 22v72M46 24v18M46 50v18M46 76v18M0 60h30M46 32h52V4M46 86h52v30M62 60h24" />
      <path className="filled" d="M70 54l16 6-16 6z" />
    </svg>
  );
}

function IcSymbol({ type }: { type: string }) {
  return (
    <div className="ic-symbol">
      {type === 'mcu' ? <Cpu size={28} /> : <span>{type.toUpperCase()}</span>}
    </div>
  );
}

function Symbol({ type, spiceModel }: { type: string; spiceModel?: string }) {
  if (type === 'resistor' || type === 'generic_load') return <ResistorSymbol />;
  if (type === 'capacitor') return <CapacitorSymbol />;
  if (type === 'diode') return <DiodeSymbol />;
  if (type === 'bjt') return <BjtSymbol spiceModel={spiceModel} />;
  if (type === 'mosfet') return <MosfetSymbol />;
  if (type === 'voltage_source' || type === 'current_source' || type === 'battery') return <SourceSymbol />;
  return <IcSymbol type={type} />;
}

const ComponentNode = ({ data }: NodeProps) => {
  const type = String(data.type || 'component').toLowerCase();
  const pins = (Array.isArray(data.pins) ? data.pins : []) as Pin[];
  const displayValue = data.value || data.part || '';
  const spiceModel = String(data.spice_model || '');

  return (
    <div className={`schematic-node component-node ${type}`}>
      {pins.map((pin, index) => {
        const port = portForPin(type, pin.name, index, pins.length);
        return (
          <Handle
            className="schematic-handle pin-handle"
            id={`pin:${pin.name}`}
            key={pin.name}
            position={port.side}
            style={{ top: port.top == null ? undefined : `${port.top}%`, left: port.left == null ? undefined : `${port.left}%`, right: port.right == null ? undefined : `${port.right}%`, bottom: port.bottom == null ? undefined : `${port.bottom}%` }}
            title={`${data.label}.${pin.name} -> ${pin.net}`}
            type="source"
          />
        );
      })}
      <div className="symbol-container">
        <Symbol type={type} spiceModel={spiceModel} />
      </div>
      <div className="label-container">
        <span className="ref-des">{data.label}</span>
        {displayValue && <span className="part-val">{displayValue}</span>}
      </div>
      {pins.length > 2 && (
        <div className="pin-list">
          {pins.slice(0, 8).map((pin) => (
            <span key={pin.name}>{pinLabel(pin)}</span>
          ))}
        </div>
      )}
    </div>
  );
};

export default memo(ComponentNode);
