import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import type { Node, Edge } from 'reactflow';
import { Activity, FileCode, FolderTree, RadioTower, Zap } from 'lucide-react';
import Sidebar from './components/Sidebar';
import Toolbar from './components/Toolbar';
import XmlEditor from './components/Editor';
import Graph from './components/Graph';
import ResultPanel from './components/ResultPanel';
import ChatRepl from './components/ChatRepl';
import Landing from './pages/Landing';
import type { ApiError, ChatHistoryEntry, Diagnostic, ValidationResult } from './types/api';
import './App.css';

interface LogEntry {
  type: 'info' | 'error' | 'success' | 'warning';
  message: string;
  timestamp: string;
}

interface SimulationReport {
  profile?: string;
  status?: string;
  reports?: Array<{
    test: string;
    status: string;
    backend: string;
    measurements?: Record<string, string>;
    measurement_stats?: Record<string, Record<string, string>>;
    artifacts?: string[];
    diagnostics?: Array<{ severity: string; code: string; message: string }>;
  }>;
  diagnostics?: Array<{ severity: string; code: string; message: string }>;
}

interface WaveformSummary {
  name: string;
  path: string;
  test: string;
  signal: string;
  quantity: string;
  first?: WaveformPoint;
  last?: WaveformPoint;
}

interface WaveformPoint {
  time_s: number;
  value: number;
}

interface WaveformData extends WaveformSummary {
  success: boolean;
  points: WaveformPoint[];
}

const API_BASE = 'http://127.0.0.1:8000';
const DEFAULT_DESIGN = 'examples/esp32_battery_sensor/design.air.xml';
const UI_RUN_DIR = 'generated/ui_run';
const WORK_DESIGN = 'generated/ui_work/design.air.xml';

const DEFAULT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<system name="esp32_battery_sensor" ir_version="0.1">
  <metadata>
    <title>ESP32 Battery Sensor</title>
    <description>Battery-powered ESP32-C3 sensor node with ADC battery measurement.</description>
    <author>AIR</author>
    <created_at>2026-06-06T00:00:00Z</created_at>
  </metadata>
  <nets>
    <net id="gnd" role="ground"/>
    <net id="bat" role="power" nominal_voltage="3.7V"/>
    <net id="3v3" role="power" nominal_voltage="3.3V"/>
    <net id="battery_sense" role="analog_signal"/>
    <net id="i2c_sda" role="digital_signal"/>
    <net id="i2c_scl" role="digital_signal"/>
  </nets>
  <power_domains>
    <domain id="logic_3v3" net="3v3" nominal="3.3V" source="U_REG.out"/>
  </power_domains>
  <components>
    <component id="R_BAT_TOP" type="resistor">
      <value>1M</value>
      <pin name="1" net="bat"/>
      <pin name="2" net="battery_sense"/>
    </component>
    <component id="R_BAT_BOTTOM" type="resistor">
      <value>330k</value>
      <pin name="1" net="battery_sense"/>
      <pin name="2" net="gnd"/>
    </component>
    <component id="C_BAT_SENSE" type="capacitor">
      <value>100nF</value>
      <pin name="1" net="battery_sense"/>
      <pin name="2" net="gnd"/>
    </component>
    <component id="U_REG" type="ldo" part="generic_ldo_3v3">
      <pin name="in" net="bat"/>
      <pin name="out" net="3v3"/>
      <pin name="gnd" net="gnd"/>
      <property name="vout" value="3.3V"/>
      <property name="iout_max" value="700mA"/>
      <property name="v_dropout" value="200mV"/>
      <property name="iq" value="10uA"/>
    </component>
    <component id="U_MCU" type="mcu" part="ESP32-C3">
      <pin name="3V3" net="3v3"/>
      <pin name="GND" net="gnd"/>
      <pin name="GPIO4" net="battery_sense" function="ADC1_CH4"/>
      <pin name="GPIO8" net="i2c_sda" function="I2C_SDA"/>
      <pin name="GPIO9" net="i2c_scl" function="I2C_SCL"/>
    </component>
  </components>
  <interfaces>
    <interface id="i2c0" type="i2c">
      <controller component="U_MCU" peripheral="I2C0"/>
      <sda net="i2c_sda"/>
      <scl net="i2c_scl"/>
      <pullup net="i2c_sda" value="4.7k" to="3v3"/>
      <pullup net="i2c_scl" value="4.7k" to="3v3"/>
    </interface>
  </interfaces>
  <analog>
    <subsystem id="battery_measurement">
      <uses component="R_BAT_TOP"/>
      <uses component="R_BAT_BOTTOM"/>
      <uses component="C_BAT_SENSE"/>
      <probe id="probe_battery_sense" net="battery_sense" quantity="voltage"/>
    </subsystem>
  </analog>
  <firmware>
    <project id="fw_main" target="U_MCU" framework="platformio" language="cpp">
      <board>esp32-c3-devkitm-1</board>
    </project>
    <binding id="battery_adc_binding">
      <signal name="battery_voltage"/>
      <component ref="U_MCU"/>
      <peripheral>ADC1</peripheral>
      <channel>ADC1_CH4</channel>
      <net>battery_sense</net>
    </binding>
    <task id="read_battery" target="fw_main">
      <period>60s</period>
      <read_adc binding="battery_adc_binding" into="battery_raw"/>
      <convert expr="battery_raw_to_mv(battery_raw)" into="battery_mv"/>
      <log value="battery_mv"/>
    </task>
  </firmware>
  <tests>
    <test id="battery_adc_nominal">
      <setup><set_voltage net="bat" value="4.2V"/></setup>
      <run duration="500ms"/>
      <assert_voltage net="battery_sense" min="1.02V" max="1.06V"/>
    </test>
    <test id="rail_startup">
      <setup><set_voltage net="bat" value="3.7V"/></setup>
      <run duration="100ms"/>
      <assert_voltage net="3v3" min="3.0V" max="3.6V"/>
    </test>
  </tests>
  <simulation_profiles>
    <profile id="analog_only" default="true">
      <backend type="ngspice"/>
      <include subsystem="battery_measurement"/>
      <run test="battery_adc_nominal"/>
      <run test="rail_startup"/>
    </profile>
  </simulation_profiles>
