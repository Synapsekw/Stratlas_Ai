import { hasTurn, type Capture, type LineUpMeasure, type ProjectManifest } from '@aio/schema';
import { Button, Tip, useT, type t as translate } from '@aio/ui';
import type { CaptureIndex, Workspace } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import type { SplitModel } from '../workspace/SplitPanes';
import { sideCapture, twinAllowed } from '../workspace/splitModel';
import {
  compareLineUpApp,
  fitOf,
  offBy,
  type CompareLineUp as ChipStore,
  type CompareLineUpState,
} from './compareLineUpStore';
import { openLineUp, removeLineUp } from './lineUpActions';
import { lineUpApp, type LineUpStore } from './lineUpStore';
import { formatMetres, shiftWords } from './planLineUp';
import './lineup.css';

type T = typeof translate;

/** The two dates of a twin split, left first; null when the split is not two panes of one kind. */
export function twinDates(split: SplitModel): [string, string] | null {
  const { sides, dates } = split;
  if (sides.left !== sides.right || !twinAllowed(sides.left, dates)) return null;
  const left = sideCapture(sides, 'left', dates);
  const right = sideCapture(sides, 'right', dates);
  return left && right && left !== right ? [left, right] : null;
}

/** "turned 0.11°, scaled -0.18%". */
function turnWords(rotationDeg: number, scale: number, t: T): string {
  const pct = (scale - 1) * 100;
  return t('lineUp.turn', {
    deg: rotationDeg.toFixed(2),
    pct: `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`,
  });
}

const labelOf = (m: ProjectManifest, id: string) =>
  m.captures.find((c) => c.id === id)?.label ?? id;

function hasClouds(m: ProjectManifest, index: CaptureIndex | null, id: string): boolean {
  const ids = new Set(index?.layers[id] ?? []);
  return m.layers.some((l) => l.kind === 'pointcloud' && (ids.has(l.id) || l.capture === id));
}

interface Saved {
  capture: Capture;
  lineUp: NonNullable<Capture['lineUp']>;
}

/** The details' lines as plain text (the chip's tooltip), and the dates lined up. */
function detailsOf(
  s: CompareLineUpState,
  m: ProjectManifest,
  index: CaptureIndex | null,
  t: T,
): { lines: string[]; saved: Saved[] } {
  const lines: string[] = [];
  const ids = [s.left, s.right].filter((x): x is string => !!x);
  const saved = ids.flatMap((id) => {
    const capture = m.captures.find((c) => c.id === id);
    return capture?.lineUp ? [{ capture, lineUp: capture.lineUp }] : [];
  });
  const r = s.measure;
  if (s.status === 'cannot' && s.reason) lines.push(s.reason);
  if (s.status === 'off' && r)
    lines.push(t('compare.lineUp.offBy', { distance: formatMetres(offBy(r)) }));
  if (s.status === 'lined' && r && saved.length === 0)
    lines.push(t('compare.lineUp.within', { distance: formatMetres(r.tolerancePx * r.cellM) }));
  for (const { capture, lineUp } of saved) {
    lines.push(
      t('compare.lineUp.saved', { moved: capture.label, kept: labelOf(m, lineUp.with) }),
      shiftWords(lineUp.eastM, lineUp.northM, t),
    );
    if (hasTurn(capture.lineUpTurn) && capture.lineUpTurn)
      lines.push(turnWords(capture.lineUpTurn.rotationDeg, capture.lineUpTurn.scale, t));
  }
  if (saved.length === 0 && s.status !== 'measuring') lines.push(t('compare.lineUp.never'));
  if (r && s.status !== 'cannot') lines.push(fitWords(r, t));
  // a turned line-up, saved or about to be, moves point clouds but does not turn them (stage 1)
  const fit = r ? fitOf(r) : undefined;
  const turnsNext =
    s.status === 'off' &&
    !!fit &&
    hasTurn({ rotationDeg: fit.rotationDeg ?? 0, scale: fit.scale ?? 1 });
  const turning =
    saved.some(({ capture }) => hasTurn(capture.lineUpTurn) && hasClouds(m, index, capture.id)) ||
    (turnsNext && ids.some((id) => hasClouds(m, index, id)));
  if (turning) lines.push(t('lineUp.cloudsNoTurn'));
  return { lines, saved };
}

function fitWords(r: LineUpMeasure, t: T): string {
  const px = fitOf(r)?.residualPx ?? r.spreadPx;
  return t('compare.lineUp.fit', { px: px.toFixed(2), tiles: r.tiles });
}

