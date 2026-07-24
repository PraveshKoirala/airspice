/**
 * Firmware tab (browser firmware story): renders the CURRENT design's
 * <firmware> section — projects (target MCU / board / framework / language),
 * signal bindings, declarative tasks — plus the deterministic generated source
 * (air-ts `emitFirmware`, the TS port of the Python oracle's firmware.py).
 * Everything is derived live from the design XML; nothing calls a backend.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Cpu, RadioTower } from 'lucide-react';
import {
  parse as parseAir,
  emitFirmware,
  firmwarePlatformioSettings,
  resolveBindings,
} from 'air-ts';
import type {
  FirmwareFile,
  FirmwareOperation,
  FirmwareTask,
  SystemIR,
} from 'air-ts';
import './FirmwarePanel.css';

/** One readable line per declarative task op (presentation only). */
function describeOperation(op: FirmwareOperation): string {
  switch (op['op']) {
    case 'read_adc':
      return `Read ADC via ${op['binding'] || '?'} → ${op['into'] || 'adc_raw'}`;
    case 'convert':
      return `${op['into'] || 'converted'} = ${op['expr'] || '?'}`;
    case 'write_gpio':
      return `Set ${op['pin'] || '?'} ${op['value'] || 'low'}`;
    case 'delay':
      return `Wait ${op['duration'] || '?'}`;
    case 'log':
      return `Log ${op['value'] || '?'}`;
    default: {
      const attrs = Object.entries(op)
        .filter(([k]) => k !== 'op')
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      return attrs ? `${op['op']} (${attrs})` : String(op['op']);
    }
  }
}

function TaskCard({ task }: { task: FirmwareTask }) {
  return (
    <div className="fw-task" data-testid={`fw-task-${task.id}`}>
      <div className="fw-task-head">
        <strong>{task.id}</strong>
        {task.period && <span className="fw-pill">every {task.period}</span>}
      </div>
      <ol className="fw-steps">
        {task.operations.map((op, index) => (
          <li key={index}>{describeOperation(op)}</li>
        ))}
        {task.operations.length === 0 && <li className="muted-copy">No steps declared.</li>}
      </ol>
    </div>
  );
}