</system>`;

function ProjectWorkspace({ theme, toggleTheme }: { theme: 'dark' | 'light', toggleTheme: () => void }) {
  const [activeTab, setActiveTab] = useState('schematic');
  const [designPath, setDesignPath] = useState(DEFAULT_DESIGN);
  const [xml, setXml] = useState<string>(DEFAULT_XML);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [simulation, setSimulation] = useState<SimulationReport | null>(null);
  const [waveforms, setWaveforms] = useState<WaveformData[]>([]);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatHistoryEntry[]>([]);

  const artifacts = useMemo(() => {
    const paths = new Set<string>();
    simulation?.reports?.forEach((report) => report.artifacts?.forEach((artifact) => paths.add(artifact)));
    return [...paths];
  }, [simulation]);

  const addLog = (message: string, type: LogEntry['type'] = 'info') => {
    setLogs((prev) => [{
      message,
      type,
      timestamp: new Date().toLocaleTimeString(),
    }, ...prev]);
  };

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (!xml.trim()) return;
      try {
        const response = await axios.post(`${API_BASE}/graph`, { xml });
        if (response.data.success) {
          setNodes(response.data.nodes);
          setEdges(response.data.edges);
        }
      } catch (error) {
        console.error('Failed to update graph:', error);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [xml]);

  // The editor XML is the source of truth. Persist it to a working design file
  // so the path-based actions (validate/simulate/repair) run against the live
  // design instead of whatever file `designPath` last pointed at on the backend.
  // Returns the saved path and its default simulation profile, or null on failure.
  const persistDesign = async (): Promise<{ design: string; profile: string } | null> => {
    try {
      const response = await axios.post(`${API_BASE}/save-design`, { xml, path: WORK_DESIGN });
      const design = response.data?.design;
      if (!design) {
        addLog(`Could not save design: ${response.data?.error || 'unknown error'}`, 'error');
        return null;
      }
      setDesignPath(design);
      return { design, profile: response.data.profile || 'analog_only' };
    } catch (error) {
      const apiError = error as ApiError;
      addLog(`Save failed: ${apiError.response?.data?.detail || apiError.message}`, 'error');
      return null;
    }
  };

  const handleValidate = async () => {
    setIsBusy(true);
    const saved = await persistDesign();
    if (!saved) {
      setIsBusy(false);
      return;
    }
    addLog(`Validating ${saved.design}`, 'info');
    try {
      const response = await axios.post(`${API_BASE}/validate`, { design: saved.design });
      setValidation(response.data);
      const diagnostics = response.data.diagnostics || [];
      if (response.data.success) {
        addLog('Validation passed.', 'success');
      } else {
        diagnostics.forEach((diagnostic: Diagnostic) => addLog(`${diagnostic.code}: ${diagnostic.message}`, 'error'));
      }
      setActiveTab('validation');
    } catch (error) {
      const apiError = error as ApiError;
      addLog(`Validation failed: ${apiError.response?.data?.detail || apiError.message}`, 'error');
    } finally {
      setIsBusy(false);
    }
  };

  const handleSimulate = async () => {
    setIsBusy(true);
    const saved = await persistDesign();
    if (!saved) {
      setIsBusy(false);
      return;
    }
    addLog(`Simulating ${saved.design} (profile: ${saved.profile})`, 'info');
    try {
      const response = await axios.post(`${API_BASE}/simulate`, {
        design: saved.design,
        profile: saved.profile,
        out_dir: UI_RUN_DIR,
      });
      setSimulation(response.data);
      await loadWaveforms();
      addLog(`Simulation ${response.data.status}.`, response.data.status === 'passed' ? 'success' : 'warning');
      setActiveTab('simulation');
    } catch (error) {
      const apiError = error as ApiError;
      addLog(`Simulation failed: ${apiError.response?.data?.detail || apiError.message}`, 'error');
    } finally {
      setIsBusy(false);
    }
  };

  const loadWaveforms = async () => {
    try {
      const response = await axios.get(`${API_BASE}/waveforms`, { params: { out_dir: UI_RUN_DIR } });
      const summaries: WaveformSummary[] = response.data.waveforms || [];
      const loaded = await Promise.all(summaries.map(async (waveform) => {
        const detail = await axios.get(`${API_BASE}/waveforms/${encodeURIComponent(waveform.name)}`, { params: { out_dir: UI_RUN_DIR } });
        return detail.data as WaveformData;
      }));
      setWaveforms(loaded.filter((waveform) => waveform.success));
    } catch (error) {
      const apiError = error as ApiError;
      setWaveforms([]);
      addLog(`Waveform load failed: ${apiError.response?.data?.detail || apiError.message}`, 'warning');
    }
  };

  const handleRepair = async () => {
    setIsBusy(true);
    const saved = await persistDesign();
    if (!saved) {
      setIsBusy(false);
      return;
    }
    addLog(`Running AI repair for ${saved.design}`, 'warning');
    try {
      const response = await axios.post(`${API_BASE}/ai-repair`, {
        design: saved.design,
        provider: 'mock',
        out: 'generated/ui_repair.patch.xml',
        apply_out: 'generated/ui_fixed.air.xml',
      });
      addLog(response.data.success ? 'Repair patch generated and validated.' : 'Repair did not produce a valid patch.', response.data.success ? 'success' : 'warning');
      setActiveTab('repair');
    } catch (error) {
      const apiError = error as ApiError;
      addLog(`Repair failed: ${apiError.response?.data?.detail || apiError.message}`, 'error');
    } finally {
      setIsBusy(false);
    }
  };

  const handleCommand = async (command: string) => {
    addLog(`Agent: ${command}`, 'info');
    const response = await axios.post(`${API_BASE}/agent/chat`, {
      message: command,
      history: chatHistory,
      provider: 'gemini',
    });
    const data = response.data;
    if (!data.success) {
      addLog(`Agent error: ${data.error}`, 'error');
      throw new Error(data.error);
    }
    setChatHistory(data.history);
    const fullResponse = data.response;
    const xmlMatch = fullResponse.match(/```xml\n([\s\S]*?)\n```/) || fullResponse.match(/(<system[\s\S]*?<\/system>)/);
    if (xmlMatch) {
      let extractedXml = xmlMatch[1] || xmlMatch[0];
      let attempts = 0;
      const MAX_ATTEMPTS = 2;

      while (attempts < MAX_ATTEMPTS) {
        const normalized = await axios.post(`${API_BASE}/normalize-xml`, { xml: extractedXml });
        if (normalized.data.success) {
          setXml(normalized.data.xml);
          setValidation({ success: true, diagnostics: normalized.data.diagnostics || [] });
          addLog('AI XML applied successfully.', 'success');
          setActiveTab('schematic');
          return fullResponse
            .replace(/```xml[\s\S]*?```/g, '\n(Design updated in schematic workspace)')
            .replace(/<system[\s\S]*?<\/system>/g, '\n(Design updated in schematic workspace)')
            .trim();
        }

        attempts++;
        addLog(`AI XML attempt ${attempts} failed validation. Requesting fix...`, 'warning');
        
        const errorCtx = normalized.data.diagnostics?.map((d: Diagnostic) => `${d.code}: ${d.message}`).join('\n') || normalized.data.error;
        const retryResp = await axios.post(`${API_BASE}/agent/chat`, {
          message: `The XML you just generated failed AIR validation with these errors:\n${errorCtx}\n\nPlease fix the XML and provide only the corrected <system> block.`,
          history: chatHistory,
          provider: 'gemini',
        });
        
        if (!retryResp.data.success) break;
        
        const retryFull = retryResp.data.response;
        const retryMatch = retryFull.match(/```xml\n([\s\S]*?)\n```/) || retryFull.match(/(<system[\s\S]*?<\/system>)/);
        if (!retryMatch) break;
        extractedXml = retryMatch[1] || retryMatch[0];
      }

      // If we reach here, validation failed even after retries
      addLog('AI XML rejected after self-healing attempts.', 'error');
      setActiveTab('validation');
      return 'The generated XML was rejected because it did not pass AIR validation. I opened the diagnostics panel so you can see the errors.';
    }
    return fullResponse;
  };

  const renderPanel = () => {
    if (activeTab === 'schematic') {
      return <Graph nodes={nodes} edges={edges} />;
    }
    if (activeTab === 'editor') {
      return <XmlEditor xml={xml} onChange={(value) => setXml(value || '')} theme={theme} />;
    }
    if (activeTab === 'simulation') {
      return <SimulationPanel simulation={simulation} waveforms={waveforms} />;
    }
    if (activeTab === 'validation') {
      return <DiagnosticsPanel validation={validation} />;
    }
    if (activeTab === 'firmware') {
      return <InfoPanel icon={<RadioTower size={18} />} title="Firmware" items={[
        'Generated PlatformIO firmware is available from the backend compiler.',
        'The current ESP32 task reads ADC, converts raw counts, and logs battery_mv.',
        'Use Compile Firmware from the API/CLI to refresh generated source.',
      ]} />;
    }
    if (activeTab === 'artifacts') {
      return <ArtifactsPanel artifacts={artifacts} />;
    }
    if (activeTab === 'repair') {
      return <InfoPanel icon={<Zap size={18} />} title="Repair Workflow" items={[
        'AI repair writes generated/ui_repair.patch.xml.',
        'Validated output is written to generated/ui_fixed.air.xml.',
        'Open the validation and simulation tabs after applying a patch.',
      ]} />;
    }
    return null;
  };

  return (
    <div className="app-container">
      <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} theme={theme} toggleTheme={toggleTheme} />
      <main className="main-content">
        <Toolbar onValidate={handleValidate} onSimulate={handleSimulate} onRepair={handleRepair} onSave={async () => { const saved = await persistDesign(); if (saved) addLog(`Saved design to ${saved.design}`, 'success'); }} />
        <div className="workspace-shell">
          <div className="workspace-header">
            <div>
              <span className="eyebrow">AIR Workspace</span>
              <h1>ESP32 Battery Sensor</h1>
            </div>
            <div className={`run-state ${isBusy ? 'busy' : 'idle'}`}>{isBusy ? 'Running' : 'Ready'}</div>
          </div>
          <div className="design-path-bar">
            <span>Design</span>
            <input value={designPath} onChange={(event) => setDesignPath(event.target.value)} />
          </div>
          <section className="view-container">{renderPanel()}</section>
          <ResultPanel logs={logs} />
        </div>
      </main>
      <ChatRepl onCommand={handleCommand} />
    </div>
  );
}

function SimulationPanel({ simulation, waveforms }: { simulation: SimulationReport | null; waveforms: WaveformData[] }) {
  const [selectedWaveform, setSelectedWaveform] = useState('');
  const activeWaveform = waveforms.find((waveform) => waveform.name === selectedWaveform) || waveforms[0];

  if (!simulation) {
    return <EmptyState icon={<Activity size={20} />} title="No simulation run yet" text="Run simulation to inspect assertions, measurements, and generated artifacts." />;
  }
  return (
    <div className="detail-panel">
      <div className="panel-heading">
        <Activity size={18} />
        <div>
          <span className="eyebrow">Simulation</span>
          <h2>{simulation.status || 'unknown'}</h2>
        </div>
      </div>
      <div className="metric-grid">
        {simulation.reports?.map((report) => (
          <div className="metric-section" key={report.test}>
            <div className="metric-section-title">
              <strong>{report.test}</strong>
              <span className={`status-pill ${report.status}`}>{report.status}</span>
            </div>
            <div className="measurement-table">
              {Object.entries(report.measurements || {}).map(([name, value]) => (
                <div key={name}>
                  <span>{name}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="waveform-section">
        <div className="metric-section-title">
          <strong>Waveforms</strong>
          {waveforms.length > 0 && (
            <select value={activeWaveform?.name || ''} onChange={(event) => setSelectedWaveform(event.target.value)}>
              {waveforms.map((waveform) => (
                <option key={waveform.name} value={waveform.name}>{waveform.signal} - {waveform.test}</option>
              ))}
            </select>
          )}
        </div>
        {activeWaveform ? <WaveformChart waveform={activeWaveform} /> : <p className="muted-copy">No waveform CSVs were generated for this run.</p>}
      </div>
    </div>
  );
}

function WaveformChart({ waveform }: { waveform: WaveformData }) {
  const points = waveform.points || [];
  if (points.length === 0) {
    return <div className="waveform-empty">No samples in {waveform.name}</div>;
  }

  const width = 720;
  const height = 280;
  const pad = { left: 58, right: 18, top: 18, bottom: 36 };
  const xs = points.map((point) => point.time_s);
  const ys = points.map((point) => point.value);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const path = points.map((point) => {
    const x = pad.left + ((point.time_s - minX) / spanX) * plotWidth;
    const y = pad.top + (1 - ((point.value - minY) / spanY)) * plotHeight;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  const unit = waveform.quantity === 'current' ? 'A' : 'V';

  return (
    <div className="waveform-chart">
      <div className="waveform-meta">
        <span>{waveform.name}</span>
        <strong>{formatValue(ys[ys.length - 1], unit)} final</strong>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${waveform.signal} waveform`}>
        <line x1={pad.left} y1={pad.top} x2={pad.left} y2={height - pad.bottom} />
        <line x1={pad.left} y1={height - pad.bottom} x2={width - pad.right} y2={height - pad.bottom} />
        <text x={12} y={pad.top + 8}>{formatValue(maxY, unit)}</text>
        <text x={12} y={height - pad.bottom}>{formatValue(minY, unit)}</text>
        <text x={pad.left} y={height - 10}>{formatTime(minX)}</text>
        <text x={width - pad.right - 70} y={height - 10}>{formatTime(maxX)}</text>
        <polyline points={path} />
      </svg>
    </div>
  );
}

