import { Icon, useFocusTrap } from '@aio/ui';
import { useRef, useState, type SyntheticEvent } from 'react';
import { shell, useShell } from '../shell';

/** Passphrase prompt for an encrypted `.aio` package. */
export function UnlockDialog() {
  const unlock = useShell((s) => s.unlock);
  const opening = useShell((s) => s.opening);
  const [pass, setPass] = useState('');
  const dlg = useRef<HTMLFormElement>(null);
  useFocusTrap(dlg, unlock !== null);
  if (!unlock) return null;
  const name = unlock.path.split(/[\\/]/).pop() ?? unlock.path;
  const busy = opening === unlock.path;

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    if (!pass || busy) return;
    void shell.getState().openProject(unlock.path, pass);
  };
  const cancel = () => {
    setPass('');
    shell.getState().cancelUnlock();
  };

  return (
    <div
      className="dlg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <form
        ref={dlg}
        className="dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unlock-title"
        onSubmit={submit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancel();
        }}
      >
        <div className="dlg-h">
          <Icon name="key" size={16} />
          <h2 id="unlock-title">Encrypted package</h2>
          <span className="sub">{name}</span>
        </div>
        <div className="dlg-b">
          <p className="help" style={{ margin: 0 }}>
            Enter the passphrase you received with this package. It is checked on this workstation
            and never stored.
          </p>
          <input
            className="input"
            type="password"
            autoFocus
            aria-label="Passphrase"
            data-testid="passphrase"
            value={pass}
            onChange={(e) => {
              setPass(e.target.value);
            }}
          />
          <p className="notice warn" role="status" style={{ margin: 0 }}>
            <Icon name="warn" size={14} />
            {unlock.error}
          </p>
        </div>
        <div className="dlg-f">
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={cancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!pass || busy}>
            {busy ? 'Opening' : 'Open package'}
          </button>
        </div>
      </form>
    </div>
  );
}
