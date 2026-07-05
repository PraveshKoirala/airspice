import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import type { Node, Edge } from 'reactflow';
import { Activity, FileCode, FolderTree, RadioTower } from 'lucide-react';
import Sidebar from './components/Sidebar';
import Toolbar from './components/Toolbar';
import XmlEditor from './components/Editor';
import Graph from './components/Graph';
import ResultPanel from './components/ResultPanel';
import ChatRepl from './components/ChatRepl';
import RepairPanel from './components/RepairPanel';
import SettingsPanel from './components/SettingsPanel';
import Landing from './pages/Landing';
import type { ApiError, Diagnostic, ValidationResult } from './types/api';
import { getEngine, ENGINE_MODE, getRun } from './engine';
import { waveformCsv } from 'air-ts';
import type { SimulationReport as OracleReport } from 'air-ts';
import { useDesignStore } from './agent/designStore';
import { useAgentSettings } from './agent/agentSettings';
import type { NetworkProviderId } from 'agent';
import './App.css';

interface LogEntry {
  type: 'info' | 'error' | 'success' | 'warning';
  message: string;
  timestamp: string;
}

interface SimulationReport {
  profile?: string;
  status?: string;
  // The per-test reports are the oracle-schema reports (air-ts `buildReport`
  // output) in local mode; server mode returns the structurally-identical
  // backend JSON. `Partial` tolerates the server payload's looser shape.
  reports?: Array<Partial<OracleReport> & { test: string; status: string; backend: string }>;
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
  /**
   * Local (zero-backend) runs retain TYPED ARRAYS (issue #14): the chart and CSV
   * export read these directly, so the hot path never converts samples to
   * `number[]` / JSON. Absent for server-mode waveforms (which arrive as JSON).
   */
  timeArr?: Float64Array;
  valueArr?: Float64Array;
  /** The waveform-store run id (local mode), for CSV export of typed arrays. */
  runId?: string;
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
  // The design XML is owned by the versioned design store (issue #18): the agent
  // writes it ONLY via applyValidated (a gated ValidatedDesign) and the human
  // edits it via setUserXml. Seed the store with the default design once.
  const xml = useDesignStore((s) => s.xml);
  const setUserXml = useDesignStore((s) => s.setUserXml);
  useEffect(() => {
    if (useDesignStore.getState().xml === '') setUserXml(DEFAULT_XML);
    // Seeding is a one-time init; setUserXml is stable (store setter).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [simulation, setSimulation] = useState<SimulationReport | null>(null);
  const [waveforms, setWaveforms] = useState<WaveformData[]>([]);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  // BYOK agent config (issue #17/#18). Provider/model are picked in Settings; the
  // key lives only in the browser vault. Default to the mock provider so the
  // panel works with no key (deterministic demo / the CI-parity flow).
  const [agentProvider, setAgentProvider] = useState<NetworkProviderId | 'mock'>('mock');
  const [agentModel, setAgentModel] = useState<string | undefined>(undefined);
  const malformedCount = useAgentSettings((s) => s.malformedCount);

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

  // Live schematic + validation off the engine facade (issue #10). In
  // VITE_ENGINE=local this runs air-ts in a Web Worker with NO backend; in
  // =server it hits the FastAPI endpoints. Debounced ~150ms so typing in Monaco
  // never blocks on a (re)parse, and the keystroke->schematic latency is
  // measured with performance.now (acceptance criterion: <200ms).
  useEffect(() => {
    const engine = getEngine();
    if (!xml.trim()) return;
    let cancelled = false;
    const t0 = performance.now();
    const timer = setTimeout(() => {
      // Schematic: compute the graph and feed the Schematic tab.
      engine
        .toGraph(xml)
        .then((graph) => {
          if (cancelled) return;
          setNodes(graph.nodes);
          setEdges(graph.edges);
          const ms = performance.now() - t0;
          // Marks are visible in the browser Performance panel and logged so the
          // latency number is reproducible for the PR evidence.
          performance.measure?.('air:keystroke->graph', { start: t0, end: performance.now() });
          console.debug(`[engine:${ENGINE_MODE}] keystroke->schematic ${ms.toFixed(1)}ms`);
        })
        .catch((error) => {
          // Malformed XML mid-edit is expected; keep the last good schematic.
          if (!cancelled) console.debug('graph update skipped:', (error as Error).message);
        });
      // Validation: compute diagnostics live so the Validation tab reflects the
      // current XML without a separate round trip. Best-effort; the explicit
      // Validate button still runs the full backend workflow in server mode.
      engine
        .validate(xml)
        .then((result) => {
          if (!cancelled) setValidation(result);
        })
        .catch((error) => {
          if (!cancelled) console.debug('validation update skipped:', (error as Error).message);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
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
    // In local (zero-backend) mode, validate the live XML through the engine
    // facade -- no persist-to-disk, no server. In server mode, keep the existing
    // persist + path-based /validate workflow byte-for-byte.
    if (ENGINE_MODE === 'local') {
      addLog('Validating (local engine)', 'info');
      try {
        const result = await getEngine().validate(xml);
        setValidation(result);
        const diagnostics = result.diagnostics || [];
        if (result.success) {
          addLog('Validation passed.', 'success');
        } else {
          diagnostics.forEach((diagnostic: Diagnostic) => addLog(`${diagnostic.code}: ${diagnostic.message}`, 'error'));
        }
        setActiveTab('validation');
      } catch (error) {
        addLog(`Validation failed: ${(error as Error).message}`, 'error');
      } finally {
        setIsBusy(false);
      }
      return;
    }
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
    // Local (zero-backend) path: compile (air-ts) -> simulate (WASM ngspice
    // worker) -> report (air-ts report.ts) -> render. NO persist-to-disk, NO
    // server. The report is schema-identical to the oracle's, so the panels
    // below render it unchanged; waveforms are retained as typed arrays keyed by
    // the returned run id (issue #14).
    if (ENGINE_MODE === 'local') {
      addLog('Simulating (local engine, no backend)', 'info');
      try {
        const result = await getEngine().simulate(xml);
        setSimulation({ profile: result.profile, status: result.status, reports: result.reports });
        setWaveforms(buildLocalWaveforms(result.runId, result.reports));
        result.notes.forEach((note) => addLog(note, 'warning'));
        addLog(`Simulation ${result.status}.`, result.status === 'passed' ? 'success' : 'warning');
        setActiveTab('simulation');
      } catch (error) {
        addLog(`Simulation failed: ${(error as Error).message}`, 'error');
      } finally {
        setIsBusy(false);
      }
      return;
    }
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

  // Build the Simulation-tab waveform list from the typed-array store a local
  // run retained (issue #14). Samples stay Float64Array end to end: the chart
  // reads them directly and CSV export re-serializes them via air-ts
  // `waveformCsv`. NO number[]/JSON conversion in this hot path.
  const buildLocalWaveforms = (runId: string, reports: Array<{ test: string }> = []): WaveformData[] => {
    const run = getRun(runId);
    if (!run) return [];
    const out: WaveformData[] = [];
    for (const report of reports ?? []) {
      for (const [key, wf] of run.waveforms) {
        if (!key.startsWith(`${report.test}_`)) continue;
        const last = wf.values.length > 0 ? wf.values[wf.values.length - 1] : 0;
        out.push({
          name: key,
          path: `waveforms/${key}.csv`,
          test: wf.test,
          signal: wf.net,
          quantity: 'voltage',
          success: true,
          points: [],
          timeArr: wf.time,
          valueArr: wf.values,
          runId,
          last: { time_s: wf.time.length ? wf.time[wf.time.length - 1] : 0, value: last },
        });
      }
    }
    return out;
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

  // The autonomous repair loop runs ENTIRELY in the browser now (issue #19): the
  // Repair tab's RepairPanel drives the client-side loop (simulate → diagnose →
  // patch → re-simulate) against the same gate + engine the agent uses, and
  // applies each gated fix through the design store's single write path. This
  // REPLACES the old backend /ai-repair round-trip (which violated zero-backend).
  const handleRepair = () => {
    setActiveTab('repair');
  };

  // The old backend /agent/chat round-trip was replaced by the browser agent
  // tool runtime (issue #18): the ChatRepl panel drives runConversation directly
  // against the client-side gate + tools, and applies designs ONLY through the
  // design store's single write path (applyValidated / a gated ValidatedDesign).

  const renderPanel = () => {
    if (activeTab === 'schematic') {
      return <Graph nodes={nodes} edges={edges} />;
    }
    if (activeTab === 'editor') {
      return <XmlEditor xml={xml} onChange={(value) => setUserXml(value || '')} theme={theme} />;
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
      return (
        <RepairPanel
          provider={agentProvider}
          {...(agentModel ? { model: agentModel } : {})}
          theme={theme}
        />
      );
    }
    if (activeTab === 'settings') {
      return (
        <SettingsPanel
          malformedToolCallCount={malformedCount}
          agentProvider={agentProvider}
          agentModel={agentModel}
          onAgentProviderChange={setAgentProvider}
          onAgentModelChange={setAgentModel}
        />
      );
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
            <div className="workspace-status">
              <span className={`engine-badge ${ENGINE_MODE}`} title={`Engine: ${ENGINE_MODE}`} data-testid="engine-mode">{ENGINE_MODE === 'local' ? 'Local engine' : 'Server engine'}</span>
              <div className={`run-state ${isBusy ? 'busy' : 'idle'}`}>{isBusy ? 'Running' : 'Ready'}</div>
            </div>
          </div>
          <div className="design-path-bar">
            <span>Design</span>
            <input value={designPath} onChange={(event) => setDesignPath(event.target.value)} />
          </div>
          <section className="view-container">{renderPanel()}</section>
          <ResultPanel logs={logs} />
        </div>
      </main>
      <ChatRepl
        provider={agentProvider}
        {...(agentModel ? { model: agentModel } : {})}
        theme={theme}
      />
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
              {report.backend && <span className="muted-copy"> {report.backend}</span>}
            </div>
            <div className="measurement-table">
              {Object.entries(report.measurements || {}).map(([name, value]) => (
                <div key={name}>
                  <span>{name}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            {(report.diagnostics?.length ?? 0) > 0 && (
              <div className="diagnostic-list">
                {report.diagnostics!.map((diagnostic, index) => (
                  <div className={`diagnostic ${diagnostic.severity}`} key={`${diagnostic.code}-${index}`}>
                    <strong>{diagnostic.code}</strong>
                    <span>{diagnostic.message}</span>
                  </div>
                ))}
              </div>
            )}
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
  // Prefer the retained TYPED ARRAYS (local #14 runs) — read directly, no JSON
  // conversion. Fall back to the JSON `points` (server-mode waveforms).
  const timeArr = waveform.timeArr;
  const valueArr = waveform.valueArr;
  const useTyped = timeArr !== undefined && valueArr !== undefined && valueArr.length > 0;
  const jsonPoints = waveform.points || [];
  const sampleCount = useTyped ? valueArr!.length : jsonPoints.length;

  if (sampleCount === 0) {
    return <div className="waveform-empty">No samples in {waveform.name}</div>;
  }

  const width = 720;
  const height = 280;
  const pad = { left: 58, right: 18, top: 18, bottom: 36 };
  const timeAt = (i: number) => (useTyped ? (timeArr![i] as number) : jsonPoints[i]!.time_s);
  const valueAt = (i: number) => (useTyped ? (valueArr![i] as number) : jsonPoints[i]!.value);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < sampleCount; i++) {
    const t = timeAt(i), v = valueAt(i);
    if (t < minX) minX = t;
    if (t > maxX) maxX = t;
    if (v < minY) minY = v;
    if (v > maxY) maxY = v;
  }
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const segments: string[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const x = pad.left + ((timeAt(i) - minX) / spanX) * plotWidth;
    const y = pad.top + (1 - ((valueAt(i) - minY) / spanY)) * plotHeight;
    segments.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  const path = segments.join(' ');
  const unit = waveform.quantity === 'current' ? 'A' : 'V';
  const finalValue = valueAt(sampleCount - 1);

  // CSV export byte-identical in FORMAT to the oracle's canonical waveform CSVs
  // (issue #14): air-ts `waveformCsv` serializes the retained typed arrays.
  const canExport = useTyped;
  const onExport = () => {
    if (!canExport) return;
    const samples: [number, number][] = [];
    for (let i = 0; i < valueArr!.length; i++) samples.push([timeArr![i] as number, valueArr![i] as number]);
    const csv = waveformCsv(waveform.signal, samples);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${waveform.test}_${waveform.signal}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="waveform-chart">
      <div className="waveform-meta">
        <span>{waveform.name}</span>
        <strong>{formatValue(finalValue, unit)} final</strong>
        {canExport && (
          <button onClick={onExport} data-testid="waveform-export-csv" style={{ marginLeft: 8 }}>
            Export CSV
          </button>
        )}
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

// Dev-only integration surface for the WASM analog engine (issue #13). Lazily
// imported AND guarded by import.meta.env.DEV so neither SimLab nor its sim-wasm
// dependency (and its ~20MB WASM chunk) are pulled into the production build.
const SimLab = import.meta.env.DEV ? lazy(() => import('./pages/SimLab')) : null;

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
        {SimLab && (
          <Route
            path="/sim-lab"
            element={
              <Suspense fallback={<div style={{ padding: 24 }}>Loading sim-lab…</div>}>
                <SimLab />
              </Suspense>
            }
          />
        )}
      </Routes>
    </BrowserRouter>
  );
}

function LandingWrapper() {
  const navigate = useNavigate();
  return <Landing onNewProject={() => navigate('/project')} onOpenProject={() => navigate('/project')} />;
}

export default App;
