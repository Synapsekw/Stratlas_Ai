import { Icon, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import { layerChoices, type LayerChoice } from './layers';
import type { PlaceSummary, PlacementState } from './store';

type T = ReturnType<typeof useT>;

/** "Placed 12 of 14 on Mesh 3 Mar. 2 missed the model." and whatever else held some back. */
export function resultText(t: T, r: PlaceSummary): string {
  const selectionError = r.outcomes.find((o) => o.selectionError !== undefined)?.selectionError;
  return [
    t('place.result', { placed: r.placed, count: r.total, layer: r.layerName }),
    r.missed ? t('place.missed', { count: r.missed }) : '',
    r.noPhoto ? t('place.noPhoto', { count: r.noPhoto }) : '',
    r.notLoaded ? t('place.notLoaded', { layer: r.layerName }) : '',
    r.changed ? t('place.changed', { count: r.changed }) : '',
    r.selectionFailed
      ? t('place.selectionFailed', { count: r.selectionFailed, error: selectionError ?? '' })
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Findings on a model, bottom right (spec section 6): "Connect N findings to a model?" with the
 * layer picker, Place and Not now; then "Placed 12 of 14 on Mesh 3 Mar. 2 missed the model."
 * with Undo; then the match suggestions one at a time with Same, Different and Skip all.
 */
export function PlaceOnModelNotice({ store }: { store: StoreApi<PlacementState> }) {
  const t = useT();
  const s = useStore(store, (x) => x);
  const project = useWorkspace((w) => w.project);
  const dates = useWorkspace((w) => w.dates);
  const issues = useWorkspace((w) => w.issues);
  /** The last match taken as Same: "AI-31 and AI-12 are tracked as one finding." */
  const [matched, setMatched] = useState<{ code: string; other: string } | null>(null);
  const projectId = project?.id ?? null;
  useEffect(() => {
    setMatched(null);
  }, [projectId]);

  const match = s.matches[0];
  const r = s.result;
  if (!s.offer && !r && !match && !s.error && !s.busy && !s.undoStale && !matched) return null;

  const offered = s.offer ? issues.filter((i) => s.offer?.ids.includes(i.id)) : [];
  const choices = project ? layerChoices(project.manifest, dates, offered) : [];
  const busyLayer =
    project?.manifest.layers.find((l) => l.id === (s.layerId ?? s.result?.layerId))?.name ?? '';
  // the result already says why a selection file failed
  const failedSelection = r?.outcomes.find((o) => o.selectionError !== undefined)?.selectionError;
  const showError =
    s.error !== null && !(r && r.selectionFailed > 0 && s.error === failedSelection);
  const option = (c: LayerChoice) => (
    <option key={c.id} value={c.id}>
      {`${c.name} (${t(c.kind === 'mesh' ? 'place.kind.mesh' : 'place.kind.pointcloud')})`}
    </option>
  );
  const same = choices.filter((c) => c.sameDate);
  const other = choices.filter((c) => !c.sameDate);
  const dismiss = () => {
    setMatched(null);
    store.getState().dismiss();
  };

  return (
    <div className="toast" data-testid="place-notice">
      {s.offer && (
        <div className="toast-h" data-testid="place-offer">
          <Icon name="target" size={14} />
          <b>{t('place.offer', { count: s.offer.ids.length })}</b>
          <span className="toast-grow" />
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={t('place.dismiss')}
            onClick={() => {
              store.getState().notNow();
            }}
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
      {s.offer &&
        (s.noLayers ? (
          <div className="toast-p">{t('place.noLayers')}</div>
        ) : (
          <>
            <select
              className="input sm"
              aria-label={t('place.layer')}
              data-testid="place-layer"
              value={s.layerId ?? ''}
              disabled={s.busy}
              onChange={(e) => {
                store.getState().setLayer(e.target.value);
              }}
            >
              {same.length > 0 && other.length > 0 ? (
                <>
                  <optgroup label={t('place.group.sameDate')}>{same.map(option)}</optgroup>
                  <optgroup label={t('place.group.other')}>{other.map(option)}</optgroup>
                </>
              ) : (
                choices.map(option)
              )}
            </select>
            <div className="toast-p pm-acts">
              <button
                type="button"
                className="btn sm"
                data-testid="place-go"
                disabled={s.busy || !s.layerId}
                onClick={() => void store.getState().place()}
              >
                {t('place.go')}
              </button>
              <button
                type="button"
                className="btn ghost sm"
                data-testid="place-not-now"
                onClick={() => {
                  store.getState().notNow();
                }}
              >
                {t('place.notNow')}
              </button>
            </div>
          </>
        ))}
      {s.busy && !s.offer && (
        <>
          <div className="toast-p" data-testid="place-busy">
            {t('place.placing', { layer: busyLayer })}
          </div>
          <div className="toast-bar busy" aria-hidden="true">
            <i style={{ width: '30%' }} />
          </div>
        </>
      )}
      {r && (
        <div className="toast-h" data-testid="place-result">
          <Icon name={r.placed > 0 ? 'check' : 'warn'} size={14} />
          <span className="toast-p" data-testid="place-result-text">
            {resultText(t, r)}
          </span>
          <span className="toast-grow" />
          {r.placed > 0 && (
            <button
              type="button"
              className="btn ghost sm"
              data-testid="place-undo"
              onClick={() => {
                setMatched(null);
                store.getState().undo();
              }}
            >
              <Icon name="undo" size={12} />
              {t('place.undo')}
            </button>
          )}
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={t('place.dismiss')}
            data-testid="place-dismiss"
            onClick={dismiss}
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
      {(s.undoStale || showError || matched) && (
        <div className="toast-h">
          {!r && !s.offer && <Icon name={s.undoStale || showError ? 'warn' : 'check'} size={14} />}
          <div className="toast-p toast-grow">
            {s.undoStale && <div data-testid="place-undo-stale">{t('place.undoStale')}</div>}
            {showError && (
              <div role="alert" data-testid="place-error">
                {s.error}
              </div>
            )}
            {matched && <div data-testid="place-matched">{t('place.matched', matched)}</div>}
          </div>
          {!r && !s.offer && (
            <button
              type="button"
              className="btn ghost icon sm"
              aria-label={t('place.dismiss')}
              data-testid="place-dismiss"
              onClick={dismiss}
            >
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
      )}
      {match && (
        <div data-testid="place-match">
          <div className="toast-p">
            {t('place.match', { code: match.code, other: match.otherCode, date: match.date })}
          </div>
          <div className="toast-p pm-acts">
            <button
              type="button"
              className="btn sm"
              data-testid="place-same"
              onClick={() => {
                const before = store.getState().error;
                store.getState().same();
                const after = store.getState().error;
                setMatched(
                  after === null || after === before
                    ? { code: match.code, other: match.otherCode }
                    : null,
                );
              }}
            >
              {t('place.same')}
            </button>
            <button
              type="button"
              className="btn ghost sm"
              data-testid="place-different"
              onClick={() => {
                setMatched(null);
                store.getState().different();
              }}
            >
              {t('place.different')}
            </button>
            <button
              type="button"
              className="btn ghost sm"
              data-testid="place-skip-all"
              onClick={() => {
                setMatched(null);
                store.getState().skipAll();
              }}
            >
              {t('place.skipAll')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