function formatValue(value: number, unit: string) {
  if (Math.abs(value) < 1 && value !== 0) {
    return `${(value * 1000).toFixed(2)}m${unit}`;
  }
  return `${value.toFixed(3)}${unit}`;
}

function formatTime(value: number) {
  if (value < 1) return `${(value * 1000).toFixed(2)}ms`;
  return `${value.toFixed(3)}s`;
}

function DiagnosticsPanel({ validation }: { validation: ValidationResult | null }) {
  const diagnostics = validation?.diagnostics || [];
  if (!validation) {
    return <EmptyState icon={<FileCode size={20} />} title="No validation results" text="Run validation to inspect schema, electrical, pin, and simulation readiness diagnostics." />;
  }
  return (
    <div className="detail-panel">
      <div className="panel-heading">
        <FileCode size={18} />
        <div>
          <span className="eyebrow">Diagnostics</span>
          <h2>{validation.success ? 'Design is valid' : `${diagnostics.length} issue${diagnostics.length === 1 ? '' : 's'}`}</h2>
        </div>
      </div>
      <div className="diagnostic-list">
        {diagnostics.length === 0 ? <p>No diagnostics.</p> : diagnostics.map((diagnostic: Diagnostic, index: number) => (
          <div className={`diagnostic ${diagnostic.severity}`} key={`${diagnostic.code}-${index}`}>
            <strong>{diagnostic.code}</strong>
            <span>{diagnostic.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ArtifactsPanel({ artifacts }: { artifacts: string[] }) {
  return (
    <div className="detail-panel">
      <div className="panel-heading">
        <FolderTree size={18} />
        <div>
          <span className="eyebrow">Artifacts</span>
          <h2>{artifacts.length} generated paths</h2>
        </div>
      </div>
      <div className="artifact-list">
        {artifacts.length === 0 ? <p>No artifacts from the current UI run.</p> : artifacts.map((artifact) => <code key={artifact}>{artifact}</code>)}
      </div>
    </div>
  );
}

function InfoPanel({ icon, title, items }: { icon: React.ReactNode; title: string; items: string[] }) {
  return (
    <div className="detail-panel">
      <div className="panel-heading">
        {icon}
        <div>
          <span className="eyebrow">Workspace</span>
          <h2>{title}</h2>
        </div>
      </div>
      <ul className="info-list">
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>
  );
}

function EmptyState({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="empty-state">
      {icon}
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}

function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingWrapper />} />
        <Route path="/project" element={<ProjectWorkspace theme={theme} toggleTheme={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} />} />
      </Routes>
    </BrowserRouter>
  );
}

function LandingWrapper() {
  const navigate = useNavigate();
  return <Landing onNewProject={() => navigate('/project')} onOpenProject={() => navigate('/project')} />;
}

export default App;
