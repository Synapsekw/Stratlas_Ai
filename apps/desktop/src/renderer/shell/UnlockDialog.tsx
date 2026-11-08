import { Dialog, Icon } from '@aio/ui';
import { useId, useState, type SyntheticEvent } from 'react';
import { shell, useShell } from '../shell';

/** Passphrase prompt for an encrypted `.aio` package. */
export function UnlockDialog() {
  const unlock = useShell((s) => s.unlock);
  const opening = useShell((s) => s.opening);
  const [pass, setPass] = useState('');
  const form = useId();
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
    <Dialog
      open
      title="Encrypted package"
      description={<span dir="auto">{name}</span>}
      testId="unlock-dialog"
      hideClose
      onClose={cancel}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={cancel}>
            Cancel
          </button>
          <button type="submit" form={form} className="btn primary" disabled={!pass || busy}>
            {busy ? 'Opening' : 'Open package'}
          </button>
        </>
      }
    >
      <form id={form} style={{ display: 'contents' }} onSubmit={submit}>
        <p className="help" style={{ margin: 0 }}>
          Enter the passphrase you received with this package. It is checked on this workstation and
          never stored.
        </p>
        <input
          className="input"
          type="password"
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
      </form>
    </Dialog>
  );
}
