/**
 * The floating antenna card: the selected unit's photos, values and review buttons beside its box
 * in the 3D stage, with a leader line to the box. The header drags it; once dragged it stays where
 * it was put for the session (until `resetCardDrag`). A, R, the arrows and Esc work while it shows
 * a unit (`useAntennaKeys`).
 */
import type { AntennaStatus, AntennaUnit, AntennaValue, Layer } from '@aio/schema';
import { Button, Chip, IconButton, Kbd, t } from '@aio/ui';
import { assetUrl, useWorkspace } from '@aio/workspace';
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { openPhoto } from '../builder/photoOpen';
import { thumbUrl } from '../thumbs/Thumb';
import { AntennaUserFields } from './AntennaUserFields';
import { formatDeg, trueAzimuth } from './antennaFormat';
import { KIND_COLOURS } from './antennaScene';
import {
  decideAntenna,
  filteredUnits,
  patchUnitUser,
  selectAntenna,
  stepAntenna,
  useAntennas,
} from './antennaStore';
import { placeCard, type Rect } from './cardPlacement';
import { useAntennaKeys } from './useAntennaKeys';

export interface AntennaCardProps {
  /** The element the card is drawn in (the stage's canvas parent, positioned). */
  stageHost: HTMLElement;
  /** The selected box on screen, in CSS pixels relative to `stageHost`; null when not in view. */
  boxRect: Rect | null;
}

// ---------------------------------------------------------------- session drag position

let dragged: { x: number; y: number } | null = null;
const dragListeners = new Set<() => void>();

function setDragged(next: { x: number; y: number } | null): void {
  dragged = next;
  for (const l of dragListeners) l();
}

/** Forget where the card was dragged (the runner calls this when the project changes). */
export function resetCardDrag(): void {
  setDragged(null);
}

function subscribeDrag(cb: () => void): () => void {
  dragListeners.add(cb);
  return () => {
    dragListeners.delete(cb);
  };
}
const getDragged = () => dragged;

// ---------------------------------------------------------------- formatting

/** A value the unit does not have: a symbol, the same in every language. */
const DASH = '—';
const CARD_W = 320;
/** Assumed until the card has been measured once. */
const CARD_H = 420;
const TONE = { draft: 'warn', accepted: 'acc', rejected: 'off' } as const;

const deg = (v: AntennaValue | undefined, signed = false): string =>
  v ? formatDeg(v.value, signed) : DASH;
const metres = (v: AntennaValue | undefined): string => (v ? v.value.toFixed(2) : DASH);

/** The azimuth in degrees: true north when the file has the convergence, else project north. */
function azimuthText(unit: AntennaUnit): string {
  const grid = unit.azimuthGridDeg;
  if (!grid) return DASH;
  return formatDeg(
    unit.convergenceDeg === null ? grid.value : trueAzimuth(grid.value, unit.convergenceDeg),
  );
}

// ---------------------------------------------------------------- photos

type PhotoEntry =
  | { kind: 'crop'; url: string; open: { layer: string; id: string } | null }
  | { kind: 'photo'; url: string | null; open: { layer: string; id: string } };

function safeAssetUrl(projectId: string, ref: Parameters<typeof assetUrl>[1]): string | null {
  try {
    return assetUrl(projectId, ref);
  } catch {
    return null;
  }
}

/** The crop first, then each linked photo, with the project's address of its full image. */
function photoEntries(
  unit: AntennaUnit,
  projectId: string | null,
  layers: readonly Layer[],
): PhotoEntry[] {
  const out: PhotoEntry[] = [];
  const first = unit.photos[0];
  const crop = unit.crop && projectId ? safeAssetUrl(projectId, { path: unit.crop }) : null;
  if (crop)
    out.push({
      kind: 'crop',
      url: crop,
      open: first ? { layer: first.layer, id: first.id } : null,
    });
  for (const p of unit.photos) {
    const layer = layers.find((l) => l.id === p.layer);
    const src =
      layer?.kind === 'photos' ? layer.items.find((item) => item.id === p.id)?.src : undefined;
    out.push({
      kind: 'photo',
      url: src && projectId ? safeAssetUrl(projectId, src) : null,
      open: { layer: p.layer, id: p.id },
    });
  }
  return out;
}

const IMG: CSSProperties = {
  display: 'block',
  width: '100%',
  height: '100%',
  objectFit: 'contain',
};

/** A linked photo fitted in the card: its thumbnail, else the full image. */
function FittedPhoto({ full }: { full: string }): ReactElement {
  const [src, setSrc] = useState(() => thumbUrl(full));
  return (
    <img
      src={src}
      alt=""
      decoding="async"
      draggable={false}
      data-testid="antenna-photo-img"
      style={IMG}
      onError={() => {
        if (src !== full) setSrc(full);
      }}
    />
  );
}

