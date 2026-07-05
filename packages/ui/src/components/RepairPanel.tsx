/**
 * The autonomous-repair panel (issue #19 deliverable 2): the flagship demo's UI.
 *
 * Point it at a broken design and press Run: it drives the client-side repair
 * loop (simulate → diagnose → patch → re-simulate) and renders a live TIMELINE
 * of iterations — each row shows the diagnosis, the applied patch as a Monaco
 * DIFF, and the resulting sim/validation state. A live status line and a Stop
 * button are always visible while running. When the loop ends, the final outcome
 * is rendered DISTINCTLY per stop condition (fixed / max-iterations / no-progress
 * / budget / no-fix / provider-error / stopped).
 *
 * Every applied patch reached the editor through the design store's single write
 * path (a gated ValidatedDesign) — the panel never writes design state itself.
 */

import React from "react";
import { DiffEditor } from "@monaco-editor/react";
import {
  Zap,
  Play,
  Square,
  Check,
  AlertTriangle,
  RefreshCw,
  Repeat,
  Ban,
  Clock,
  XCircle,
  StopCircle,
  CircleSlash,
} from "lucide-react";
import type { MockFixture, NetworkProviderId, RepairStopReason } from "agent";
import { useRepairSession, type RepairOutcome, type RepairTimelineRow } from "../agent/useRepairSession";

interface RepairPanelProps {
  provider: NetworkProviderId | "mock";
  model?: string;
  maxTokensPerTurn?: number;
  maxIterations?: number;
  mockFixture?: MockFixture;
  theme?: "dark" | "light";
}

