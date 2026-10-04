import type { AiProvider } from '@aio/schema';
import { Icon } from '@aio/ui';
import { useState } from 'react';
import { bridge, shell, useShell } from '../../shell';

/**
 * Extra rows of a provider in Settings, AI providers: the Anthropic workspace ID (for keys that are
 * not scoped to a workspace) and Test connection, which makes one minimal request and shows the
 * provider's exact answer or error.
 */
export function ProviderConnection({
  provider,
  keyPresent,
}: {
  provider: AiProvider;
  keyPresent: boolean;
}) {
  return (
    <>
      {provider === 'anthropic' && <AnthropicWorkspace />}
      {keyPresent && <TestConnection provider={provider} />}
    </>
  );
}

/** The same rule as `Settings.anthropicWorkspaceId` in @aio/schema; empty clears it. */
const WORKSPACE_ID = /^[A-Za-z0-9_-]{0,128}$/;
const INVALID_WORKSPACE = 'A workspace ID has only letters, digits, _ and -, such as wrkspc_01AbC.';

function AnthropicWorkspace() {
  const stored = useShell((s) => s.settings.anthropicWorkspaceId) ?? '';
  const [value, setValue] = useState(stored);
  const [error, setError] = useState<string | null>(null);
  // Reads the field itself: a handler from the render before the last keystroke still saves it.
  const save = async (raw: string) => {
    const next = raw.trim();
    if (next === stored) return;
    // Checked here as well as in main, so a typo never reaches the stored settings.
    if (!WORKSPACE_ID.test(next)) {
      setError(INVALID_WORKSPACE);
      return;
    }
    const e = await shell.getState().updateSettings({ anthropicWorkspaceId: next });
    setError(e ? INVALID_WORKSPACE : null);
  };
  return (
    <>
      <label className="key">
        <Icon name="layers" size={14} className="faint" />
        <span className="faint">Workspace ID</span>
        <input
          className="input"
          aria-label="Anthropic workspace ID"
          placeholder="Only for keys not scoped to a workspace, such as wrkspc_01..."
          spellCheck={false}
          autoComplete="off"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onBlur={(e) => void save(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save(e.currentTarget.value);
          }}
        />
      </label>
      {error && (
        <p className="prov-err" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

interface Result {
  ok: boolean;
  message: string;
}

function TestConnection({ provider }: { provider: AiProvider }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const run = async () => {
    setBusy(true);
    setResult(null);
    const r = await bridge.call('ai:testConnection', { provider });
    setBusy(false);
    setResult(
      r.ok ? { ok: r.value.ok, message: r.value.message } : { ok: false, message: r.error },
    );
  };
  return (
    <>
      <div className="key">
        <button
          type="button"
          className="btn sm"
          disabled={busy}
          onClick={() => {
            void run();
          }}
        >
          {busy ? 'Testing' : 'Test connection'}
        </button>
        <span className="faint">Sends one short message to check the key and model.</span>
      </div>
      {result && (
        <p
          className={result.ok ? 'prov-ok' : 'prov-err'}
          role={result.ok ? 'status' : 'alert'}
          data-testid={`test-result-${provider}`}
        >
          {result.message}
        </p>
      )}
    </>
  );
}