const STRIP: CSSProperties = {
  position: 'relative',
  height: 180,
  borderRadius: 'var(--r-4)',
  overflow: 'hidden',
  background: 'var(--bg-0)',
};
const STRIP_BAR: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  padding: 'var(--sp-2) var(--sp-3)',
  background: 'linear-gradient(transparent, var(--shadow))',
};

function PhotoStrip({ entries }: { entries: PhotoEntry[] }): ReactElement {
  const [i, setI] = useState(0);
  const n = entries.length;
  if (n === 0)
    return (
      <p style={{ margin: 0, color: 'var(--fg-3)', fontSize: 'var(--t-12)' }}>
        {t('telecom.antennas.photos.none')}
      </p>
    );
  const at = Math.min(i, n - 1);
  const entry = entries[at];
  const step = (d: 1 | -1) => {
    setI((at + d + n) % n);
  };
  return (
    <div style={STRIP} data-testid="antenna-card-photos">
      {entry?.kind === 'crop' ? (
        <img src={entry.url} alt="" data-testid="antenna-crop" draggable={false} style={IMG} />
      ) : entry?.url ? (
        <FittedPhoto key={entry.url} full={entry.url} />
      ) : null}
      <div style={STRIP_BAR}>
        {n > 1 ? (
          <IconButton
            icon="chev-r"
            label={t('telecom.antennas.card.photoPrev')}
            data-testid="antenna-card-photo-prev"
            style={{ transform: 'scaleX(-1)' }}
            onClick={() => {
              step(-1);
            }}
          />
        ) : null}
        <span
          className="mono"
          data-testid="antenna-card-photo-index"
          style={{ fontSize: 'var(--t-11)', color: 'var(--fg-0)' }}
        >
          {t('telecom.antennas.card.photo', { i: at + 1, n })}
        </span>
        {n > 1 ? (
          <IconButton
            icon="chev-r"
            label={t('telecom.antennas.card.photoNext')}
            data-testid="antenna-card-photo-next"
            onClick={() => {
              step(1);
            }}
          />
        ) : null}
        <span style={{ flex: 1 }} />
        {entry?.open ? (
          <Button
            variant="quiet"
            data-testid="antenna-card-open-photo"
            onClick={() => {
              const o = entry.open;
              if (o) openPhoto(o.layer, o.id);
            }}
          >
            {t('telecom.antennas.card.openPhoto')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- values

const LABEL: CSSProperties = {
  fontSize: 'var(--t-11)',
  color: 'var(--fg-3)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

function Value({
  name,
  label,
  big,
  children,
}: {
  name: string;
  label: string;
  big?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <div style={{ display: 'grid', gap: 'var(--sp-1)', minWidth: 0 }}>
      <dt style={LABEL}>{label}</dt>
      <dd
        className="mono"
        data-value={name}
        style={{
          margin: 0,
          fontSize: big ? 'var(--t-20)' : 'var(--t-12)',
          color: 'var(--fg-0)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {children}
      </dd>
    </div>
  );
}

const GRID: CSSProperties = {
  margin: 0,
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 'var(--sp-4) var(--sp-5)',
};

function Values({ unit }: { unit: AntennaUnit }): ReactElement {
  const dish = unit.kind === 'dish';
  const size = `${metres(unit.widthM)}×${metres(unit.heightM)}×${metres(unit.depthM)}`;
  return (
    <dl style={GRID}>
      <Value name="azimuth" label={t('telecom.antennas.value.azimuth')} big>
        {azimuthText(unit)}
      </Value>
      {dish ? (
        <>
          <Value name="elevation" label={t('telecom.antennas.value.elevation')} big>
            {deg(unit.elevationDeg, true)}
          </Value>
          <Value name="diameter" label={t('telecom.antennas.value.diameter')} big>
            {unit.diameterM ? `${unit.diameterM.value.toFixed(2)} m` : DASH}
          </Value>
        </>
      ) : (
        <>
          <Value name="downtilt" label={t('telecom.antennas.value.downtilt')} big>
            {deg(unit.downtiltDeg)}
          </Value>
          <Value name="plumb" label={t('telecom.antennas.value.plumb')} big>
            {deg(unit.plumbDeg, true)}
          </Value>
        </>
      )}
      <Value name="size" label={t('telecom.antennas.card.size')}>
        {size}
      </Value>
      <Value name="altitude" label={t('telecom.antennas.card.altitude')}>
        {`${unit.box.centre[2].toFixed(1)} m`}
      </Value>
      <Value name="points" label={t('telecom.antennas.card.points')}>
        {unit.support.toLocaleString()}
      </Value>
    </dl>
  );
}

// ---------------------------------------------------------------- the card

const CARD: CSSProperties = {
  position: 'absolute',
  width: CARD_W,
  maxWidth: 'calc(100% - 16px)',
  maxHeight: 'calc(100% - 16px)',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--bg-1)',
  color: 'var(--fg-0)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-6)',
  boxShadow: '0 8px 24px var(--shadow)',
  zIndex: 'var(--z-stage-ui)',
  fontSize: 'var(--t-12)',
};
const HEAD: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-3)',
  padding: 'var(--sp-3) var(--sp-3) var(--sp-3) var(--sp-5)',
  borderBottom: '1px solid var(--line-soft)',
  cursor: 'grab',
  touchAction: 'none',
  userSelect: 'none',
};
const BODY: CSSProperties = {
  display: 'grid',
  gap: 'var(--sp-5)',
  padding: 'var(--sp-5)',
  overflowY: 'auto',
  minHeight: 0,
};

interface BodyProps extends AntennaCardProps {
  unit: AntennaUnit;
  position: number;
  count: number;
  readOnly: boolean;
  projectId: string | null;
}

function sameSize(a: { w: number; h: number }, b: { w: number; h: number }): boolean {
  return a.w === b.w && a.h === b.h;
}

function CardBody(props: BodyProps): ReactElement {
  const { unit, stageHost: host, boxRect, readOnly } = props;
  const card = useRef<HTMLDivElement>(null);
  const grab = useRef<{ dx: number; dy: number } | null>(null);
  const drag = useSyncExternalStore(subscribeDrag, getDragged, getDragged);
  const layers = useWorkspace((s) => s.project?.manifest.layers);
  const [size, setSize] = useState({ w: CARD_W, h: CARD_H });
  const [stage, setStage] = useState({ w: host.clientWidth, h: host.clientHeight });

  // the card's own size and the stage's, read after each render and on resizes; state changes
  // only when a size does, so this settles at once
  useLayoutEffect(() => {
    const measure = () => {
      const el = card.current;
      if (el) {
        const next = { w: el.offsetWidth || CARD_W, h: el.offsetHeight || CARD_H };
        setSize((s) => (sameSize(s, next) ? s : next));
      }
      const st = { w: host.clientWidth, h: host.clientHeight };
      setStage((s) => (sameSize(s, st) ? s : st));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    if (card.current) ro.observe(card.current);
    return () => {
      ro.disconnect();
    };
  }, [host, unit.id]);

  const at = placeCard(boxRect, { x: 0, y: 0, w: stage.w, h: stage.h }, size, drag);
  const entries = useMemo(
    () => photoEntries(unit, props.projectId, layers ?? []),
    [unit, props.projectId, layers],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest('button')) return;
    const hb = host.getBoundingClientRect();
    grab.current = { dx: e.clientX - hb.left - at.x, dy: e.clientY - hb.top - at.y };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* no pointer capture (tests): moves still arrive while over the header */
    }
    e.preventDefault();
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = grab.current;
    if (!g) return;
    const hb = host.getBoundingClientRect();
    const raw = { x: e.clientX - hb.left - g.dx, y: e.clientY - hb.top - g.dy };
    const p = placeCard(null, { x: 0, y: 0, w: stage.w, h: stage.h }, size, raw);
    setDragged({ x: p.x, y: p.y });
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!grab.current) return;
    grab.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
  };

  const leader = boxRect && !at.docked ? leaderLine(boxRect, at, size) : null;
  const decide = (status: Exclude<AntennaStatus, 'draft'>) => {
    void decideAntenna(status);
  };
  const reason = readOnly ? { disabledReason: t('telecom.antennas.readOnly') } : {};

  return (
    <>
      {leader ? (
        <svg
          aria-hidden="true"
          data-testid="antenna-card-leader"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            overflow: 'visible',
            zIndex: 'var(--z-stage-ui)',
          }}
        >
          <line
            x1={leader.x1}
            y1={leader.y1}
            x2={leader.x2}
            y2={leader.y2}
            stroke="var(--fg-1)"
            strokeWidth={1}
          />
          <circle cx={leader.x1} cy={leader.y1} r={2.5} fill="var(--fg-0)" />
        </svg>
      ) : null}
      <div
        ref={card}
        role="region"
        aria-label={unit.name}
        data-testid="antenna-card"
        data-docked={at.docked ? 'true' : undefined}
        style={{ ...CARD, left: at.x, top: at.y }}
      >
        <div
          data-testid="antenna-card-head"
          style={HEAD}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          <span
            aria-hidden="true"
            style={{
              flex: 'none',
              width: 10,
              height: 10,
              borderRadius: 'var(--r-2)',
              background: KIND_COLOURS[unit.kind],
            }}
          />
          <strong
            style={{
              fontSize: 'var(--t-14)',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {unit.name}
          </strong>
          <span style={{ flex: 'none', display: 'inline-flex' }}>
            <Chip kind="status" tone={TONE[unit.status]}>
              {t(`telecom.antennas.status.${unit.status}`)}
            </Chip>
          </span>
          <span style={{ color: 'var(--fg-3)' }}>
            {t(`telecom.antennas.card.kind.${unit.kind}`)}
          </span>
          <span style={{ flex: 1 }} />
          <span
            className="mono"
            data-testid="antenna-card-position"
            style={{ color: 'var(--fg-2)', whiteSpace: 'nowrap' }}
          >
            {t('telecom.antennas.card.position', {
              i: props.position < 0 ? DASH : props.position + 1,
              n: props.count,
            })}
          </span>
          <IconButton
            icon="chev-r"
            label={t('telecom.antennas.card.prev')}
            data-testid="antenna-card-prev"
            style={{ transform: 'scaleX(-1)' }}
            onClick={() => {
              stepAntenna(-1);
            }}
          />
          <IconButton
            icon="chev-r"
            label={t('telecom.antennas.card.next')}
            data-testid="antenna-card-next"
            onClick={() => {
              stepAntenna(1);
            }}
          />
          <IconButton
            icon="x"
            label={t('telecom.antennas.card.close')}
            data-testid="antenna-card-close"
            onClick={() => {
              selectAntenna(null);
            }}
          />
        </div>
        <div style={BODY}>
          <PhotoStrip key={unit.id} entries={entries} />
          <Values unit={unit} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-4)' }}>
            <Button
              size="lg"
              icon="check"
              variant={unit.status === 'accepted' ? 'primary' : 'secondary'}
              data-testid="antenna-card-accept"
              pressed={unit.status === 'accepted'}
              {...reason}
              onClick={() => {
                decide('accepted');
              }}
            >
              {t('telecom.antennas.accept')} <Kbd>A</Kbd>
            </Button>
            <Button
              size="lg"
              icon="x"
              variant={unit.status === 'rejected' ? 'danger' : 'secondary'}
              data-testid="antenna-card-reject"
              pressed={unit.status === 'rejected'}
              {...reason}
              onClick={() => {
                decide('rejected');
              }}
            >
              {t('telecom.antennas.reject')} <Kbd>R</Kbd>
            </Button>
          </div>
          <details>
            <summary style={{ cursor: 'pointer', color: 'var(--fg-2)' }}>
              {t('telecom.antennas.card.more')}
            </summary>
            <div style={{ paddingTop: 'var(--sp-4)' }}>
              <AntennaUserFields
                unit={unit}
                readOnly={readOnly}
                onPatchUser={(fields) => {
                  void patchUnitUser(unit.id, fields);
                }}
              />
            </div>
          </details>
        </div>
      </div>
    </>
  );
}

/** From the box's right-middle to the card's left edge, or its left-middle to the right edge. */
function leaderLine(
  box: Rect,
  card: { x: number; y: number },
  size: { w: number; h: number },
): { x1: number; y1: number; x2: number; y2: number } {
  const y1 = box.y + box.h / 2;
  const right = card.x >= box.x + box.w;
  const inset = Math.min(12, size.h / 2);
  return {
    x1: right ? box.x + box.w : box.x,
    y1,
    x2: right ? card.x : card.x + size.w,
    y2: Math.min(Math.max(y1, card.y + inset), card.y + size.h - inset),
  };
}

/** The card for the selected unit, drawn in `stageHost`; nothing without a selection. */
export function AntennaCard(props: AntennaCardProps): ReactElement | null {
  const file = useAntennas((s) => s.file);
  const filter = useAntennas((s) => s.filter);
  const selected = useAntennas((s) => s.selected);
  const readOnly = useAntennas((s) => s.readOnly);
  const projectId = useAntennas((s) => s.projectId);
  const list = useMemo(() => filteredUnits(file, filter), [file, filter]);
  const unit = file?.units.find((u) => u.id === selected) ?? null;
  useAntennaKeys(unit !== null);
  if (!unit) return null;
  return createPortal(
    <CardBody
      {...props}
      unit={unit}
      position={list.findIndex((u) => u.id === unit.id)}
      count={list.length}
      readOnly={readOnly}
      projectId={projectId}
    />,
    props.stageHost,
  );
}
