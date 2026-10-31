import { Icon, Progress, useT, type IconName } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useToastNotice } from '../exports/useToastNotice';
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

/** The last match taken as Same: "AI-31 and AI-12 are tracked as one finding." */
type Matched = { code: string; other: string } | null;
interface MatchedState {
  matched: Matched;
}

function PlaceBody({
  store,
  matchedStore,
}: {
  store: StoreApi<PlacementState>;
  matchedStore: StoreApi<MatchedState>;
}) {
  const t = useT();
  const s = useStore(store, (x) => x);
  const project = useWorkspace((w) => w.project);
  const dates = useWorkspace((w) => w.dates);
  const issues = useWorkspace((w) => w.issues);
  const matched = useStore(matchedStore, (x) => x.matched);
  const setMatched = (m: Matched) => {
    matchedStore.setState({ matched: m });
  };

  /**
   * Focus inside the notice when a button closed its own section (Place, the last match, Undo,
   * Dismiss): it moves to the result's Undo or Dismiss, else to the toast, and never takes focus
   * that was elsewhere.
   */
  const rootRef = useRef<HTMLDivElement>(null);
  const wantFocus = useRef(false);
  const keepFocus = () => {
    wantFocus.current = rootRef.current?.contains(document.activeElement) ?? false;
  };
  useEffect(() => {
    if (!wantFocus.current) return;
    // the whole toast: its Undo and Dismiss are in the body, focus may sit on the card
    const root = rootRef.current?.closest<HTMLElement>('.q-toast') ?? rootRef.current;
    const active = document.activeElement;
    if (!root || (active && active !== document.body && active !== root)) {
      // the notice went, or focus is on a control still there, or it moved away
      wantFocus.current = false;
      return;
    }
    const to =
      root.querySelector('[data-testid="place-undo"]') ??
      root.querySelector('[data-testid="place-dismiss"]');
    if (to instanceof HTMLElement) {
      to.focus();
      wantFocus.current = false;
    } else if (active !== rootRef.current) rootRef.current?.focus(); // placing: Undo comes next
  });

  const match = s.matches[0];
  const r = s.result;
  if (!shows(s, matched)) return null;

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
    keepFocus();
    setMatched(null);
    store.getState().dismiss();
  };

  return (
    <div className="q-toast-body" ref={rootRef} tabIndex={-1}>
      {s.offer && (
        <div className="q-toast-row" data-testid="place-offer">
          <b className="q-toast-grow">{t('place.offer', { count: s.offer.ids.length })}</b>
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={t('place.notNow')}
            data-testid="place-offer-close"
            onClick={() => {
              keepFocus();
              store.getState().notNow();
            }}
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
      {s.offer &&
        (s.noLayers ? (
          <div>{t('place.noLayers')}</div>
        ) : (
          <>
            <div aria-live="off" style={{ display: 'grid' }}>
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
            </div>
            <div className="q-toast-acts">
              <button
                type="button"
                className="btn sm"
                data-testid="place-go"
                disabled={s.busy || !s.layerId}
                onClick={() => {
                  keepFocus();
                  void store.getState().place();
                }}
              >
                {t('place.go')}
              </button>
              <button
                type="button"
                className="btn ghost sm"
                data-testid="place-not-now"
                onClick={() => {
                  keepFocus();
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
          <div data-testid="place-busy">{t('place.placing', { layer: busyLayer })}</div>
          <Progress pct={null} />
        </>
      )}
      {r && (
        <div className="q-toast-row" data-testid="place-result">
          <span className="q-toast-grow" data-testid="place-result-text">
            {resultText(t, r)}
          </span>
          {r.placed > 0 && (
            <button
              type="button"
              className="btn ghost sm"
              data-testid="place-undo"
              onClick={() => {
                keepFocus();
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
        <div className="q-toast-row">
          <div className="q-toast-grow">
            {s.undoStale && <div data-testid="place-undo-stale">{t('place.undoStale')}</div>}
            {showError && <div data-testid="place-error">{s.error}</div>}
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
          <div>
            {t('place.match', { code: match.code, other: match.otherCode, date: match.date })}
          </div>
          <div className="q-toast-acts">
            <button
              type="button"
              className="btn sm"
              data-testid="place-same"
              onClick={() => {
                keepFocus();
                const tracked = store.getState().same();
                setMatched(tracked ? { code: match.code, other: match.otherCode } : null);
              }}
            >
              {t('place.same')}
            </button>
            <button
              type="button"
              className="btn ghost sm"
              data-testid="place-different"
              onClick={() => {
                keepFocus();
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
                keepFocus();
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

/** Whether the notice has anything to say. */
function shows(s: PlacementState, matched: Matched): boolean {
  return (
    s.offer !== null ||
    s.result !== null ||
    s.matches.length > 0 ||
    s.error !== null ||
    s.busy ||
    s.undoStale ||
    matched !== null
  );
}

/** The leading icon: a target for the offer, a tick or a warning for what came of it. */
function iconOf(s: PlacementState, matched: Matched): IconName {
  if (s.offer) return 'target';
  if (s.result) return s.result.placed > 0 ? 'check' : 'warn';
  if (s.undoStale || s.error !== null) return 'warn';
  return matched ? 'check' : 'target';
}

/**
 * Findings on a model, a toast on the host (spec section 6): "Connect N findings to a model?" with
 * the layer picker, Place and Not now; then "Placed 12 of 14 on Mesh 3 Mar. 2 missed the model."
 * with Undo; then the match suggestions one at a time with Same, Different and Skip all. Its own
 * buttons close it (Not now, Dismiss), so the toast has no second close button; Escape is Not now
 * on the offer and Dismiss after it.
 */
export function PlaceOnModelNotice({ store }: { store: StoreApi<PlacementState> }) {
  const s = useStore(store, (x) => x);
  const matchedStore = useMemo(() => createStore<MatchedState>(() => ({ matched: null })), []);
  const matched = useStore(matchedStore, (x) => x.matched);
  const projectId = useWorkspace((w) => w.project?.id ?? null);
  useEffect(() => {
    matchedStore.setState({ matched: null });
  }, [projectId, matchedStore]);
  // a new result starts afresh
  const result = s.result;
  useEffect(() => {
    if (result) matchedStore.setState({ matched: null });
  }, [result, matchedStore]);
  const Body = useMemo(
    () =>
      function PlaceOnModelBody() {
        return <PlaceBody store={store} matchedStore={matchedStore} />;
      },
    [store, matchedStore],
  );
  useToastNotice(
    'place-notice',
    shows(s, matched)
      ? {
          message: '',
          icon: iconOf(s, matched),
          testId: 'place-notice',
          body: Body,
          closable: false,
          onDismiss: () => {
            const now = store.getState();
            if (now.offer) now.notNow();
            else {
              matchedStore.setState({ matched: null });
              now.dismiss();
            }
          },
        }
      : null,
    s.offer ?? s.result,
  );
  return null;
}
