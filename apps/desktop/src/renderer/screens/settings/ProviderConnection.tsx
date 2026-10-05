import type { AiProvider } from '@aio/schema';
import { Icon, t } from '@aio/ui';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { bridge, shell, useShell } from '../../shell';
import { saveWorkspaceId } from './workspaceId';

/**
 * Extra rows of a provider in Settings, AI providers: the Anthropic workspace ID (for keys that are
 * not scoped to a workspace) and Test connection, which makes one minimal request and shows the
 * provider's exact answer or error. When the answer is the workspace error, or the agent panel
 * sent the person here for it, the workspace ID field takes the focus.
 */
export function ProviderConnection({
  provider,
  keyPresent,
}: {
  provider: AiProvider;
  keyPresent: boolean;
}) {
  const workspaceRef = useRef<HTMLInputElement>(null);
  // "Open AI settings" in the agent panel's workspace card asks for the field.
  const focus = useShell((s) => s.settingsFocus);
  const asked = provider === 'anthropic' && focus === 'anthropic-workspace';
  const [needed, setNeeded] = useState(asked);
  const focusWorkspace = () => {
    const el = workspaceRef.current;
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    el.select();
  };
  useEffect(() => {
    if (!asked) return;
    focusWorkspace();
    shell.getState().clearSettingsFocus();
  }, [asked]);
  return (
    <>
      {provider === 'anthropic' && (
        <AnthropicWorkspace
          inputRef={workspaceRef}
          needed={needed}
          onSaved={() => {
            setNeeded(false);
          }}
        />
      )}
      {keyPresent && (
        <TestConnection
          provider={provider}
          onWorkspaceError={() => {
            setNeeded(true);
            focusWorkspace();
          }}
        />
      )}
    </>
  );
}

function AnthropicWorkspace({
  inputRef,
  needed,
  onSaved,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  /** Anthropic asked for the workspace ID (a test or the agent failed without it). */
  needed: boolean;
  onSaved: () => void;
}) {
  const stored = useShell((s) => s.settings.anthropicWorkspaceId) ?? '';
  const [value, setValue] = useState(stored);
  const [error, setError] = useState<string | null>(null);
  // Reads the field itself: a handler from the render before the last keystroke still saves it.
  const save = async (raw: string) => {
    if (raw.trim() === stored) return;
    const e = await saveWorkspaceId(raw);
    setError(e);
    if (!e && raw.trim()) onSaved();
  };
  return (
    <>
      <label className="key">
        <Icon name="layers" size={14} className="faint" />
        <span className="faint">Workspace ID</span>
        <input
          ref={inputRef}
          className="input"
          aria-label="Anthropic workspace ID"
          aria-invalid={Boolean(error) || (needed && !value.trim())}
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
      {error ? (
        <p className="prov-err" role="alert">
          {error}
        </p>
      ) : (
        needed &&
        !value.trim() && (
          <p className="prov-err" role="status" data-testid="workspace-needed">
            {t('settings.ai.workspaceNeeded')}
          </p>
        )
      )}
    </>
  );
}

interface Result {
  ok: boolean;
  message: string;
}

function TestConnection({
  provider,
  onWorkspaceError,
}: {
  provider: AiProvider;
  /** The provider answered that the key needs a workspace ID. */
  onWorkspaceError: () => void;
}) {
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
    if (r.ok && r.value.code === 'anthropic-workspace') onWorkspaceError();
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
