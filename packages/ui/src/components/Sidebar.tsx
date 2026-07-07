import React, { useState, useEffect } from "react";
import {
  FileCode,
  Activity,
  Play,
  CheckCircle,
  Bug,
  CircuitBoard,
  Sun,
  Moon,
  Cpu,
  FolderTree,
  Settings,
  Plus,
  Copy,
  Edit2,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import { useProjectStore } from "../storage/projectStore";
import { openFromDisk } from "../storage/fileIo";

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  theme: "dark" | "light";
  toggleTheme: () => void;
}

const BLANK_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<system name="blank_design" ir_version="0.1">
  <metadata>
    <title>Blank Design</title>
    <description>A fresh, blank electronic design.</description>
  </metadata>
  <nets>
    <net id="gnd" role="ground"/>
  </nets>
  <components/>
  <simulation_profiles/>
</system>`;

const DIVIDER_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<system name="voltage_divider" ir_version="0.1">
  <metadata>
    <title>Voltage Divider</title>
    <description>9V source, R_top=20k, R_bottom=10k. Unloaded divider output is 3.000V.</description>
  </metadata>
  <nets>
    <net id="gnd" role="ground"/>
    <net id="vin" role="power" nominal_voltage="9V"/>
    <net id="vout" role="analog_signal"/>
  </nets>
  <components>
    <component id="V_IN" type="voltage_source">
      <value>9V</value>
      <pin name="p" net="vin"/>
      <pin name="n" net="gnd"/>
    </component>
    <component id="R_TOP" type="resistor">
      <value>20k</value>
      <pin name="1" net="vin"/>
      <pin name="2" net="vout"/>
    </component>
    <component id="R_BOTTOM" type="resistor">
      <value>10k</value>
      <pin name="1" net="vout"/>
      <pin name="2" net="gnd"/>
    </component>
  </components>
  <analog>
    <subsystem id="divider">
      <uses component="V_IN"/>
      <uses component="R_TOP"/>
      <uses component="R_BOTTOM"/>
      <probe id="probe_vout" net="vout" quantity="voltage"/>
    </subsystem>
  </analog>
  <simulation_profiles>
    <profile id="analog_only" default="true">
      <backend type="ngspice"/>
      <include subsystem="divider"/>
    </profile>
  </simulation_profiles>
</system>`;

const ESP32_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<system name="esp32_battery_sensor" ir_version="0.1">
  <metadata>
    <title>ESP32 Battery Sensor</title>
    <description>Battery voltage monitor for ESP32-C3 using LDO and resistive divider divider</description>
  </metadata>
  <nets>
    <net id="gnd" role="ground"/>
    <net id="bat" role="power" nominal_voltage="4.2V"/>
    <net id="3v3" role="power" nominal_voltage="3.3V"/>
    <net id="adc_sense" role="analog_signal"/>
  </nets>
  <components>
    <component id="U_MCU" type="mcu">
      <parameter name="model" value="ESP32-C3"/>
      <pin name="GND" net="gnd"/>
      <pin name="3V3" net="3v3"/>
      <pin name="GPIO4" net="adc_sense"/>
    </component>
    <component id="U_REG" type="ldo">
      <value>REG1117</value>
      <pin name="gnd" net="gnd"/>
      <pin name="in" net="bat"/>
      <pin name="out" net="3v3"/>
    </component>
    <component id="R1" type="resistor">
      <value>100k</value>
      <pin name="1" net="bat"/>
      <pin name="2" net="adc_sense"/>
    </component>
    <component id="R2" type="resistor">
      <value>10k</value>
      <pin name="1" net="adc_sense"/>
      <pin name="2" net="gnd"/>
    </component>
  </components>
  <analog>
    <subsystem id="battery_measurement">
      <uses component="R1"/>
      <uses component="R2"/>
      <probe id="probe_adc_sense" net="adc_sense" quantity="voltage"/>
    </subsystem>
  </analog>
  <simulation_profiles>
    <profile id="analog_only" default="true">
      <backend type="ngspice"/>
      <include subsystem="battery_measurement"/>
    </profile>
  </simulation_profiles>
