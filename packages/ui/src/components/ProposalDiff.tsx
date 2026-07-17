/**
 * Proposal diff card (issue #18 deliverable 2): shows a Monaco diff of the
 * CURRENT design vs the agent's PROPOSED design, with Apply / Reject. A staged
 * proposal that the design has advanced past shows a "design has changed since
 * this was proposed" badge (post-audit amendment point 3) — Apply then re-runs
 * the full gate (rebase) or surfaces a conflict; it NEVER silently clobbers.
 *
 * Apply routes through the session's `applyProposal`, which calls the design
 * store's `applyValidated` (the single write path, takes a ValidatedDesign).
 * There is no way to write the proposal to the editor from this card except
 * through that gated path.
 */

import React from "react";
import { DiffEditor, type DiffBeforeMount } from "@monaco-editor/react";
import { Check, X, GitBranch, AlertTriangle } from "lucide-react";

const handleBeforeMount: DiffBeforeMount = (monaco) => {
  monaco.editor.defineTheme('premium-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: 'c678dd' },
      { token: 'string', foreground: '98c379' },
      { token: 'number', foreground: 'd19a66' }
    ],
    colors: {
      'editor.background': '#162131',
      'diffEditor.insertedTextBackground': '#14b8a620',
      'diffEditor.removedTextBackground': '#fb718520'
    }
  });
};
import type { UiProposal } from "../agent/useAgentSession";

interface ProposalDiffProps {
  item: UiProposal;
  currentXml: string;
  /** True when the live design version differs from the proposal's baseVersion. */
  stale: boolean;
  theme?: "dark" | "light";
  onApply: () => void;
  onReject: () => void;
}

const ProposalDiff: React.FC<ProposalDiffProps> = ({
  item,
  currentXml,
  stale,
  theme = "dark",
  onApply,
  onReject,
}) => {
  const { proposal, status, note } = item;
  const decided = status === "applied" || status === "rejected";
  // On conflict we still diff, but against the CURRENT doc captured at Apply.
  const original = item.conflictCurrentXml ?? currentXml;

  return (
    <div className={`proposal-card ${status}`} data-testid="proposal-card">
      <div className="proposal-header">
        <GitBranch size={14} />
        <span className="proposal-summary">{proposal.summary}</span>
        {stale && status === "staged" && (
          <span className="proposal-badge stale" data-testid="proposal-stale-badge">
            design has changed since this was proposed
          </span>
        )}
        {status === "applied" && <span className="proposal-badge applied">applied</span>}
        {status === "rejected" && <span className="proposal-badge rejected">rejected</span>}
        {status === "conflict" && (
          <span className="proposal-badge conflict" data-testid="proposal-conflict-badge">
            <AlertTriangle size={12} /> conflict
          </span>
        )}
      </div>

      {note && <p className="proposal-note">{note}</p>}

      <div className="proposal-diff" style={{ border: '1px solid var(--border)', borderRadius: '6px', overflow: 'hidden', boxShadow: '0 4px 12px var(--shadow)' }}>
        <DiffEditor
          height="240px"
          language="xml"
          theme={theme === "dark" ? "premium-dark" : "light"}
          beforeMount={handleBeforeMount}
          original={original}
          modified={proposal.validated.xml}
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

      {!decided && (
        <div className="proposal-actions">
          <button className="apply" onClick={onApply} data-testid="proposal-apply">
            <Check size={14} /> {status === "conflict" ? "Take proposal (re-gate)" : "Apply"}
          </button>
          <button className="reject" onClick={onReject} data-testid="proposal-reject">
            <X size={14} /> Reject
          </button>
        </div>
      )}
    </div>
  );
};

export default ProposalDiff;
