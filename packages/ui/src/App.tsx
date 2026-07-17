import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import type { Node, Edge } from 'reactflow';
import { Activity, FileCode, FolderTree } from 'lucide-react';
import Sidebar from './components/Sidebar';
import Toolbar from './components/Toolbar';
import XmlEditor from './components/Editor';
import Graph from './components/Graph';
import Inspector from './schematic/Inspector';
import Palette from './schematic/Palette';
import type { GuiHint, SchematicIR } from './schematic/types';
import { parse as parseAir } from 'air-ts';
import { saveHintsPatch } from './schematic/patches';
import { commitPatch } from './schematic/gate';
import type { WireSource, WireTarget } from './schematic/Renderer';
import {
  disconnectPinPatch,
  deleteComponentPatch,
  deleteNetPatch,
  nextAutoNetId,
  reassignPinPatch,
  connectPinsWithNewNetPatch,
} from './schematic/wiring';
import {
  coalesceUserXml,
  flushCoalescedEdit,
  performRedo,
  performUndo,
  pushHistoryEntry,
  resetHistory,
  useHistoryStore,
} from './schematic/history';
import ResultPanel from './components/ResultPanel';
import ChatRepl from './components/ChatRepl';
import RepairPanel from './components/RepairPanel';
import SettingsPanel from './components/SettingsPanel';
import FirmwarePanel from './components/FirmwarePanel';
import Landing from './pages/Landing';
import type { ApiError, Diagnostic, ValidationResult } from './types/api';
import { getEngine, ENGINE_MODE, getRun } from './engine';
import type { SimulationReport as OracleReport, SystemIR } from 'air-ts';
import { WaveformViewer, type WaveformTrace } from './waveform';
import { useProjectStore } from './storage/projectStore';
import { saveToDisk, saveAsToDisk } from './storage/fileIo';
import { exportAllRawRecords } from './storage/db';
import { useDesignStore } from './agent/designStore';
import { useAgentSettings } from './agent/agentSettings';
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
  const xml = useDesignStore((s) => s.xml);
  const projectsList = useProjectStore((s) => s.projectsList);
  const projectStoreInitialized = useProjectStore((s) => s.initialized);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const selectProject = useProjectStore((s) => s.selectProject);
  const createProject = useProjectStore((s) => s.createProject);
  const saveActiveProjectXml = useProjectStore((s) => s.saveActiveProjectXml);
  const setFileHandle = useProjectStore((s) => s.setFileHandle);
  const conflictError = useProjectStore((s) => s.conflictError);
  const setConflictError = useProjectStore((s) => s.setConflictError);

  const activeProject = useMemo(() => {
    return projectsList.find((p) => p.id === activeProjectId) || null;
  }, [projectsList, activeProjectId]);

  const activeProjectName = activeProject ? activeProject.name : 'ESP32 Battery Sensor';

  useEffect(() => {
    const runInit = async () => {
      if (!projectStoreInitialized) return;
      if (useProjectStore.getState().isDowngraded) return;
      const currentList = useProjectStore.getState().projectsList;
      if (currentList.length === 0) {
        // First-run migration
        await createProject("Untitled Project", DEFAULT_XML);
      } else if (!useProjectStore.getState().activeProjectId) {
        // Select the most recently updated project
        await selectProject(currentList[0].id);
      }
    };
    runInit();
  }, [projectStoreInitialized, projectsList.length, selectProject, createProject]);

  // Keep a ref to the latest XML so visibilitychange/pagehide can access it
  const xmlRef = useRef(xml);
  useEffect(() => {
    xmlRef.current = xml;
  }, [xml]);

  // Debounced autosave (1s)
  useEffect(() => {
    if (!activeProjectId || !xml) return;
    const timer = setTimeout(() => {
      saveActiveProjectXml(xml);
    }, 1000);
    return () => clearTimeout(timer);
  }, [xml, activeProjectId, saveActiveProjectXml]);

  // Flush on tab close/visibility change
  useEffect(() => {
    const flushAutosave = () => {
      if (activeProjectId && xmlRef.current) {
        saveActiveProjectXml(xmlRef.current);
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushAutosave();
      }
    };
    window.addEventListener('pagehide', flushAutosave);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', flushAutosave);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [activeProjectId, saveActiveProjectXml]);

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
  const agentProvider = useAgentSettings((s) => s.agentProvider);
  const agentModel = useAgentSettings((s) => s.agentModel);
  const malformedCount = useAgentSettings((s) => s.malformedCount);
  const tokenBudget = useAgentSettings((s) => s.tokenBudget);

  // Undo/redo keyboard binding (issue #24 D5). Ctrl+Z / Cmd+Z undoes,
  // Ctrl+Shift+Z / Ctrl+Y / Cmd+Shift+Z redoes. Registered at capture
  // phase so it fires ahead of Monaco's own binding.
  //
  // Any pending typing-coalesce entry is FLUSHED before the undo runs so
  // a mid-type Ctrl+Z steps back over the whole in-flight edit, not the
  // future never-flushed pre-image.
  const undoDepth = useHistoryStore((s) => s.undoStack.length);
  const redoDepth = useHistoryStore((s) => s.redoStack.length);
  useEffect(() => {
    const stampLog = (message: string, type: LogEntry['type']) =>
      setLogs((prev) => [
        { message, type, timestamp: new Date().toLocaleTimeString() },
        ...prev,
      ]);
    const onKey = (event: KeyboardEvent) => {
      const cmd = event.ctrlKey || event.metaKey;
      if (!cmd) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        flushCoalescedEdit();
        const entry = performUndo();
        if (entry) stampLog(`Undo: ${entry.label}`, 'info');
        else stampLog('Nothing to undo', 'warning');
        return;
      }
      if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault();
        event.stopPropagation();
        flushCoalescedEdit();
        const entry = performRedo();
        if (entry) stampLog(`Redo: ${entry.label}`, 'info');
        else stampLog('Nothing to redo', 'warning');
        return;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Agent write path (#18) -> history: applyValidated writes go through
  // useDesignStore.setState directly (not our commitPatch), so we
  // subscribe to store changes and record entries when the write source
  // is external (agent).
  useEffect(() => {
    let previous = useDesignStore.getState().xml;
    const unsubscribe = useDesignStore.subscribe((state) => {
      const next = state.xml;
      if (next === previous) return;
      const hs = useHistoryStore.getState();
      // Skip if undo/redo replay is in progress.
      if (hs.suppressCapture) {
        previous = next;
        return;
      }
      // Skip if a coalesced typing edit or a commitPatch is currently
      // owning this write. Both paths push their own entry.
      if (hs.internalWrite) {
        previous = next;
        return;
      }
      // Otherwise: an external write (agent applyValidated, initial seed,
      // programmatic reset). Capture it so undo/redo covers it too
      // (issue #24 D5 cross-source acceptance). The initial seed
      // (previous === '') is skipped -- there's nothing meaningful to
      // undo to.
      if (previous !== '') {
        pushHistoryEntry(previous, next, 'agent', 'external write');
      }
      previous = next;
    });
    return () => unsubscribe();
  }, []);

  void undoDepth;
  void redoDepth;
  void resetHistory;

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

  const handleSave = async () => {
    if (ENGINE_MODE !== 'local') {
      const saved = await persistDesign();
      if (saved) addLog(`Saved design to ${saved.design}`, 'success');
      return;
    }

    if (!activeProject) {
      addLog('No active project to save.', 'error');
      return;
    }

    try {
      if (activeProject.fileHandle) {
        await saveToDisk(xml, activeProject.fileHandle);
        addLog(`Saved project '${activeProject.name}' to disk.`, 'success');
      } else {
        const handle = await saveAsToDisk(xml, activeProject.name);
        if (handle) {
          await setFileHandle(activeProject.id, handle);
          addLog(`Saved project as '${handle.name}' to disk.`, 'success');
        } else {
          addLog(`Project exported to downloads.`, 'success');
        }
      }
    } catch (e) {
      addLog(`Failed to save to disk: ${(e as Error).message}`, 'error');
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

  // Latest schematic IR (positions + wire routes) captured from the Renderer
  // after each successful layout. The Inspector's "Save layout" action reads
  // it to build <gui> patches; storing it in App state keeps the Inspector
  // decoupled from the SVG renderer.
  const [schematicIR, setSchematicIR] = useState<SchematicIR | null>(null);

  // Parse the design XML on the main thread to extract <gui> hints (a small
  // cost -- a few ms on the largest corpus -- shared with the Inspector's
  // parse in a real app; kept explicit here for clarity). A parse failure
  // during mid-edit typing yields empty hints, which is the same as
  // hint-less behavior (fallback to auto-layout).
  const hints = useMemo<GuiHint[]>(() => {
    if (!xml.trim()) return [];
    try {
      const ir = parseAir(xml);
      const out: GuiHint[] = [];
      for (const c of ir.components.values()) {
        if (c.gui) out.push({ componentId: c.id, x: c.gui.x, y: c.gui.y, rot: c.gui.rot });
      }
      return out;
    } catch {
      return [];
    }
  }, [xml]);

  // Issue #23 drag/nudge write path. Threaded through the ONE COMMIT PATH
  // (schematic/gate.ts) so the mutation shows up in the undo/redo stack
  // (issue #24 D5) alongside every other edit source.
  const commitMove = (moves: Array<{ id: string; x: number; y: number }>): { ok: true } | { ok: false; message: string } => {
    if (moves.length === 0) return { ok: true };
    const currentXml = useDesignStore.getState().xml;
    let parsed;
    try {
      parsed = parseAir(currentXml);
    } catch (err) {
      return { ok: false, message: 'parse failed: ' + (err as Error).message };
    }
    const entries: Array<{ comp: Parameters<typeof saveHintsPatch>[0][number]['comp']; hint: GuiHint }> = [];
    for (const move of moves) {
      const comp = parsed.components.get(move.id);
      if (!comp) return { ok: false, message: `unknown component: ${move.id}` };
      entries.push({
        comp,
        hint: {
          componentId: move.id,
          x: move.x,
          y: move.y,
          rot: comp.gui?.rot ?? 0,
        },
      });
    }
    const patchXml = saveHintsPatch(entries);
    if (!patchXml) return { ok: true };
    const outcome = commitPatch(patchXml, 'drag', `moved ${moves.map((m) => m.id).join(', ')}`);
    return outcome.ok ? { ok: true } : { ok: false, message: outcome.message };
  };

  // Issue #24 D1 wire-draw write path. The Renderer resolves the drop
  // target; we build the appropriate <patch> and hand it to commitPatch.
  //
  // Rules:
  //   - target=pin same as source: illegal (rejected with toast).
  //   - target=pin on same component: allowed IF pins differ (creates a
  //     short across the component; the gate will reject at validation
  //     time if it violates the topology, so we don't second-guess here).
  //   - target=pin on different component: reassign source to target's
  //     net when target's net has >=2 members OR is a rail (join it);
  //     otherwise create a fresh auto-name net for both.
  //   - target=net: reassign source pin to that net.
  const commitWire = (source: WireSource, target: WireTarget): { ok: true } | { ok: false; message: string } => {
    if (target.kind === 'empty') return { ok: true };
    const currentXml = useDesignStore.getState().xml;
    let parsed;
    try {
      parsed = parseAir(currentXml);
    } catch (err) {
      return { ok: false, message: 'parse failed: ' + (err as Error).message };
    }
    const srcComp = parsed.components.get(source.comp);
    if (!srcComp) return { ok: false, message: `unknown component: ${source.comp}` };
    const srcPin = srcComp.pins.get(source.pin);
    if (!srcPin) return { ok: false, message: `unknown pin: ${source.pin} on ${source.comp}` };

    if (target.kind === 'net') {
      if (srcPin.net === target.net) return { ok: false, message: 'already on that net' };
      const patchXml = reassignPinPatch(srcComp, source.pin, target.net);
      const outcome = commitPatch(patchXml, 'wire', `${source.comp}.${source.pin} -> ${target.net}`);
      return outcome.ok ? { ok: true } : { ok: false, message: outcome.message };
    }

    // target.kind === 'pin'
    if (target.comp === source.comp && target.pin === source.pin) {
      return { ok: false, message: 'cannot wire a pin to itself' };
    }
    const tgtComp = parsed.components.get(target.comp);
    if (!tgtComp) return { ok: false, message: `unknown component: ${target.comp}` };
    const tgtPin = tgtComp.pins.get(target.pin);
    if (!tgtPin) return { ok: false, message: `unknown pin: ${target.pin} on ${target.comp}` };

    if (srcPin.net === tgtPin.net) {
      return { ok: false, message: 'pins are already on the same net' };
    }

    // Count members of both nets to decide join-vs-create.
    let srcCount = 0;
    let tgtCount = 0;
    for (const c of parsed.components.values()) {
      for (const p of c.pins.values()) {
        if (p.net === srcPin.net) srcCount++;
        if (p.net === tgtPin.net) tgtCount++;
      }
    }
    const tgtNet = parsed.nets.get(tgtPin.net);
    const srcNet = parsed.nets.get(srcPin.net);
    const tgtIsRail = tgtNet && (tgtNet.role === 'power' || tgtNet.role === 'ground');
    const srcIsRail = srcNet && (srcNet.role === 'power' || srcNet.role === 'ground');

    // If target is a rail: reassign source into the rail.
    // If source is a rail (rare -- user started drag from a rail pin):
    //   reassign target into source's net.
    // Otherwise: reassign into the "richer" net so we absorb the smaller.
    if (tgtIsRail || tgtCount > srcCount) {
      const patchXml = reassignPinPatch(srcComp, source.pin, tgtPin.net);
      const outcome = commitPatch(patchXml, 'wire', `${source.comp}.${source.pin} -> ${tgtPin.net}`);
      return outcome.ok ? { ok: true } : { ok: false, message: outcome.message };
    }
    if (srcIsRail || srcCount > tgtCount) {
      const patchXml = reassignPinPatch(tgtComp, target.pin, srcPin.net);
      const outcome = commitPatch(patchXml, 'wire', `${target.comp}.${target.pin} -> ${srcPin.net}`);
      return outcome.ok ? { ok: true } : { ok: false, message: outcome.message };
    }

    // Both source and target nets are singletons: create a fresh auto-name
    // net and put both pins on it. `nextAutoNetId` skips collisions.
    const newNet = nextAutoNetId(parsed);
    const patchXml = connectPinsWithNewNetPatch(
      { comp: srcComp, pin: source.pin },
      { comp: tgtComp, pin: target.pin },
      newNet,
      'signal',
    );
    const outcome = commitPatch(patchXml, 'wire', `new ${newNet}: ${source.comp}.${source.pin} <-> ${target.comp}.${target.pin}`);
    return outcome.ok ? { ok: true } : { ok: false, message: outcome.message };
  };

  // Issue #24 D2 & D4 delete write path.
  const commitDelete = (t: { kind: 'component'; id: string } | { kind: 'net'; id: string }): { ok: true } | { ok: false; message: string } => {
    const currentXml = useDesignStore.getState().xml;
    let parsed;
    try {
      parsed = parseAir(currentXml);
    } catch (err) {
      return { ok: false, message: 'parse failed: ' + (err as Error).message };
    }
    if (t.kind === 'component') {
      let built;
      try {
        built = deleteComponentPatch(parsed, t.id);
      } catch (err) {
        return { ok: false, message: (err as Error).message };
      }
      if (built.danglingProbeTests.length > 0) {
        const ok = window.confirm(
          `Deleting ${t.id} will leave ${built.danglingProbeTests.length} assertion probe(s) with no connected net:\n  ${built.danglingProbeTests.join('\n  ')}\nProceed?`,
        );
        if (!ok) return { ok: false, message: 'delete cancelled' };
      }
      const outcome = commitPatch(built.patchXml, 'delete', `deleted ${t.id}`);
      return outcome.ok ? { ok: true } : { ok: false, message: outcome.message };
    }
    // Net delete: only remove signal nets outright (power/ground are
    // structural and referenced by <tests>/<power_domains>).
    const net = parsed.nets.get(t.id);
    if (!net) return { ok: false, message: `unknown net: ${t.id}` };
    if (net.role === 'power' || net.role === 'ground') {
      return { ok: false, message: `cannot delete ${net.role} net ${t.id}` };
    }
    const reserved = new Set<string>();
    const namer = (used: Set<string>) => {
      const id = nextAutoNetId(parsed, new Set([...reserved, ...used]));
      reserved.add(id);
      return id;
    };
    let patchXml;
    try {
      patchXml = deleteNetPatch(parsed, t.id, namer);
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    const outcome = commitPatch(patchXml, 'delete', `deleted net ${t.id}`);
    return outcome.ok ? { ok: true } : { ok: false, message: outcome.message };
  };

  // Wire the schematic disconnect-single-pin flow if we want it in the
  // future -- currently the whole-net delete covers the acceptance
  // criterion; per-segment disconnect is exposed via wiring.ts should a
  // caller need it. Silence linter.
  void disconnectPinPatch;

  // Track the last-known cursor hint on the canvas for palette placement.
  const cursorHintRef = useRef<GuiHint | null>(null);
  const getPlacementHint = (): GuiHint | null => cursorHintRef.current;
  const onCursor = (hint: GuiHint) => {
    cursorHintRef.current = hint;
  };

  const renderPanel = () => {
    if (activeTab === 'schematic') {
      return (
        <div className="schematic-split with-palette" data-testid="schematic-split">
          <Palette
            getPlacementHint={getPlacementHint}
            onPlaced={(id, entry) => addLog(`Placed ${entry.displayName} as ${id}`, 'success')}
            onError={(msg) => addLog(msg, 'error')}
          />
          <Graph
            nodes={nodes}
            edges={edges}
            hints={hints}
            interactive
            onLayout={setSchematicIR}
            onCommitMove={commitMove}
            onCommitWire={commitWire}
            onCommitDelete={commitDelete}
            onCursor={onCursor}
          />
          <Inspector ir={schematicIR} />
        </div>
      );
    }
    if (activeTab === 'editor') {
      // Route Monaco keystrokes through coalesceUserXml so a long run of
      // typing enters the undo stack as ONE history entry (per issue #24
      // acceptance: "text edits enter as ONE coalesced step per
      // idle-pause"). Undo/redo replay via performUndo/performRedo.
      return <XmlEditor xml={xml} onChange={(value) => coalesceUserXml(value || '')} theme={theme} />;
    }
    if (activeTab === 'simulation') {
      return <SimulationPanel simulation={simulation} waveforms={waveforms} designXml={xml} theme={theme} />;
    }
    if (activeTab === 'validation') {
      return <DiagnosticsPanel validation={validation} />;
    }
    if (activeTab === 'firmware') {
      return <FirmwarePanel xml={xml} />;
    }
    if (activeTab === 'artifacts') {
      return <ArtifactsPanel artifacts={artifacts} />;
    }
    if (activeTab === 'repair') {
      return (
        <RepairPanel
          provider={agentProvider}
          {...(agentModel ? { model: agentModel } : {})}
          maxTokensPerTurn={tokenBudget}
          theme={theme}
        />
      );
    }
    if (activeTab === 'settings') {
      return (
        <SettingsPanel
          malformedToolCallCount={malformedCount}
        />
      );
    }
    return null;
  };

  return (
    <div className="app-container">
      <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} theme={theme} toggleTheme={toggleTheme} />
      <main className="main-content">
        {conflictError && (
          <div className="conflict-banner">
            <span>{conflictError}</span>
            <div>
              <button onClick={() => window.location.reload()} style={{ marginRight: 8 }}>Reload Page</button>
              <button onClick={() => setConflictError(null)}>Dismiss</button>
            </div>
          </div>
        )}
        <Toolbar onValidate={handleValidate} onSimulate={handleSimulate} onRepair={handleRepair} onSave={handleSave} />
        <div className={`workspace-shell${ENGINE_MODE === 'local' ? ' no-path-bar' : ''}`}>
          <div className="workspace-header">
            <div>
              <span className="eyebrow">AIR Workspace</span>
              <h1>{activeProjectName}</h1>
            </div>
            <div className="workspace-status">
              <span className={`engine-badge ${ENGINE_MODE}`} title={`Engine: ${ENGINE_MODE}`} data-testid="engine-mode">{ENGINE_MODE === 'local' ? 'Local engine' : 'Server engine'}</span>
              <div className={`run-state ${isBusy ? 'busy' : 'idle'}`}>{isBusy ? 'Running' : 'Ready'}</div>
            </div>
          </div>
          {ENGINE_MODE !== 'local' && (
            <div className="design-path-bar">
              <span>Design</span>
              <input value={designPath} onChange={(event) => setDesignPath(event.target.value)} />
            </div>
          )}
          <section className="view-container">{renderPanel()}</section>
          <ResultPanel logs={logs} />
        </div>
      </main>
      <ChatRepl
        provider={agentProvider}
        {...(agentModel ? { model: agentModel } : {})}
        maxTokensPerTurn={tokenBudget}
        theme={theme}
      />
    </div>
  );
}

function SimulationPanel({ simulation, waveforms, designXml, theme }: { simulation: SimulationReport | null; waveforms: WaveformData[]; designXml: string; theme: 'dark' | 'light' }) {
  // Parse the design once for assertion-band extraction. A malformed mid-edit
  // XML yields no bands; the viewer still renders the traces.
  const design = useMemo<SystemIR | null>(() => {
    if (!designXml.trim()) return null;
    try { return parseAir(designXml); } catch { return null; }
  }, [designXml]);

  // Flatten every simulation report's diagnostics so the viewer can flag
  // failing assertions with their diagnostic ids (audit amendment).
  const allDiagnostics = useMemo(() => {
    const out: Array<{ code: string; id?: string; related_elements?: string[] }> = [];
    for (const r of simulation?.reports ?? []) {
      for (const d of r.diagnostics ?? []) {
        out.push({ code: d.code, id: (d as { id?: string }).id, related_elements: (d as { related_elements?: string[] }).related_elements });
      }
    }
    return out;
  }, [simulation]);

  // Convert the panel's WaveformData[] into WaveformTrace[] for the viewer.
  // Server-mode waveforms (JSON points, no typed arrays) are materialized
  // into Float64Arrays here so the viewer's LOD cache still applies.
  const traces = useMemo<WaveformTrace[]>(() => {
    return waveforms
      .map((w): WaveformTrace | null => {
        let time: Float64Array;
        let values: Float64Array;
        if (w.timeArr && w.valueArr) {
          time = w.timeArr;
          values = w.valueArr;
        } else {
          const pts = w.points ?? [];
          if (pts.length === 0) return null;
          time = new Float64Array(pts.length);
          values = new Float64Array(pts.length);
          for (let i = 0; i < pts.length; i++) {
            time[i] = pts[i]!.time_s;
            values[i] = pts[i]!.value;
          }
        }
        return {
          key: `${w.test}_${w.signal}`,
          label: `${w.signal} (${w.quantity === 'current' ? 'A' : 'V'}) — ${w.test}`,
          net: w.signal,
          test: w.test,
          unit: w.quantity === 'current' ? 'A' : 'V',
          time,
          values,
        };
      })
      .filter((t): t is WaveformTrace => t !== null);
  }, [waveforms]);

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
        </div>
        {traces.length > 0
          ? <WaveformViewer traces={traces} design={design} diagnostics={allDiagnostics} theme={theme} />
          : <p className="muted-copy">No waveform CSVs were generated for this run.</p>}
      </div>
    </div>
  );
}

// The pre-#25 SVG WaveformChart + `formatValue` / `formatTime` helpers lived
// here. They were replaced by the canvas-based, min/max-decimated
// `WaveformViewer` (packages/ui/src/waveform/) which reuses air-ts's
// engineering-notation formatting for value + time labels.

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

function DowngradeRefusalScreen() {
  const diskVersion = useProjectStore((s) => s.diskVersion);
  const db = useProjectStore((s) => s.db);
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    if (!db) return;
    setExporting(true);
    try {
      const records = await exportAllRawRecords(db);
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(records, null, 2));
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute("href", dataStr);
      downloadAnchor.setAttribute("download", `airspice_projects_backup_v${diskVersion}.json`);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
    } catch (e) {
      alert("Failed to export projects: " + (e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      backgroundColor: '#111827',
      color: '#cbd5e1',
      fontFamily: 'system-ui, sans-serif',
      padding: 24,
      textAlign: 'center'
    }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
      <h1 style={{ fontSize: 24, color: '#f8fafc', marginBottom: 8 }}>Database Schema Version Mismatch</h1>
      <p style={{ maxWidth: 500, color: '#94a3b8', marginBottom: 24, lineHeight: 1.5 }}>
        The database on disk is from a newer version of the application (v{diskVersion}). 
        Opening it with this version could cause data corruption. Please update your application.
      </p>
      <button 
        onClick={handleExport}
        disabled={exporting}
        style={{
          padding: '12px 24px',
          fontSize: 14,
          fontWeight: 'bold',
          color: '#fff',
          backgroundColor: '#0ea5a4',
          border: 'none',
          borderRadius: 8,
          cursor: 'pointer',
          transition: 'background-color 0.2s'
        }}
      >
        {exporting ? 'Exporting...' : 'Export Projects to JSON'}
      </button>
    </div>
  );
}

function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const initProjectStore = useProjectStore((s) => s.init);
  const isDowngraded = useProjectStore((s) => s.isDowngraded);
  const initialized = useProjectStore((s) => s.initialized);
  const storageError = useProjectStore((s) => s.storageError);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    void initProjectStore();
  }, [initProjectStore]);

  if (!initialized) {
    return <div className="boot-status" role="status">Opening local workspace...</div>;
  }

  if (storageError) {
    return (
      <div className="boot-status storage-error" role="alert">
        <h1>Local storage unavailable</h1>
        <p>{storageError}</p>
        <p>Allow IndexedDB for this site, then reload. No project data was sent anywhere.</p>
      </div>
    );
  }

  if (isDowngraded) {
    return <DowngradeRefusalScreen />;
  }

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
  return <Landing />;
}

export default App;
