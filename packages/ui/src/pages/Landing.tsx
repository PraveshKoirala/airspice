import React from 'react';
import { Plus, FolderOpen, CircuitBoard, Clock, ChevronRight } from 'lucide-react';

interface LandingProps {
  onNewProject: () => void;
  onOpenProject: (path: string) => void;
}

const Landing: React.FC<LandingProps> = ({ onNewProject, onOpenProject }) => {
  const recentProjects = [
    { name: 'ESP32 Battery Sensor', path: 'examples/esp32_battery_sensor/design.air.xml', date: '2 hours ago' },
    { name: 'Voltage Divider', path: 'examples/analog_primitives/design.air.xml', date: 'Yesterday' },
    { name: 'Mixed Signal Switch', path: 'examples/mixed_signal_switch/design.air.xml', date: '3 days ago' },
  ];

  return (
    <div className="landing-container">
      <div className="landing-hero">
        <CircuitBoard size={64} className="hero-logo" />
        <h1>AI Native Spice</h1>
        <p>The first electronics design platform powered by dynamic AI reasoning.</p>
      </div>

      <div className="landing-actions">
        <button className="action-card primary" onClick={onNewProject}>
          <div className="action-icon">
            <Plus size={32} />
          </div>
          <div className="action-text">
            <h3>New Project</h3>
            <p>Start from a template or a blank design.</p>
          </div>
        </button>

        <button className="action-card" onClick={() => onOpenProject('')}>
          <div className="action-icon">
            <FolderOpen size={32} />
          </div>
          <div className="action-text">
            <h3>Open Project</h3>
            <p>Browse your local files for .air.xml projects.</p>
          </div>
        </button>
      </div>

      <div className="recent-projects">
        <div className="section-header">
          <Clock size={18} />
          <span>Recent Projects</span>
        </div>
        <div className="project-list">
          {recentProjects.map((project, idx) => (
            <div key={idx} className="project-item" onClick={() => onOpenProject(project.path)}>
              <div className="project-info">
                <span className="project-name">{project.name}</span>
                <span className="project-path">{project.path}</span>
              </div>
              <div className="project-meta">
                <span>{project.date}</span>
                <ChevronRight size={16} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default Landing;
