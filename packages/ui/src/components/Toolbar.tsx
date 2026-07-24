import React from 'react';
import { Play, ShieldCheck, Zap, Save, Share2 } from 'lucide-react';

interface ToolbarProps {
  onValidate: () => void;
  onSimulate: () => void;
  onRepair: () => void;
  onSave: () => void;
  onShare: () => void;
}

const Toolbar: React.FC<ToolbarProps> = ({ onValidate, onSimulate, onRepair, onSave, onShare }) => {
  return (
    <div className="toolbar">
      <button onClick={onSave} title="Save Design">
        <Save size={18} />
        <span>Save</span>
      </button>
      <button onClick={onShare} title="Copy a shareable link (design encoded in the URL)">
        <Share2 size={18} />
        <span>Share</span>
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
    </div>
  );
};

export default Toolbar;
