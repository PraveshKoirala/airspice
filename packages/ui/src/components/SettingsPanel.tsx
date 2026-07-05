import React, { useMemo, useState } from 'react';
import { KeyRound, ShieldAlert, Eraser, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import {
  KeyVault,
  MODEL_CATALOG,
  DEFAULT_TOKEN_BUDGET,
  createProvider,
  keyVaultNoticeFor,
  type NetworkProviderId,
} from 'agent';

/**
 * BYOK settings panel (issue #17 deliverables 3 & 4).
 *
 * Provider picker, model picker (curated list + free-text override), key entry
 * with `validateKey` feedback, token-budget default, a masked display + Clear
 * button, and the verbatim security notice. The key lives ONLY in the browser's
 * localStorage via `KeyVault`; it is read solely to run `validateKey`, which
 * calls the provider directly (no server, ADR 0008). The malformed-tool-call
 * session counter (post-audit amendment) is surfaced here too.
 */

const PROVIDERS: { id: NetworkProviderId; label: string }[] = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Gemini' },
];

type ValidateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok'; detail: string }
  | { status: 'error'; detail: string };

interface SettingsPanelProps {
  /** Malformed-tool-call events observed this session (recovery-ladder counter). */
  malformedToolCallCount?: number;
  /** The provider the agent panel uses (mock = keyless demo). */
  agentProvider?: NetworkProviderId | 'mock';
  /** The model the agent panel uses. */
  agentModel?: string | undefined;
  /** Notify the workspace that the agent provider changed. */
  onAgentProviderChange?: (provider: NetworkProviderId | 'mock') => void;
  /** Notify the workspace that the agent model changed. */
  onAgentModelChange?: (model: string | undefined) => void;
}

const vault = new KeyVault();

const SettingsPanel: React.FC<SettingsPanelProps> = ({
  malformedToolCallCount = 0,
  onAgentProviderChange,
  onAgentModelChange,
}) => {
  const [provider, setProvider] = useState<NetworkProviderId>('anthropic');
  const catalog = MODEL_CATALOG[provider];
  const [model, setModel] = useState<string>(catalog.defaultModel);
  const [freeTextModel, setFreeTextModel] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [tokenBudget, setTokenBudget] = useState<number>(DEFAULT_TOKEN_BUDGET);
  const [validate, setValidate] = useState<ValidateState>({ status: 'idle' });
  const [storedMask, setStoredMask] = useState<string>(() => vault.masked(provider));

  const notice = useMemo(() => keyVaultNoticeFor(provider), [provider]);

  const onProviderChange = (next: NetworkProviderId) => {
    setProvider(next);
    setModel(MODEL_CATALOG[next].defaultModel);
    setFreeTextModel('');
    setKeyInput('');
    setValidate({ status: 'idle' });
    setStoredMask(vault.masked(next));
    // Drive the agent panel to this provider + its default model.
    onAgentProviderChange?.(next);
    onAgentModelChange?.(MODEL_CATALOG[next].defaultModel);
  };

  const effectiveModel = freeTextModel.trim() !== '' ? freeTextModel.trim() : model;

  const handleSaveKey = () => {
    vault.set(provider, keyInput);
    setStoredMask(vault.masked(provider));
    setKeyInput('');
    setValidate({ status: 'idle' });
  };

  const handleClearKey = () => {
    vault.clear(provider);
    setStoredMask('');
    setKeyInput('');
    setValidate({ status: 'idle' });
  };

  const handleValidate = async () => {
    // Validate the key the user just typed, or the stored one if the field is
    // empty. The raw key is read here ONLY to hand to the direct provider call.
    const key = keyInput.trim() !== '' ? keyInput.trim() : vault.get(provider);
    if (!key) {
      setValidate({ status: 'error', detail: 'Enter a key first.' });
      return;
    }
    setValidate({ status: 'checking' });
    try {
      const client = createProvider(provider, { apiKey: key, model: effectiveModel });
      const result = await client.validateKey(key);
      // `result.detail` is provider-produced and already redacted; never contains the key.
      setValidate(
        result.ok
          ? { status: 'ok', detail: result.detail }
          : { status: 'error', detail: result.detail },
      );
    } catch (error) {
      setValidate({ status: 'error', detail: `Validation failed: ${(error as Error).message}` });
    }
  };

  return (
    <div className="detail-panel settings-panel">
      <div className="panel-heading">
        <KeyRound size={18} />
        <div>
          <span className="eyebrow">Agent</span>
          <h2>Provider &amp; API key (BYOK)</h2>
        </div>
      </div>

      <div className="settings-grid">
        <label className="settings-field">
          <span>Provider</span>
          <select
            value={provider}
            onChange={(e) => onProviderChange(e.target.value as NetworkProviderId)}
            data-testid="provider-picker"
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </label>

        <label className="settings-field">
          <span>Model</span>
          <select
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              if (freeTextModel.trim() === '') onAgentModelChange?.(e.target.value);
            }}
            disabled={freeTextModel.trim() !== ''}
            data-testid="model-picker"
          >
            {catalog.models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>

        <label className="settings-field">
          <span>Model override (free text)</span>
          <input
            type="text"
            placeholder="e.g. a newly released model id"
            value={freeTextModel}
            onChange={(e) => {
              setFreeTextModel(e.target.value);
              onAgentModelChange?.(e.target.value.trim() !== '' ? e.target.value.trim() : model);
            }}
            data-testid="model-override"
          />
        </label>

        <label className="settings-field">
          <span>Token budget (default)</span>
          <input
            type="number"
            min={256}
            step={256}
            value={tokenBudget}
            onChange={(e) => setTokenBudget(Number(e.target.value) || DEFAULT_TOKEN_BUDGET)}
            data-testid="token-budget"
          />
        </label>
      </div>

      <div className="settings-key">
        <label className="settings-field">
          <span>API key</span>
          <input
            type="password"
            autoComplete="off"
            placeholder={storedMask ? `Stored: ${storedMask}` : 'Paste your key'}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            data-testid="key-input"
          />
        </label>
        <div className="settings-key-actions">
          <button type="button" onClick={handleSaveKey} disabled={keyInput.trim() === ''} data-testid="save-key">
            Save key
          </button>
          <button type="button" onClick={handleValidate} data-testid="validate-key">
            {validate.status === 'checking' ? <Loader2 size={14} className="animate-spin" /> : 'Validate'}
          </button>
          <button type="button" className="danger" onClick={handleClearKey} disabled={!storedMask} data-testid="clear-key">
            <Eraser size={14} /> Clear
          </button>
        </div>
      </div>

      {storedMask && (
        <div className="settings-stored" data-testid="stored-mask">
          Stored key: <code>{storedMask}</code>
        </div>
      )}

      {validate.status === 'ok' && (
        <div className="settings-validate ok" data-testid="validate-ok">
          <CheckCircle2 size={14} /> {validate.detail}
        </div>
      )}
      {validate.status === 'error' && (
        <div className="settings-validate error" data-testid="validate-error">
          <XCircle size={14} /> {validate.detail}
        </div>
      )}

      <div className="settings-notice" data-testid="key-notice">
        <ShieldAlert size={16} />
        <p>{notice}</p>
      </div>

      <div className="settings-counter" data-testid="malformed-counter">
        Malformed tool calls this session: <strong>{malformedToolCallCount}</strong>
      </div>
    </div>
  );
};

export default SettingsPanel;
