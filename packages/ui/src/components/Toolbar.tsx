import React from 'react';
import { Play, ShieldCheck, Zap, Save, RefreshCw } from 'lucide-react';

interface ToolbarProps {
  onValidate: () => void;
  onSimulate: () => void;
  onRepair: () => void;
  onSave: () => void;
}

const Toolbar: React.FC<ToolbarProps> = ({ onValidate, onSimulate, onRepair, onSave }) => {
  return (
    <div className="toolbar">
      <button onClick={onSave} title="Save Design">
        <Save size={18} />
        <span>Save</span>
      </button>
      <div className="toolbar-divider" />
      <button onClick={onValidate} title="Run Validation">
        <ShieldCheck size={18} />
        <span>Validate</span>
      </button>
      <button onClick={onSimulate} title="Run Simulation">
        <Play size={18} />
        <span>Simulate</span>
      </button>
      <button onClick={onRepair} title="Auto Repair">
        <Zap size={18} />
        <span>Repair</span>
      </button>
      <div className="toolbar-divider" />
      <button title="Reset">
        <RefreshCw size={18} />
      </button>
    </div>
  );
};

export default Toolbar;
