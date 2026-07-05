import React, { useState, useRef, useEffect } from 'react';
import { Send, Sparkles, User, Bot, Info, Square, Loader2 } from 'lucide-react';
import type { MockFixture, NetworkProviderId } from 'agent';
import { useAgentSession } from '../agent/useAgentSession';
import { useDesignStore } from '../agent/designStore';
import { useAgentSettings } from '../agent/agentSettings';
import ProposalDiff from './ProposalDiff';

/**
 * AI Assistant panel (issue #18): the browser agent REPL. It drives the client-
 * side tool runtime — the model (BYOK, #17) proposes designs, the deterministic
 * gate validates them, and staged proposals appear here as Monaco diffs the user
 * Applies or Rejects. Budgets (iterations/tokens/time) are surfaced live; a Stop
 * button aborts the provider stream AND cancels any in-flight simulation.
 *
 * This REPLACES the old backend `/agent/chat` round-trip (App.tsx handleCommand):
 * there is no server in the loop, and no design reaches the editor except through
 * the store's `applyValidated` (the single write path).
 */

interface ChatReplProps {
  /** Provider selection (mirrors Settings). "mock" replays a fixture. */
  provider: NetworkProviderId | 'mock';
  model?: string;
  maxTokensPerTurn?: number;
  /** Fixture for the mock provider (dev/demo/CI-parity flows). */
  mockFixture?: MockFixture;
  theme?: 'dark' | 'light';
}

const ChatRepl: React.FC<ChatReplProps> = ({ provider, model, maxTokensPerTurn, mockFixture, theme = 'dark' }) => {
  const { transcript, proposals, budget, running, send, stop, applyProposal, rejectProposal } = useAgentSession();
  const currentXml = useDesignStore((s) => s.xml);
  const currentVersion = useDesignStore((s) => s.version);
  const autoApply = useAgentSettings((s) => s.autoApply);
  const setAutoApply = useAgentSettings((s) => s.setAutoApply);

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [transcript, proposals]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || running) return;
    const message = input.trim();
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    await send(message, {
      provider,
      ...(model ? { model } : {}),
      ...(maxTokensPerTurn ? { maxTokensPerTurn } : {}),
      ...(mockFixture ? { mockFixture } : {}),
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="chat-repl">
      <div className="chat-header">
        <Sparkles size={16} className="sparkle-icon" />
        <span>AI Assistant</span>
        <label className="auto-apply-toggle" title="Auto-apply staged proposals (still runs the full validation gate)">
          <input
            type="checkbox"
            checked={autoApply}
            onChange={(e) => setAutoApply(e.target.checked)}
            data-testid="auto-apply-toggle"
          />
          Auto-apply
        </label>
      </div>

      {budget && (
        <div className="budget-meter" data-testid="budget-meter">
          <span title="provider turns">iter {budget.iterations}/{budget.limits.maxIterations}</span>
          <span title="tokens">tok {budget.tokens}/{budget.limits.maxTokens}</span>
          <span title="wall time">{Math.round(budget.elapsedMs / 1000)}s/{Math.round(budget.limits.maxWallMs / 1000)}s</span>
        </div>
      )}

      <div className="chat-messages" ref={scrollRef}>
        {transcript.length === 0 && (
          <div className="message assistant">
            <div className="message-icon"><Bot size={14} /></div>
            <div className="message-content">Hello! Describe a circuit and I will design, validate, and simulate it — every change is staged for your review.</div>
          </div>
        )}
        {transcript.map((msg) => (
          <div key={msg.id} className={`message ${msg.role}`}>
            <div className="message-icon">
              {msg.role === 'user' ? <User size={14} /> : msg.role === 'system' ? <Info size={14} /> : <Bot size={14} />}
            </div>
            <div className="message-content" style={{ textAlign: 'left', whiteSpace: 'pre-wrap' }}>{msg.content}</div>
          </div>
        ))}

        {proposals.map((item) => (
          <ProposalDiff
            key={item.proposal.id}
            item={item}
            currentXml={currentXml}
            stale={item.proposal.baseVersion !== currentVersion}
            theme={theme}
            onApply={() => applyProposal(item.proposal)}
            onReject={() => rejectProposal(item.proposal)}
          />
        ))}

        {running && (
          <div className="message assistant loading">
            <div className="message-icon"><Loader2 size={14} className="animate-spin" /></div>
            <div className="message-content">Working...</div>
          </div>
        )}
      </div>

      <form className="chat-input-area" onSubmit={handleSubmit}>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
          }}
          onKeyDown={handleKeyDown}
          placeholder="Ask AI to 'build a 3.3V divider from 9V and probe the midpoint'..."
          disabled={running}
          rows={1}
          style={{ resize: 'none' }}
        />
        {running ? (
          <button type="button" className="stop" onClick={stop} data-testid="agent-stop" title="Stop">
            <Square size={16} />
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()} data-testid="agent-send">
            <Send size={16} />
          </button>
        )}
      </form>
    </div>
  );
};

export default ChatRepl;
