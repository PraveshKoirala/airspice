import React from 'react';
import { FileCode, Activity, Play, CheckCircle, Bug, CircuitBoard, Sun, Moon, Cpu, FolderTree } from 'lucide-react';

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  theme: 'dark' | 'light';
  toggleTheme: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({ activeTab, setActiveTab, theme, toggleTheme }) => {
  const tabs = [
    { id: 'schematic', icon: CircuitBoard, label: 'Schematic' },
    { id: 'editor', icon: FileCode, label: 'AIR XML' },
    { id: 'simulation', icon: Activity, label: 'Simulation' },
    { id: 'firmware', icon: Cpu, label: 'Firmware' },
    { id: 'artifacts', icon: FolderTree, label: 'Artifacts' },
    { id: 'validation', icon: CheckCircle, label: 'Validation' },
    { id: 'repair', icon: Bug, label: 'Repair' },
  ];

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <Play size={24} className="logo-icon" />
        <span>AI Native Spice</span>
      </div>
      <div className="sidebar-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`sidebar-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            title={tab.label}
          >
            <tab.icon size={20} />
            <span className="tab-label">{tab.label}</span>
          </button>
        ))}
      </div>
      <div className="sidebar-footer">
        <button className="theme-toggle" onClick={toggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
          {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
          <span className="tab-label">{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
        </button>
      </div>
    </div>
  );
};

export default Sidebar;