const RepairPanel: React.FC<RepairPanelProps> = ({
  provider,
  model,
  maxTokensPerTurn,
  maxIterations,
  mockFixture,
  theme = "dark",
}) => {
  const { timeline, outcome, running, status, start, stop, reset } = useRepairSession();

  const onRun = () => {
    void start({
      provider,
      ...(model ? { model } : {}),
      ...(maxTokensPerTurn ? { maxTokensPerTurn } : {}),
      ...(maxIterations ? { maxIterations } : {}),
      ...(mockFixture ? { mockFixture } : {}),
    });
  };

  return (
    <div className="detail-panel repair-panel" data-testid="repair-panel">
      <div className="panel-heading">
        <Zap size={18} />
        <div>
          <span className="eyebrow">Autonomous repair</span>
          <h2>simulate → diagnose → patch → re-simulate</h2>
        </div>
        <div className="repair-controls">
          {running ? (
            <button className="repair-stop" onClick={stop} data-testid="repair-stop" title="Stop">
              <Square size={14} /> Stop
            </button>
          ) : (
            <>
              <button className="repair-run" onClick={onRun} data-testid="repair-run" title="Run autonomous repair">
                <Play size={14} /> Run repair
              </button>
              {(timeline.length > 0 || outcome) && (
                <button className="repair-reset" onClick={reset} data-testid="repair-reset" title="Clear">
                  <RefreshCw size={14} /> Clear
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {running && (
        <div className="repair-status" data-testid="repair-status">
          <RefreshCw size={13} className="animate-spin" /> {status || "Working…"}
        </div>
      )}

      {timeline.length === 0 && !outcome && !running && (
        <p className="muted-copy">
          The agent will diagnose the current design, propose a fix through the validation gate, apply
          it, and re-simulate — repeating until the constraints pass or it reaches a stop condition.
          Every fix is staged behind the gate and applied via the single write path.
        </p>
      )}

      <div className="repair-timeline" data-testid="repair-timeline">
        {timeline
          .slice()
          .sort((a, b) => a.index - b.index)
          .map((row) => (
            <TimelineRow key={row.index} row={row} theme={theme} />
          ))}
      </div>

      {outcome && <OutcomeBanner outcome={outcome} />}
    </div>
  );
};

/** One iteration row: diagnosis → patch diff → sim/validation result. */
function TimelineRow({ row, theme }: { row: RepairTimelineRow; theme: "dark" | "light" }) {
  const evaluation = row.evaluation;
  const errorCount = evaluation ? evaluation.validationErrors.length : 0;
  const failing = evaluation ? evaluation.failingAssertions.length : 0;

  return (
    <div className="repair-iteration" data-testid={`repair-iteration-${row.index}`}>
      <div className="repair-iteration-header">
        <span className="repair-iteration-index">Iteration {row.index + 1}</span>
        {evaluation && (
          <span className="repair-iteration-diag">
            {errorCount > 0 && <span className="pill error">{errorCount} validation error(s)</span>}
            {failing > 0 && <span className="pill error">{failing} failing assertion(s)</span>}
            {evaluation.topologyFirst && (
              <span className="pill warning" title="Terminal convergence — topology first (#45)">
                topology first
              </span>
            )}
          </span>
        )}
      </div>

      {/* Diagnosis — the model's reasoning this round. */}
      {row.diagnosis && (
        <div className="repair-diagnosis">
          <span className="repair-section-label">Diagnosis</span>
          <p>{row.diagnosis}</p>
        </div>
      )}

      {/* The failing-assertion / validation summary this round diagnosed from. */}
      {evaluation && (errorCount > 0 || failing > 0) && (
        <div className="repair-diagnostics">
          {evaluation.validationErrors.slice(0, 6).map((d, i) => (
            <div className="diagnostic error" key={`${d.code}-${i}`}>
              <strong>{d.code}</strong>
              <span>{d.message}</span>
            </div>
          ))}
          {evaluation.failingAssertions.slice(0, 6).map((a, i) => (
            <div className="diagnostic error" key={`assert-${i}`}>
              <span>{a}</span>
            </div>
          ))}
        </div>
      )}

      {/* The applied patch, as a Monaco diff (before → after). */}
      {row.appliedStep && (
        <div className="repair-patch">
          <div className="repair-section-label">
            <Check size={13} /> Applied patch — {row.appliedStep.reasoningSummary}
          </div>
          <div className="repair-diff">
            <DiffEditor
              height="200px"
              language="xml"
              theme={theme === "dark" ? "vs-dark" : "light"}
              original={row.appliedStep.previousXml}
              modified={row.appliedStep.design.xml}
              options={{
                renderSideBySide: true,
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 12,
                scrollBeyondLastLine: false,
                automaticLayout: true,
              }}
            />
          </div>
        </div>
      )}

      {/* Sim/validation result of this round's design (before any patch). */}
      {evaluation && (
        <div className="repair-result">
          <span className="repair-section-label">Simulation</span>
          {evaluation.passes ? (
            <span className="status-pill passed">constraints pass</span>
          ) : evaluation.report ? (
            <span className="status-pill failed">assertions failing</span>
          ) : (
            <span className="status-pill failed">does not validate yet</span>
          )}
        </div>
      )}
    </div>
  );
}

/** The DISTINCT final-outcome banner — one visual per stop condition. */
function OutcomeBanner({ outcome }: { outcome: RepairOutcome }) {
  const v = outcomeVisual(outcome.reason);
  return (
    <div className={`repair-outcome ${v.tone}`} data-testid="repair-outcome" data-reason={outcome.reason}>
      <div className="repair-outcome-icon">{v.icon}</div>
      <div className="repair-outcome-body">
        <strong>{v.title}</strong>
        <p>{outcome.message}</p>
        <span className="repair-outcome-meta">
          {outcome.iterations} iteration(s) · {outcome.totalTokens} tokens
        </span>
      </div>
    </div>
  );
}

/** Map each stop reason to a DISTINCT icon + tone + title. */
function outcomeVisual(reason: RepairStopReason): {
  icon: React.ReactNode;
  tone: string;
  title: string;
} {
  switch (reason) {
    case "fixed":
      return { icon: <Check size={18} />, tone: "success", title: "Fixed" };
    case "max_iterations":
      return { icon: <Repeat size={18} />, tone: "warning", title: "Not fixed — iteration limit reached" };
    case "no_progress":
      return { icon: <CircleSlash size={18} />, tone: "warning", title: "Not fixed — no progress (same diagnostics)" };
    case "budget_exhausted":
      return { icon: <Clock size={18} />, tone: "warning", title: "Not fixed — budget exhausted" };
    case "no_fix_proposed":
      return { icon: <Ban size={18} />, tone: "warning", title: "Not fixed — no gate-passing fix produced" };
    case "provider_error":
      return { icon: <XCircle size={18} />, tone: "error", title: "Not fixed — provider error" };
    case "stopped":
      return { icon: <StopCircle size={18} />, tone: "muted", title: "Stopped" };
    case "error":
      return { icon: <AlertTriangle size={18} />, tone: "error", title: "Not fixed — unexpected error" };
  }
}

export default RepairPanel;
