import type { AgentFixControls } from '@aio/ai';
import { t, useT } from '@aio/ui';
import { useEffect, useRef, useState } from 'react';
import { saveWorkspaceId } from '../screens/settings/workspaceId';
import { bridge, shell, useShell } from '../shell';

/**
 * The agent panel's fix for a provider error, in place (AgentPanel `renderFix`). One error has a
 * fix today (`AiErrorCode` has one value): the Anthropic key is not scoped to a workspace. The
 * card takes the workspace ID (saved to the same setting as Settings, AI providers), tests the
 * connection and, when Anthropic answers, sends the failed message again.
 */
export function AgentFixCard({ retry, dismiss }: AgentFixControls) {
  useT();
  const stored = useShell((s) => s.settings.anthropicWorkspaceId) ?? '';
  const [value, setValue] = useState(stored);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);

  const testAndRetry = async () => {
    if (busy) return;
    const id = (input.current?.value ?? value).trim();
    if (!id) {
      setError(t('agent.fix.workspace.empty'));
      input.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const saveError = await saveWorkspaceId(id);
    if (saveError) {
      setBusy(false);
      setError(saveError);
      input.current?.focus();
      return;
    }
    const r = await bridge.call('ai:testConnection', { provider: 'anthropic' });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    if (!r.value.ok) {
      setError(r.value.message);
      if (r.value.code === 'anthropic-workspace') input.current?.select();
      return;
    }
    await retry();
  };

  return (
    <div className="ag-fix" role="group" aria-label={t('agent.fix.workspace.title')}>
      <b>{t('agent.fix.workspace.title')}</b>
      <p>{t('agent.fix.workspace.text')}</p>
      <label>
        {t('agent.fix.workspace.label')}
        <input
          ref={input}
          value={value}
          placeholder={t('agent.fix.workspace.placeholder')}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error !== null}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void testAndRetry();
          }}
        />
      </label>
      {error && (
        <p className="ag-fix-msg" role="alert">
          {error}
        </p>
      )}
      <div className="ag-fix-acts">
        <button
          type="button"
          className="ag-btn sm primary"
          disabled={busy}
          onClick={() => void testAndRetry()}
        >
          {busy ? t('agent.fix.testing') : t('agent.fix.retry')}
        </button>
        <button
          type="button"
          className="ag-btn link sm"
          onClick={() => {
            shell.getState().openSettings('anthropic-workspace');
          }}
        >
          {t('agent.fix.openSettings')}
        </button>
        <button
          type="button"
          className="ag-btn ghost sm"
          style={{ marginLeft: 'auto' }}
          onClick={dismiss}
        >
          {t('agent.fix.dismiss')}
        </button>
      </div>
    </div>
  );
}
