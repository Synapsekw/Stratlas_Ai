import { parseMetres, type MetresKind, type SiteXYZ } from '@aio/geo';
import { Button, Popover, useT } from '@aio/ui';
import { useRef, useState } from 'react';
import { positionEdit, usePositionEdit } from './alignSession';
import type { PositionPanel } from './positionEditStore';

/*
 * Edit position: X east, Y north (site metres from the origin) and Z (project height). One photo
 * shows where it is drawn now and takes new values; several take a shift that moves them all by
 * the same amount. Enter saves, Escape cancels.
 */

const AXES = ['x', 'y', 'z'] as const;
type Axis = (typeof AXES)[number];
const LABEL = { x: 'position.x', y: 'position.y', z: 'position.z' } as const;

const fmt = (v: number) => v.toFixed(3);

/** The panel for the open Edit position, at the menu point it was chosen from. */
export function EditPositionPanel() {
  const panel = usePositionEdit((s) => s.panel);
  if (!panel) return null;
  // a new panel starts from its own values
  const key = panel.mode === 'one' ? `one:${panel.pick.layerId}/${panel.pick.photoId}` : 'many';
  return <Panel key={`${key}:${panel.at?.x ?? ''},${panel.at?.y ?? ''}`} panel={panel} />;
}

function Panel({ panel }: { panel: PositionPanel }) {
  const t = useT();
  const opener = useRef<HTMLSpanElement>(null);
  const one = panel.mode === 'one';
  const [text, setText] = useState<Record<Axis, string>>(() =>
    one
      ? { x: fmt(panel.current.x), y: fmt(panel.current.y), z: fmt(panel.current.z) }
      : { x: '', y: '', z: '' },
  );
  const kind = (a: Axis): MetresKind => (one ? a : 'shift');
  const value = (a: Axis): number | null => {
    if (panel.mode === 'many') return text[a].trim() === '' ? 0 : parseMetres(text[a], kind(a));
    // a field showing the current value keeps it exact: its text is rounded to the mm
    const cur = panel.current[a];
    return text[a] === fmt(cur) ? cur : parseMetres(text[a], kind(a));
  };
  const values = { x: value('x'), y: value('y'), z: value('z') };
  const ok = AXES.every((a) => values[a] !== null);
  const save = () => {
    if (values.x === null || values.y === null || values.z === null) return;
    const v: SiteXYZ = { x: values.x, y: values.y, z: values.z };
    void positionEdit.getState().save(v);
  };
  const close = () => {
    positionEdit.getState().cancel();
  };
  const at = panel.at ?? { x: window.innerWidth / 2 - 140, y: window.innerHeight / 3 };
  const count = one ? 1 : panel.count;
  return (
    <>
      <span
        ref={opener}
        className="pos-opener"
        aria-hidden="true"
        style={{ left: at.x, top: at.y }}
      />
      <Popover open onClose={close} opener={opener} anchor="below" className="pos-panel">
        <form
          className="pos-form"
          data-testid="position-panel"
          aria-label={t('position.title', { count })}
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) save();
          }}
        >
          <h2 className="pos-title">{t('position.title', { count })}</h2>
          <p className="pos-hint faint">{t(one ? 'position.hint.one' : 'position.hint.many')}</p>
          {AXES.map((a) => {
            const bad = values[a] === null;
            return (
              <label key={a} className="pos-row">
                <span className="pos-axis">{t(LABEL[a])}</span>
                <input
                  className="input mono"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  value={text[a]}
                  placeholder={one ? undefined : '0'}
                  aria-invalid={bad ? true : undefined}
                  data-testid={`position-input-${a}`}
                  onChange={(e) => {
                    const next = e.target.value;
                    setText((s) => ({ ...s, [a]: next }));
                  }}
                />
                <span className="pos-unit faint">{t('position.unit')}</span>
              </label>
            );
          })}
          {!ok && (
            <p className="pos-bad" role="alert">
              {t('position.invalid')}
            </p>
          )}
          {panel.mode === 'one' && (
            <p className="pos-orig faint mono">
              {t('position.original', {
                x: fmt(panel.original.x),
                y: fmt(panel.original.y),
                z: fmt(panel.original.z),
              })}
            </p>
          )}
          <div className="pos-acts">
            {panel.mode === 'one' && panel.edited && (
              <Button
                variant="quiet"
                icon="undo"
                data-testid="position-reset"
                onClick={() => {
                  void positionEdit.getState().reset([panel.pick]);
                }}
              >
                {t('position.reset')}
              </Button>
            )}
            <span className="pos-grow" />
            <Button data-testid="position-cancel" onClick={close}>
              {t('position.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={!ok} data-testid="position-save">
              {t('position.save')}
            </Button>
          </div>
        </form>
      </Popover>
    </>
  );
}