export default function FirmwarePanel({ xml }: { xml: string }) {
  // Parse the live XML; mid-edit malformed XML keeps the last good IR so the
  // panel doesn't flicker to the empty state while the user types.
  const lastGoodRef = useRef<SystemIR | null>(null);
  const ir = useMemo<SystemIR | null>(() => {
    if (!xml.trim()) return null;
    try {
      const parsed = parseAir(xml);
      lastGoodRef.current = parsed;
      return parsed;
    } catch {
      return lastGoodRef.current;
    }
  }, [xml]);

  const projects = useMemo(() => (ir ? [...ir.firmware_projects.values()] : []), [ir]);
  const bindings = useMemo(() => (ir ? resolveBindings(ir) : []), [ir]);
  const tasks = useMemo(() => (ir ? [...ir.firmware_tasks.values()] : []), [ir]);
  const files = useMemo<FirmwareFile[]>(() => {
    if (!ir) return [];
    try {
      return emitFirmware(ir);
    } catch {
      return [];
    }
  }, [ir]);
  const pio = useMemo(() => (ir ? firmwarePlatformioSettings(ir) : null), [ir]);

  const hasFirmware = projects.length > 0 || bindings.length > 0 || tasks.length > 0;

  // Generated-source file selector + copy-to-clipboard feedback.
  const [activePath, setActivePath] = useState<string | null>(null);
  const activeFile =
    files.find((f) => f.path === activePath) ??
    files.find((f) => f.kind === 'firmware_source') ??
    files[0] ??
    null;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    if (!activeFile) return;
    try {
      await navigator.clipboard.writeText(activeFile.content);
      setCopied(true);
    } catch {
      // Clipboard API unavailable (permissions / non-secure context): fall
      // back to a transient textarea selection copy.
      const scratch = document.createElement('textarea');
      scratch.value = activeFile.content;
      document.body.appendChild(scratch);
      scratch.select();
      try {
        document.execCommand('copy');
        setCopied(true);
      } finally {
        scratch.remove();
      }
    }
  };

  if (!ir || !hasFirmware) {
    return (
      <div className="empty-state" data-testid="firmware-empty">
        <RadioTower size={20} />
        <h2>No firmware in this design</h2>
        <p>
          Ask the AI to add an MCU and firmware tasks &mdash; for example: &ldquo;add an
          ESP32 that reads the midpoint voltage with its ADC every second and logs
          it&rdquo;. The generated source will appear here.
        </p>
      </div>
    );
  }

  const knownProjectIds = new Set(projects.map((p) => p.id));
  const orphanTasks = tasks.filter((t) => !knownProjectIds.has(t.target));

  return (
    <div className="detail-panel firmware-panel" data-testid="firmware-panel">
      <div className="panel-heading">
        <RadioTower size={18} />
        <div>
          <span className="eyebrow">Firmware</span>
          <h2>
            {projects.length > 0
              ? projects.map((p) => p.id).join(', ')
              : 'Bindings & tasks'}
          </h2>
        </div>
      </div>

      {projects.map((project) => {
        const target = ir.components.get(project.target);
        const projectTasks = tasks.filter((t) => t.target === project.id);
        return (
          <section className="metric-section fw-project" key={project.id} data-testid={`fw-project-${project.id}`}>
            <div className="metric-section-title">
              <strong>
                <Cpu size={14} className="fw-inline-icon" /> {project.id}
              </strong>
              <span className="fw-badges">
                {project.framework && <span className="fw-pill">{project.framework}</span>}
                {project.language && <span className="fw-pill">{project.language}</span>}
              </span>
            </div>
            <div className="fw-facts">
              <div>
                <span>Target MCU</span>
                <strong>
                  {project.target || '—'}
                  {target?.part ? ` (${target.part})` : ''}
                  {!target && project.target ? ' — not in design!' : ''}
                </strong>
              </div>
              <div>
                <span>Board</span>
                <strong>{project.board || pio?.board || '—'}</strong>
              </div>
              {pio && (
                <div>
                  <span>PlatformIO</span>
                  <strong>
                    {pio.platform} / {pio.framework} / {pio.board}
                  </strong>
                </div>
              )}
            </div>
            {projectTasks.length > 0 && (
              <div className="fw-tasks">
                {projectTasks.map((task) => (
                  <TaskCard task={task} key={task.id} />
                ))}
              </div>
            )}
          </section>
        );
      })}

      {orphanTasks.length > 0 && (
        <section className="metric-section fw-project">
          <div className="metric-section-title">
            <strong>Tasks without a project</strong>
            <span className="fw-pill fw-warn">check target=</span>
          </div>
          <div className="fw-tasks">
            {orphanTasks.map((task) => (
              <TaskCard task={task} key={task.id} />
            ))}
          </div>
        </section>
      )}

      {bindings.length > 0 && (
        <section className="metric-section" data-testid="fw-bindings">
          <div className="metric-section-title">
            <strong>Signal bindings</strong>
          </div>
          <table className="fw-bindings-table">
            <thead>
              <tr>
                <th>Signal</th>
                <th>MCU pin</th>
                <th>Peripheral</th>
                <th>Net</th>
              </tr>
            </thead>
            <tbody>
              {bindings.map((binding) => (
                <tr key={binding.id}>
                  <td>
                    <code>{binding.signal || binding.id}</code>
                  </td>
                  <td>
                    {binding.component}
                    {binding.pinName ? `.${binding.pinName}` : ''}
                  </td>
                  <td>
                    {binding.peripheral}
                    {binding.channel ? ` / ${binding.channel}` : ''}
                  </td>
                  <td>
                    <code>{binding.net || '—'}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {files.length > 0 && activeFile && (
        <section className="metric-section fw-source" data-testid="firmware-source">
          <div className="metric-section-title">
            <strong>Generated source</strong>
            <button
              type="button"
              className="fw-copy-btn"
              onClick={handleCopy}
              data-testid="firmware-copy"
              title="Copy to clipboard"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div className="fw-file-tabs" role="tablist">
            {files.map((file) => (
              <button
                type="button"
                key={file.path}
                role="tab"
                aria-selected={file.path === activeFile.path}
                className={`fw-file-tab ${file.path === activeFile.path ? 'active' : ''}`}
                onClick={() => setActivePath(file.path)}
                data-testid={`firmware-file-${file.path.replace(/[^a-zA-Z0-9.-]+/g, '-')}`}
              >
                {file.path}
              </button>
            ))}
          </div>
          <pre className="fw-code" data-testid="firmware-code">
            <code>{activeFile.content}</code>
          </pre>
          <p className="muted-copy fw-note">
            Deterministic template codegen from the declarative &lt;task&gt; steps
            (mirrors the reference compiler). Edit the firmware section in the AIR
            XML &mdash; or ask the AI &mdash; and this source updates live.
          </p>
        </section>
      )}
    </div>
  );
}
