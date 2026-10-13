/**
 * The spot history viewer (spec Part S1): one image of a spot at a time, a strip of every survey
 * date below, Compare for two dates. A modal dialog over the whole app, as the issue card's
 * lightbox: focus stays inside while it is open and goes back to the control that opened it.
 * Founder decision 2: it never touches the main view (selection, date, visible layers, stage);
 * stepping dates here changes only the viewer's own store.
 */
import type { Layer } from '@aio/schema';
import { focusLost, Icon, matchShortcut, shortcutHint, useFocusTrap, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { metres } from '../panoSurface';
import { SpotCompare } from './SpotCompare';
import { SpotMatchView } from './SpotMatchView';
import { sameItem, selfMatch } from './spotSearch';
import { SpotStrip, stripKey } from './SpotStrip';
import { SpotThumb } from './SpotThumb';
import type { SpotHistory, SpotItem, SpotMatch } from './spotTypes';
import {
  defaultOther,
  matchAt,
  resolveAt,
  resolveCompare,
  spotViewer,
  startAt,
  type SpotAt,
  type SpotCompareState,
} from './spotViewerStore';
import { useSpotHistory } from './useSpotHistory';
import './spot.css';

/** The photo or panorama id; a clip or walk by its layer and moment. */
function itemId(item: SpotItem): string {
  if (item.kind === 'photo') return item.photo;
  if (item.kind === 'pano') return item.pano;
  return `${item.layer}@${String(item.t)}`;
}

/** The match's identity for remounting its view: a new match (or a new look) starts afresh. */
function keyOf(m: SpotMatch): string {
  return `${m.capture}|${m.item.layer}|${itemId(m.item)}|${String(m.lookDeg ?? '')}`;
}

/** Controls whose own keys the dialog leaves alone (all but Esc and Tab). */
const ownsKeys = (el: EventTarget) =>
  el instanceof HTMLSelectElement || el instanceof HTMLMediaElement;

const seconds = (t: number) => String(Math.round(t * 10) / 10);

function useItemName(): (layers: readonly Layer[], item: SpotItem) => string {
  const t = useT();
  return (layers, item) => {
    if (item.kind === 'photo' || item.kind === 'pano') return itemId(item);
    const name = layers.find((l) => l.id === item.layer)?.name ?? item.layer;
    return `${name} ${t('spot.atTime', { time: seconds(item.t) })}`;
  };
}

const datedCount = (h: SpotHistory) => h.dates.filter((d) => d.matches.length > 0).length;

export function SpotViewer() {
  const t = useT();
  const nameOf = useItemName();
  const state = useStore(spotViewer);
  const project = useWorkspace((s) => s.project);
  const open = state.open;
  const { reading, index, tags, result, origin } = useSpotHistory(open, open !== null);
  const dialog = useRef<HTMLDivElement>(null);
  const openedIn = useRef<string | null>(null);

  // the viewer belongs to the project it was opened in: closing or switching it closes the viewer
  useEffect(() => {
    if (!open) {
      openedIn.current = null;
      return;
    }
    const id = project?.id ?? null;
    if (id === null || (openedIn.current !== null && openedIn.current !== id))
      spotViewer.getState().close();
    else openedIn.current = id;
  }, [open, project]);

  const shown = open !== null && project !== null && index !== null && result !== null;
  useFocusTrap(dialog, shown, { cycle: false, initial: () => dialog.current });

  // focus lost inside (Compare closed under the swipe handle, a view remounted on a new date):
  // the dialog takes it back, so the next key still reaches it
  useEffect(() => {
    if (shown && dialog.current && focusLost(document)) dialog.current.focus();
  });

  // Compare's sides resolved against the current history; null when the left side is gone (a
  // layer or date removed), and then Compare is left
  const compare = useMemo(
    () =>
      state.compare && result && 'history' in result
        ? resolveCompare(result.history, state.compare)
        : null,
    [state.compare, result],
  );
  const compareGone = state.compare !== null && result !== null && compare === null;
  useEffect(() => {
    if (compareGone) spotViewer.getState().setCompare(null);
  }, [compareGone]);

  if (!shown) return null;
  const layers = project.manifest.layers;
  const name = nameOf(layers, open.item);
  const close = () => {
    spotViewer.getState().close();
  };

  const onTab = (e: KeyboardEvent<HTMLDivElement>) => {
    // keep focus inside the dialog
    const focusables = [
      ...(dialog.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ];
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;
    if (
      e.shiftKey &&
      (document.activeElement === first || document.activeElement === dialog.current)
    )
      last.focus();
    else if (!e.shiftKey && document.activeElement === last) first.focus();
    else return;
    e.preventDefault();
  };

  const closeButton = (
    <button
      type="button"
      className="btn icon sm ghost"
      aria-label={t('spot.close')}
      title={`${t('spot.close')} (${shortcutHint('spot.close')})`}
      data-testid="spot-close"
      onClick={close}
    >
      <Icon name="x" size={14} />
    </button>
  );

  const frame = (body: ReactNode, onKey: (e: KeyboardEvent<HTMLDivElement>) => void) => (
    <div
      className="spot-scrim"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dialog}
        className="spot-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('spot.dialog', { name })}
        data-testid="spot-viewer"
        tabIndex={-1}
        onKeyDown={(e) => {
          // the stage and app shortcuts stay out while the dialog is open
          e.stopPropagation();
          if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
          if (e.key === 'Tab') onTab(e);
          // a date select and a playing clip own their keys (arrows pick, seek); Esc still closes
          else if (ownsKeys(e.target) && matchShortcut('spot', e) !== 'spot.close') return;
          else onKey(e);
        }}
        onBlur={(e) => {
          if (e.relatedTarget !== null) return;
          queueMicrotask(() => {
            if (dialog.current?.isConnected && focusLost(document)) dialog.current.focus();
          });
        }}
      >
        {body}
      </div>
    </div>
  );

  if ('error' in result)
    return frame(
      <>
        <header className="spot-h" role="none">
          <div className="spot-t">
            <b className="mono">{name}</b>
          </div>
          <div className="spot-acts">{closeButton}</div>
        </header>
        <p className="spot-none" data-testid="spot-no-position">
          {t(open.item.kind === 'walk' ? 'spot.noPositionWalk' : 'spot.noPosition')}
        </p>
      </>,
      (e) => {
        if (matchShortcut('spot', e) !== 'spot.close') return;
        e.preventDefault();
        close();
      },
    );

  const history = result.history;
  // an undated item has no slot: the viewer starts on the item itself (F8)
  const undated = origin === undefined;
  const at: SpotAt | null = compare
    ? compare.left
    : undated && state.at === null
      ? null
      : resolveAt(history, state.at, origin);
  const current =
    matchAt(history, at) ??
    (at === null && undated ? selfMatch(open.item, '', history.spot) : undefined);
  const canCompare = datedCount(history) >= 2;

  const setCompare = (c: SpotCompareState | null) => {
    spotViewer.getState().setCompare(c);
  };
  const toggleCompare = () => {
    if (compare) {
      setCompare(null);
      spotViewer.getState().goTo(compare.left);
      return;
    }
    const left = at ?? startAt(history, undefined);
    if (!canCompare || !left) return;
    setCompare({ mode: 'side', left, right: defaultOther(history, left.capture), amount: 0.5 });
  };
  const pick = (next: SpotAt) => {
    // in Compare a new place moves the left side (F13)
    if (compare) setCompare({ ...compare, left: next });
    else spotViewer.getState().goTo(next);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const id = matchShortcut('spot', e);
    if (id === 'spot.close') {
      if (compare) toggleCompare();
      else close();
    } else if (id === 'spot.compare') toggleCompare();
    else {
      const next = stripKey(e, history, at);
      if (!next) return;
      pick(next);
    }
    e.preventDefault();
  };

  const tag = current ? tags[current.capture] : undefined;
  const self =
    current !== undefined &&
    sameItem(current.item, open.item) &&
    current.capture === (origin ?? '');
  const away = (m: SpotMatch) =>
    m.angleDeg !== null && Math.round(m.angleDeg) >= 1
      ? t('spot.awayTurned', { m: metres(m.distanceM), deg: Math.round(m.angleDeg) })
      : t('spot.away', { m: metres(m.distanceM) });

  return frame(
    <>
      <header className="spot-h" role="none">
        {current && (
          <div
            className="spot-t"
            data-testid="spot-head"
            data-capture={current.capture}
            data-kind={current.kind}
            data-item={itemId(current.item)}
            data-distance={current.distanceM.toFixed(2)}
          >
            <b className="mono">{nameOf(layers, current.item)}</b>
            <span className="spot-date">
              {tag && (
                <span className="dtag" style={{ background: tag.colour }} aria-hidden="true" />
              )}
              {tag?.long ?? t('spot.noDate')}
            </span>
            <span className="faint">{t(`spot.kind.${current.kind}`)}</span>
            <span className="faint">{self ? t('spot.self') : away(current)}</span>
          </div>
        )}
        {reading && (
          <span className="faint small" role="status">
            {t('spot.reading')}
          </span>
        )}
        <div className="spot-acts">
          <button
            type="button"
            className="btn sm ghost"
            aria-pressed={compare !== null}
            title={`${t('spot.compareTip')} (${shortcutHint('spot.compare')})`}
            data-testid="spot-compare"
            disabled={!canCompare}
            onClick={toggleCompare}
          >
            {compare ? t('spot.compare.back') : t('spot.compare')}
          </button>
          <span className="spot-sep" />
          {closeButton}
        </div>
      </header>
      <div className="spot-body">
        {compare ? (
          <SpotCompare
            history={history}
            state={compare}
            projectId={project.id}
            layers={layers}
            tags={tags}
            onChange={setCompare}
          />
        ) : (
          current && (
            <SpotMatchView
              key={keyOf(current)}
              projectId={project.id}
              layers={layers}
              match={current}
              playable
            />
          )
        )}
      </div>
      {index.captures.length >= 2 && (
        <footer className="spot-foot">
          <SpotStrip
            history={history}
            at={at}
            tags={tags}
            origin={open.item.kind}
            thumb={(m) => <SpotThumb projectId={project.id} layers={layers} match={m} />}
            onPick={pick}
          />
          <p className="spot-keys faint small">{t('spot.keys')}</p>
        </footer>
      )}
    </>,
    onKey,
  );
}
