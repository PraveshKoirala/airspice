import React from 'react';
import { Terminal, AlertTriangle, CheckCircle2, Info } from 'lucide-react';

interface LogEntry {
  type: 'info' | 'error' | 'success' | 'warning';
  message: string;
  timestamp: string;
}

interface ResultPanelProps {
  logs: LogEntry[];
}

const ResultPanel: React.FC<ResultPanelProps> = ({ logs }) => {
  const getIcon = (type: string) => {
    switch (type) {
      case 'error': return <AlertTriangle size={14} className="error-icon" />;
      case 'success': return <CheckCircle2 size={14} className="success-icon" />;
      case 'warning': return <AlertTriangle size={14} className="warning-icon" />;
      default: return <Info size={14} className="info-icon" />;
    }
  };

  return (
    <div className="result-panel">
      <div className="result-header">
        <Terminal size={16} />
        <span>Output</span>
      </div>
      <div className="log-container">
        {logs.length === 0 ? (
          <div className="empty-logs">No output to display</div>
        ) : (
          logs.map((log, index) => (
            <div key={index} className={`log-entry ${log.type}`}>
              <span className="log-timestamp">[{log.timestamp}]</span>
              <span className="log-icon-wrapper">{getIcon(log.type)}</span>
              <span className="log-message">{log.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default ResultPanel;
