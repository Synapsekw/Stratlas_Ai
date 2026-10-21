import type { WebsiteUpdateStatus } from '@aio/schema';
import { formatBytes, Icon, Switch } from '@aio/ui';
import { useState, type SubmitEvent } from 'react';
import { bridge, shell, useShell } from '../shell';
import { ReleaseNotesView } from '../screens/settings/ReleaseNotes';
import { useWebsiteUpdates, websiteUpdates } from './session';

const PHASE: Record<WebsiteUpdateStatus['phase'], string> = {
  'signed-out': 'Sign in to check for website updates.',
  idle: 'No update is waiting. Checks run at startup and every six hours.',
  checking: 'Checking for app and processing kit updates.',
  downloading: 'Downloading in the background. You can keep working.',
  verifying: 'Verifying the app and processing kit before they are ready.',
  ready: 'Updates are verified and ready. Restart when your work is finished.',
  applying: 'Applying the verified update.',
  error: 'The update could not finish. Check the connection and retry.',
  paused: 'Automatic updates are paused.',
  unsupported: 'Automatic installation is unavailable for this copy.',
};

export function WebsiteUpdatesPanel() {
  const s = useWebsiteUpdates((state) => state.status);
  const busy = useWebsiteUpdates((state) => state.busy);
  const actionError = useWebsiteUpdates((state) => state.error);
  const offline = useShell((state) => state.settings.offlineOnly === true);
  const enabled = useShell((state) => state.settings.websiteAutoUpdate !== false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transferring =
    s?.phase === 'checking' || s?.phase === 'downloading' || s?.phase === 'verifying';
  const working =
    (busy && !transferring) || (signingIn && !s?.accountEmail) || s?.phase === 'applying';
  const blocked = offline || !enabled || working;
  const signIn = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked || !email.trim() || !password) return;
    setSigningIn(true);
    setError(null);
    try {
      const r = await bridge.call('websiteUpdate:signIn', { email: email.trim(), password });
      if (!r.ok) setError(r.error);
      else if (!r.value.ok)
        setError(r.value.error ?? 'Sign-in did not finish. Check your account and try again.');
    } finally {
      setPassword('');
      setSigningIn(false);
    }
  };
  const toggle = async (value: boolean) => {
    setError(null);
    const message = await shell.getState().updateSettings({ websiteAutoUpdate: value });
    if (message) setError(message);
  };
  const message = error ?? actionError ?? s?.error;
  return (
    <div className="opt-card website-updates" data-testid="website-updates">
      <div className="oc-head">
        <div>
          <b>Automatic website updates</b>
          <span>
            App and processing kit updates download in the background. You choose when to restart.
          </span>
        </div>
        <Switch
          label="Automatic website updates"
          checked={enabled}
          disabled={offline || working}
          onChange={(value) => void toggle(value)}
        />
      </div>
      {s && (
        <p className="help">
          Installed app {s.currentAppVersion} · Processing kit{' '}
          {s.currentPipelineVersion ?? 'not installed'}
        </p>
      )}
      {offline && (
        <p className="help" role="status">
          Offline-only is on in Privacy and cloud. Account sign-in, checks and downloads are
          blocked. Verified updates can still be applied.
        </p>
      )}
      {s?.unsupportedReason && (
        <p className="help" data-testid="website-update-limitation">
          {s.unsupportedReason} Use a signed installer below to update manually.
        </p>
      )}
      {s?.accountEmail ? (
        <div className="oc-row website-update-actions">
          <span>Signed in as {s.accountEmail}</span>
          <button
            type="button"
            className="btn sm ghost"
            disabled={working}
            onClick={() => void websiteUpdates.getState().command('signOut')}
          >
            Sign out
          </button>
        </div>
      ) : (
        <form className="oc-body" onSubmit={(event) => void signIn(event)}>
          <p className="help">
            Use your Quadrion website account. Your password is used only to sign in. This computer
            keeps refresh credentials in the operating system vault.
          </p>
          <label className="oc-field">
            <span>Website account email</span>
            <input
              className="input"
              type="email"
              autoComplete="username"
              required
              maxLength={320}
              disabled={blocked}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
          </label>
          <label className="oc-field">
            <span>Website account password</span>
            <input
              className="input"
              type="password"
              autoComplete="off"
              required
              maxLength={4096}
              disabled={blocked}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
          </label>
          <div className="oc-row">
            <button
              type="submit"
              className="btn sm"
              disabled={blocked || !email.trim() || !password}
            >
              {signingIn ? 'Signing in' : 'Sign in'}
            </button>
          </div>
        </form>
      )}
      <p className="help" role="status">
        {s ? PHASE[s.phase] : 'Loading website update status.'}
      </p>
      {(['app', 'pipeline'] as const).map((key) => {
        const component = s?.[key];
        if (!component) return null;
        const name = key === 'app' ? 'App' : 'Processing kit';
        return (
          <div className="oc-body" key={key}>
            <div className="oc-row website-update-actions">
              <b>
                {name} {component.version}
              </b>
              <span className="faint">
                {component.verified
                  ? 'Verified'
                  : `${formatBytes(component.received)} of ${formatBytes(component.total)}`}
              </span>
            </div>
            <progress
              aria-label={`${name} download`}
              max={component.total}
              value={component.received}
            />
            {component.notes && (
              <details className="oc-notes">
                <summary>
                  What is new in {name.toLowerCase()} {component.version}
                </summary>
                <ReleaseNotesView markdown={component.notes} />
              </details>
            )}
          </div>
        );
      })}
      <div className="oc-row website-update-actions">
        <button
          type="button"
          className="btn sm"
          disabled={
            blocked || transferring || !enabled || !s?.accountEmail || !!s.unsupportedReason
          }
          onClick={() => void websiteUpdates.getState().command('check')}
        >
          <Icon name="refresh" size={14} />
          {s?.phase === 'error' ? 'Retry update' : 'Check for website updates'}
        </button>
        {s?.phase === 'ready' && (
          <button
            type="button"
            className="btn sm primary"
            disabled={working || !s.restartAvailable}
            onClick={() => void websiteUpdates.getState().command('restart')}
          >
            Restart and update
          </button>
        )}
        {s?.recoveryAvailable && (
          <button
            type="button"
            className="btn sm"
            disabled={working}
            onClick={() => void websiteUpdates.getState().command('rollbackKit')}
          >
            Return to previous processing kit
          </button>
        )}
      </div>
      {s?.restartReason && <p className="help">{s.restartReason}</p>}
      {message && (
        <p className="prov-err" role="alert" data-testid="website-update-error">
          {message}
        </p>
      )}
    </div>
  );
}

/** Lives in the sidebar footer so a ready update never covers the spatial workspace. */
export function WebsiteUpdateNotice() {
  const ready = useWebsiteUpdates((state) => state.status?.phase === 'ready');
  if (!ready) return null;
  return (
    <button
      type="button"
      className="nav-item"
      data-testid="website-update-ready"
      aria-label="Updates ready. View update details"
      title="Updates ready. View update details"
      onClick={() => {
        shell.getState().openSettingsPage('about');
      }}
    >
      <Icon name="download" />
      <span className="lbl">Updates ready</span>
      <span className="tip">View update details</span>
    </button>
  );
}
