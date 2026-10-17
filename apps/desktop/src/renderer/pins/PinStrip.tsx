import { Button, t } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useId, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { mediaItem } from './pinModel';
import { mediaName, pinSession, usePinPicking, usePinSession, type PinSession } from './placePin';
import './pins.css';

/*
 * The placing strip (pinned media design): one line bottom-centre over the stage with the step's
 * sentence, a note, the eye height once the pin is down, and Done and Cancel. It also arms the
 * clicks the step asks for (`usePinPicking`), so mount this one component and nothing else.
 */

/** The stage element (the 3D view, the map and the split live in it) while it is mounted. */
function useStageEl(watch: boolean): HTMLElement | null {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!watch) return;
    const find = (): void => {
      setEl(document.querySelector<HTMLElement>('.stage'));
    };
    find();
    const mo = new MutationObserver(find);
    mo.observe(document.querySelector('.main') ?? document.body, {
      childList: true,
      subtree: true,
    });
    return () => {
      mo.disconnect();
    };
  }, [watch]);
  return watch ? el : null;
}

export function PinStrip({ store = pinSession }: { store?: PinSession }): ReactElement | null {
  usePinPicking(store);
  const target = usePinSession((s) => s.target, store);
  const step = usePinSession((s) => s.step, store);
  const note = usePinSession((s) => s.note, store);
  const error = usePinSession((s) => s.error, store);
  const eyeM = usePinSession((s) => s.eyeM, store);
  const hasPin = usePinSession((s) => s.ground !== null, store);
  const saving = usePinSession((s) => s.saving, store);
  const item = useWorkspace((w) =>
    w.project && target ? mediaItem(w.project.manifest, target) : null,
  );
  const stage = useStageEl(target !== null);
  const [draft, setDraft] = useState<string | null>(null);
  const eyeId = useId();

  if (!target || !item || !stage) return null;
  const actions = store.getState();
  const strip = (
    <div className="pin-strip" role="toolbar" aria-label={t('pin.place')} data-testid="pin-strip">
      <p className="pin-strip-say" data-step={step}>
        {t(`pin.strip.${step}`, { name: mediaName(item) })}
      </p>
      {note && <p className="pin-strip-note">{t(note)}</p>}
      {error && (
        <p className="pin-strip-error" role="alert">
          {t('pin.strip.saveFailed', { reason: error })}
        </p>
      )}
      {hasPin && (
        <label className="pin-strip-eye" htmlFor={eyeId}>
          {t('pin.eyeHeight')}
          <input
            id={eyeId}
            className="input mono"
            type="number"
            min={0}
            max={10}
            step={0.1}
            value={draft ?? String(eyeM)}
            data-testid="pin-eye-height"
            onChange={(e) => {
              const v = e.currentTarget.value;
              setDraft(v);
              const n = Number(v);
              if (v.trim() !== '' && Number.isFinite(n)) void actions.setEyeM(n);
            }}
            onBlur={() => {
              setDraft(null);
            }}
          />
        </label>
      )}
      <span className="pin-strip-acts">
        <Button
          variant="quiet"
          onClick={() => {
            actions.cancel();
          }}
          data-testid="pin-cancel"
        >
          {t('pin.cancel')}
        </Button>
        <Button
          variant="primary"
          icon="check"
          busy={saving}
          onClick={() => {
            actions.done();
          }}
          data-testid="pin-done"
        >
          {t('pin.done')}
        </Button>
      </span>
    </div>
  );
  return createPortal(strip, stage);
}