/** Undo of the line-up just saved or removed for one of the two dates, from the step's notice. */
function UndoLine({ store, ids }: { store: StoreApi<LineUpStore>; ids: readonly string[] }) {
  const t = useT();
  const action = useStore(store, (s) => s.notice?.action ?? null);
  if (action?.kind !== 'undo' || !ids.includes(action.write.captureId)) return null;
  return (
    <Button
      variant="quiet"
      icon="undo"
      data-testid="compare-lineup-undo"
      onClick={() => void store.getState().apply()}
    >
      {t('align.direction.undo')}
    </Button>
  );
}

function Chip({
  store,
  workspace,
  index,
  left,
  right,
}: {
  store: StoreApi<ChipStore>;
  workspace: StoreApi<Workspace>;
  index: CaptureIndex | null;
  left: string;
  right: string;
}) {
  const t = useT();
  const s = useStore(store);
  const manifest = useStore(workspace, (w) => w.project?.manifest);
  const step = useStore(lineUpApp, (a) => a.store);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    store.getState().watch(left, right);
  }, [store, left, right]);
  // leaving the comparison gives the measurement up
  useEffect(
    () => () => {
      store.getState().stop();
    },
    [store],
  );
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (
        e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', away, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', away, true);
    };
  }, [open]);

  if (!manifest || s.status === 'idle') return null;
  const r = s.measure;
  const label =
    s.status === 'lined'
      ? t('compare.lineUp.lined')
      : s.status === 'off' && r
        ? t('compare.lineUp.off', { distance: formatMetres(offBy(r)) })
        : s.status === 'measuring'
          ? t('compare.lineUp.measuring')
          : t('compare.lineUp.cannot');
  const { lines, saved } = detailsOf(s, manifest, index, t);
  return (
    <div ref={box} className="compare-lineup" data-testid="compare-lineup" data-status={s.status}>
      <Tip
        content={
          <span className="compare-lineup-tip">
            {[label, ...lines].map((line, k) => (
              <span key={k}>{line}</span>
            ))}
          </span>
        }
      >
        <button
          type="button"
          className="compare-lineup-chip"
          data-testid="compare-lineup-chip"
          aria-label={t('compare.lineUp.label', { status: label })}
          aria-expanded={open}
          aria-busy={s.status === 'measuring'}
          onClick={() => {
            setOpen((o) => !o);
          }}
        >
          {s.status === 'measuring' ? (
            <span className="spin" aria-hidden="true" />
          ) : (
            <span className="compare-lineup-dot" aria-hidden="true" />
          )}
          <span className="compare-lineup-label" data-testid="compare-lineup-label">
            {label}
          </span>
        </button>
      </Tip>
      {s.status === 'off' && (
        <Button
          variant="primary"
          icon="crosshair"
          className="compare-lineup-action"
          data-testid="compare-lineup-action"
          aria-label={t('compare.lineUp.action')}
          tip={t('compare.lineUp.action')}
          onClick={() => {
            openLineUp(left, right);
          }}
        >
          {/* a narrow stage shows the icon only (lineup.css) */}
          <span className="compare-lineup-action-text">{t('compare.lineUp.action')}</span>
        </Button>
      )}
      {open && (
        <div
          className="compare-lineup-details overlay-box"
          data-surface="dark"
          data-testid="compare-lineup-details"
          role="dialog"
          aria-label={label}
        >
          <p className="compare-lineup-head">{label}</p>
          {lines.map((line, i) => (
            <p key={i} dir="auto">
              {line}
            </p>
          ))}
          {(saved.length > 0 || step) && (
            <div className="compare-lineup-acts">
              {step && <UndoLine store={step} ids={[left, right]} />}
              {saved.map(({ capture }) => (
                <Button
                  key={capture.id}
                  variant="quiet"
                  data-testid={`compare-lineup-remove-${capture.id}`}
                  onClick={() => {
                    removeLineUp(capture.id);
                    setOpen(false);
                  }}
                >
                  {saved.length > 1
                    ? t('compare.lineUp.removeOf', { date: capture.label })
                    : t('lineUp.remove')}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Whether the two dates Compare shows line up (design call 8), on `COMPARE_TOOLS`: "Lined up",
 * "2.04 m off" with Line up, "Checking line-up…" or "Can't line up", and the details on a click.
 * Nothing without a twin, or before the line-up session has made its store.
 */
export function CompareLineUp({ split }: { split: SplitModel }) {
  const { store, workspace } = useStore(compareLineUpApp);
  const pair = twinDates(split);
  if (!store || !workspace || !pair) return null;
  return (
    <Chip store={store} workspace={workspace} index={split.index} left={pair[0]} right={pair[1]} />
  );
}