</system>`;

const Sidebar: React.FC<SidebarProps> = ({ activeTab, setActiveTab, theme, toggleTheme }) => {
  const projectsList = useProjectStore((s) => s.projectsList);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const selectProject = useProjectStore((s) => s.selectProject);
  const createProject = useProjectStore((s) => s.createProject);
  const renameProject = useProjectStore((s) => s.renameProject);
  const duplicateProject = useProjectStore((s) => s.duplicateProject);
  const deleteProjectWithUndo = useProjectStore((s) => s.deleteProjectWithUndo);
  const restoreDeletedProject = useProjectStore((s) => s.restoreDeletedProject);
  const deletedProjectBackup = useProjectStore((s) => s.deletedProjectBackup);
  const clearDeletedBackup = useProjectStore((s) => s.clearDeletedBackup);
  const setFileHandle = useProjectStore((s) => s.setFileHandle);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  const [showTemplates, setShowTemplates] = useState(false);

  useEffect(() => {
    if (deletedProjectBackup) {
      const timer = setTimeout(() => {
        clearDeletedBackup();
      }, 10000);
      return () => clearTimeout(timer);
    }
  }, [deletedProjectBackup, clearDeletedBackup]);

  const tabs = [
    { id: "schematic", icon: CircuitBoard, label: "Schematic" },
    { id: "editor", icon: FileCode, label: "AIR XML" },
    { id: "simulation", icon: Activity, label: "Simulation" },
    { id: "firmware", icon: Cpu, label: "Firmware" },
    { id: "artifacts", icon: FolderTree, label: "Artifacts" },
    { id: "validation", icon: CheckCircle, label: "Validation" },
    { id: "repair", icon: Bug, label: "Repair" },
    { id: "settings", icon: Settings, label: "Settings" },
  ];

  const handleCreate = async (type: "blank" | "divider" | "esp32") => {
    let xml = BLANK_TEMPLATE;
    let name = "Blank Project";
    if (type === "divider") {
      xml = DIVIDER_TEMPLATE;
      name = "Voltage Divider";
    } else if (type === "esp32") {
      xml = ESP32_TEMPLATE;
      name = "ESP32 Battery Sensor";
    }

    setShowTemplates(false);
    await createProject(name, xml);
    setActiveTab("schematic");
  };

  const handleImport = async () => {
    setShowTemplates(false);
    try {
      const res = await openFromDisk();
      if (!res) return;

      const pId = await createProject(res.name, res.xml);
      // Associate file handle if opened via FSA API
      if (res.fileHandle) {
        await setFileHandle(pId, res.fileHandle);
      }
      setActiveTab("schematic");
    } catch (e) {
      alert("Import failed: " + (e as Error).message);
    }
  };

  const handleRename = async (id: string, currentName: string) => {
    const newName = prompt("Rename project to:", currentName);
    if (newName && newName.trim()) {
      await renameProject(id, newName.trim());
    }
  };

  const formatRelativeTime = (timestamp: number) => {
    const diff = now - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return new Date(timestamp).toLocaleDateString();
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <Play size={24} className="logo-icon" />
        <span>AirSpice</span>
      </div>

      <div className="sidebar-create-actions">
        <button
          className="sidebar-create-btn"
          onClick={() => setShowTemplates(!showTemplates)}
        >
          <Plus size={16} />
          <span>New Project</span>
        </button>
        {showTemplates && (
          <div
            style={{
              background: "var(--bg-secondary)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: 6,
              display: "flex",
              flexDirection: "column",
              gap: 4,
              boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
            }}
          >
            <button
              onClick={() => handleCreate("blank")}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-primary)",
                padding: "6px 8px",
                textAlign: "left",
                cursor: "pointer",
                borderRadius: 4,
                fontSize: 12,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              Blank Project
            </button>
            <button
              onClick={() => handleCreate("divider")}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-primary)",
                padding: "6px 8px",
                textAlign: "left",
                cursor: "pointer",
                borderRadius: 4,
                fontSize: 12,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              Voltage Divider Template
            </button>
            <button
              onClick={() => handleCreate("esp32")}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-primary)",
                padding: "6px 8px",
                textAlign: "left",
                cursor: "pointer",
                borderRadius: 4,
                fontSize: 12,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              ESP32 Battery Monitor Template
            </button>
            <button
              onClick={handleImport}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-primary)",
                padding: "6px 8px",
                textAlign: "left",
                cursor: "pointer",
                borderRadius: 4,
                fontSize: 12,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <Upload size={12} />
              <span>Import XML File...</span>
            </button>
          </div>
        )}
      </div>

      <div className="sidebar-project-section">
        <h3>My Projects</h3>
        <div className="project-list-items">
          {projectsList.map((project) => (
            <div
              key={project.id}
              className={`project-list-item ${
                activeProjectId === project.id ? "active" : ""
              }`}
              onClick={() => selectProject(project.id)}
            >
              <div className="project-item-details">
                <span className="project-item-name">{project.name}</span>
                <span className="project-item-time">
                  {formatRelativeTime(project.updatedAt)}
                </span>
              </div>
              <div className="project-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="project-action-btn"
                  onClick={() => handleRename(project.id, project.name)}
                  title="Rename"
                >
                  <Edit2 size={12} />
                </button>
                <button
                  className="project-action-btn"
                  onClick={() => duplicateProject(project.id)}
                  title="Duplicate"
                >
                  <Copy size={12} />
                </button>
                <button
                  className="project-action-btn"
                  onClick={() => deleteProjectWithUndo(project.id)}
                  title="Delete"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="sidebar-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`sidebar-tab ${activeTab === tab.id ? "active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
            title={tab.label}
          >
            <tab.icon size={20} />
            <span className="tab-label">{tab.label}</span>
          </button>
        ))}
      </div>
      <div className="sidebar-footer">
        <button
          className="theme-toggle"
          onClick={toggleTheme}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? <Sun size={20} /> : <Moon size={20} />}
          <span className="tab-label">
            {theme === "dark" ? "Light Mode" : "Dark Mode"}
          </span>
        </button>
      </div>

      {deletedProjectBackup && (
        <div className="toast-undo">
          <span>Project &apos;{deletedProjectBackup.name}&apos; deleted.</span>
          <button onClick={restoreDeletedProject}>
            <Undo2 size={12} style={{ display: "inline", marginRight: 4 }} />
            Undo
          </button>
        </div>
      )}
    </div>
  );
};

export default Sidebar;
