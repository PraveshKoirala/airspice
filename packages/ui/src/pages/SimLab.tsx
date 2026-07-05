/**
 * /sim-lab — dev-only integration surface for the WASM analog engine (issue #13
 * deliverable 7). Paste a netlist, Run, see the raw table output (final value +
 * point count per vector) plus the streamed stdout/stderr and any structured
 * diagnostic. This is the manual integration test surface before the engine is
 * wired into the main workspace (#14 report pipeline / #15 parity).
 *
 * Worker-only + lazy: `sim-wasm`'s `SimClient` runs the engine ONLY inside its
 * Web Worker; the ~20MB WASM is a lazy Vite chunk that loads on first run, not
 * on page load. This route is registered ONLY under `import.meta.env.DEV` (see
 * App.tsx), so it and its dependency are excluded from the production bundle.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { SimEvent, WaveTable, EngineCapabilities } from "sim-wasm";

const DEFAULT_NETLIST = `* voltage divider (paste any ngspice netlist)
V1 vin 0 DC 5
R1 vin mid 10k
R2 mid 0 10k
.tran 1u 5m
.end`;

interface LogLine {
  stream: "stdout" | "stderr" | "info";
  text: string;
}

// The sim-wasm client is imported lazily so the WASM engine chunk is not pulled
// into this route's initial load; it arrives on the first Run.
async function makeClient() {
  const { SimClient } = await import("sim-wasm");
  return new SimClient();
}

export default function SimLab() {
  const [netlist, setNetlist] = useState(DEFAULT_NETLIST);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [tables, setTables] = useState<WaveTable[]>([]);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [caps, setCaps] = useState<EngineCapabilities | null>(null);
  const clientRef = useRef<Awaited<ReturnType<typeof makeClient>> | null>(null);
  const runIdRef = useRef(0);

  const ensureClient = useCallback(async () => {
    if (!clientRef.current) clientRef.current = await makeClient();
    return clientRef.current;
  }, []);

  const appendLog = useCallback((line: LogLine) => {
    setLogs((prev) => [...prev, line]);
  }, []);

  const onRun = useCallback(async () => {
    setRunning(true);
    setLogs([]);
    setTables([]);
    setDiagnostic(null);
    const id = `sim-lab-${++runIdRef.current}`;
    try {
      const client = await ensureClient();
      if (!caps) setCaps(await client.preload());
      for await (const ev of client.run({ id, netlist }) as AsyncIterable<SimEvent>) {
        if (ev.type === "stdout") appendLog({ stream: "stdout", text: ev.line });
        else if (ev.type === "stderr") appendLog({ stream: "stderr", text: ev.line });
        else if (ev.type === "progress") {
          appendLog({ stream: "info", text: `progress ${ev.pct}%` });
        } else if (ev.type === "error") {
          setDiagnostic(`${ev.diagnostic.code}: ${ev.diagnostic.message} — ${ev.diagnostic.hint}`);
        } else if (ev.type === "result") {
          setTables(ev.tables);
        }
      }
    } catch (err) {
      setDiagnostic(`client error: ${(err as Error).message}`);
    } finally {
      setRunning(false);
    }
  }, [appendLog, caps, ensureClient, netlist]);

  const onCancel = useCallback(() => {
    clientRef.current?.cancel(`sim-lab-${runIdRef.current}`);
    appendLog({ stream: "info", text: "cancel requested (worker terminated + respawned)" });
  }, [appendLog]);

  const rows = useMemo(
    () =>
      tables.map((t) => ({
        name: t.name,
        unit: t.unit,
        points: t.values.length,
        final: t.values.length ? t.values[t.values.length - 1] : NaN,
      })),
    [tables],
  );

  return (
    <div style={{ padding: 24, fontFamily: "monospace", maxWidth: 900 }}>
      <h1>sim-lab (dev)</h1>
      <p style={{ color: "#888" }}>
        WASM ngspice analog engine — worker-only, lazy-loaded.
        {caps
          ? ` engine=${caps.engine}@${caps.engineVersion} ngspice=${caps.ngspiceVersion} control=${String(caps.control)}`
          : " (engine loads on first run)"}
      </p>
      <textarea
        value={netlist}
        onChange={(e) => setNetlist(e.target.value)}
        spellCheck={false}
        rows={12}
        style={{ width: "100%", fontFamily: "monospace", fontSize: 13 }}
        data-testid="netlist-input"
      />
      <div style={{ margin: "12px 0", display: "flex", gap: 8 }}>
        <button onClick={onRun} disabled={running} data-testid="run-btn">
          {running ? "Running…" : "Run"}
        </button>
        <button onClick={onCancel} disabled={!running} data-testid="cancel-btn">
          Cancel
        </button>
      </div>

      {diagnostic && (
        <pre style={{ color: "#c00", whiteSpace: "pre-wrap" }} data-testid="diagnostic">
          {diagnostic}
        </pre>
      )}

      <h2>Result tables</h2>
      <table border={1} cellPadding={4} data-testid="result-table" style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th>vector</th>
            <th>unit</th>
            <th>points</th>
            <th>final</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} style={{ color: "#888" }}>
                (no result yet)
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td>
                <td>{r.unit}</td>
                <td>{r.points}</td>
                <td>{r.final}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <h2>Output ({logs.length})</h2>
      <pre
        style={{ maxHeight: 260, overflow: "auto", background: "#111", color: "#ddd", padding: 8 }}
        data-testid="output-log"
      >
        {logs.map((l, i) => (
          <div key={i} style={{ color: l.stream === "stderr" ? "#f88" : l.stream === "info" ? "#8cf" : "#ddd" }}>
            {l.text}
          </div>
        ))}
      </pre>
    </div>
  );
}
