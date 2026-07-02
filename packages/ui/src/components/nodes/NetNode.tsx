import { memo } from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';

const NetNode = ({ data }: NodeProps) => {
  const rawRole = String(data.role || 'signal');
  const role = rawRole === 'analog_signal' || rawRole === 'digital_signal' ? 'signal' : rawRole;
  const label = String(data.label || '');

  if (role === 'ground') {
    return (
      <div className="net-node ground-node">
        <Handle className="schematic-handle net-handle" id="net" type="target" position={Position.Top} />
        <div className="ground-symbol">
          <span />
          <span />
          <span />
        </div>
        <div className="net-caption">{label}</div>
      </div>
    );
  }

  return (
    <div className={`net-node ${role === 'power' ? 'power-net' : 'signal-net'}`}>
      <Handle className="schematic-handle net-handle" id="net" type="target" position={role === 'power' ? Position.Bottom : Position.Left} />
      {role === 'signal' && <div className="junction-dot" />}
      <div className="net-label">{label}</div>
    </div>
  );
};

export default memo(NetNode);
