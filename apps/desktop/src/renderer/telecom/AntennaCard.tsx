/**
 * The floating antenna card: the selected unit's photos, values and review buttons beside its box
 * in the 3D stage, with a leader line to the box. The header drags it; once dragged it stays where
 * it was put for the session (until `resetCardDrag`). A, R, the arrows and Esc work while it shows
 * a unit (`useAntennaKeys`).
 */
import type { AntennaStatus, AntennaUnit, AntennaValue, Layer } from '@aio/schema';
import { Button, Chip, IconButton, Kbd, Tip, t } from '@aio/ui';
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
import { TONE, formatDeg, qualityTip, trueAzimuth } from './antennaFormat';
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
  position: 'relative',
  display: 'block',
  width: '100%',
  height: '100%',
  objectFit: 'contain',
};

/** The strip's height bounds, CSS pixels; within them it follows the image's aspect. */
export const STRIP_MIN_H = 140;
export const STRIP_MAX_H = 260;
/** Until an image has loaded, the strip's height; in a DOM without layout, its width. */
const STRIP_H = 180;
const STRIP_W = 288;

/** The strip's height for an image `w` x `h` shown `width` wide: its aspect, within the bounds. */
export function stripHeight(w: number, h: number, width: number): number {
  if (!(w > 0) || !(h > 0)) return STRIP_H;
  return Math.round(Math.min(STRIP_MAX_H, Math.max(STRIP_MIN_H, (width * h) / w)));
}

/** Told the loaded image's natural size and the strip's width, for the strip's height. */
type OnSize = (w: number, h: number, width: number) => void;
const sizeOf =
  (onSize: OnSize) =>
  (e: { currentTarget: HTMLImageElement }): void => {
    const img = e.currentTarget;
    const width = img.parentElement?.clientWidth ?? 0;
    onSize(img.naturalWidth, img.naturalHeight, width > 0 ? width : STRIP_W);
  };

/** A linked photo fitted in the card: its thumbnail, else the full image. */
function FittedPhoto({
  full,
  onShown,
  onSize,
}: {
  full: string;
  onShown: (src: string) => void;
  onSize: OnSize;
}): ReactElement {
  const [src, setSrc] = useState(() => thumbUrl(full));
  return (
    <img
      src={src}
      alt=""
      decoding="async"
      draggable={false}
      data-testid="antenna-photo-img"
      style={IMG}
      onLoad={(e) => {
        onShown(src);
        sizeOf(onSize)(e);
      }}
      onError={() => {
        if (src !== full) setSrc(full);
      }}
    />
  );
}

const STRIP: CSSProperties = {
  position: 'relative',
  borderRadius: 'var(--r-4)',
  overflow: 'hidden',
  background: 'var(--bg-0)',
};
/**
 * The same image, blurred and darkened, filling the strip behind a narrow one, so a portrait crop
 * has no black bars beside it. Grown past the strip so the blur has no light edge.
 */
const FILL: CSSProperties = {
  position: 'absolute',
  inset: -24,
  backgroundSize: 'cover',
  backgroundPosition: 'center',
  filter: 'blur(16px) brightness(0.55)',
  pointerEvents: 'none',
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
  const [height, setHeight] = useState(STRIP_H);
  // the image the fill repeats: the crop, or a photo's thumbnail once it has loaded
  const [shown, setShown] = useState<{ of: string; src: string } | null>(null);
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
  const onSize: OnSize = (w, h, width) => {
    setHeight(stripHeight(w, h, width));
  };
  const url = entry?.url ?? null;
  const fill = entry?.kind === 'crop' ? url : shown?.of === url ? shown.src : null;
  return (
    <div style={{ ...STRIP, height }} data-testid="antenna-card-photos">
      {fill ? (
        <div
          aria-hidden="true"
          data-testid="antenna-photo-fill"
          style={{ ...FILL, backgroundImage: `url(${JSON.stringify(fill)})` }}
        />
      ) : null}
      {entry?.kind === 'crop' ? (
        <img
          src={entry.url}
          alt=""
          data-testid="antenna-crop"
          draggable={false}
          style={IMG}
          onLoad={sizeOf(onSize)}
        />
      ) : url ? (
        <FittedPhoto
          key={url}
          full={url}
          onShown={(src) => {
            setShown({ of: url, src });
          }}
          onSize={onSize}
        />
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
          style={{
            flex: 'none',
            whiteSpace: 'nowrap',
            fontSize: 'var(--t-11)',
            color: 'var(--fg-0)',
          }}
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

const MUTED: CSSProperties = { fontSize: 'var(--t-11)', color: 'var(--fg-3)' };

/** How a value was found and how well it fits: "Measured · Fit residual 3.0 mm, ...". */
function basisTip(v: AntennaValue, extra?: string): string {
  const basis = t(`telecom.antennas.basis.${v.basis}`);
  const quality = qualityTip(v);
  return [basis, quality === basis ? null : quality, extra ?? null]
    .filter((x): x is string => x !== null)
    .join(' · ');
}

function Value({
  name,
  label,
  v,
  big,
  wide,
  note,
  tip,
  children,
}: {
  name: string;
  label: string;
  /** The value behind the text: its basis and fit quality show as a tip. */
  v?: AntennaValue | undefined;
  big?: boolean;
  /** Takes the whole row and wraps rather than cut its text (W × H × D). */
  wide?: boolean;
  /** A short muted line under the value; its whole sentence joins the tip. */
  note?: { short: string; full: string } | undefined;
  /** The tip of a value made of several (W × H × D). */
  tip?: string | undefined;
  children: ReactNode;
}): ReactElement {
  const content = v ? basisTip(v, note?.full) : tip;
  return (
    <div
      style={{
        display: 'grid',
        gap: 'var(--sp-1)',
        minWidth: 0,
        ...(wide ? { gridColumn: '1 / -1' } : null),
      }}
    >
      <dt style={LABEL}>{label}</dt>
      <dd
        className="mono"
        data-value={name}
        data-basis={v?.basis}
        style={{
          margin: 0,
          fontSize: big ? 'var(--t-20)' : 'var(--t-12)',
          color: 'var(--fg-0)',
          ...(wide
            ? { overflowWrap: 'anywhere' }
            : { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }),
        }}
      >
        {content ? (
          <Tip content={content} placement="top">
            {/* a value not measured directly reads with a dotted underline */}
            <span
              tabIndex={0}
              style={
                v && v.basis !== 'measured'
                  ? { textDecoration: 'underline dotted var(--fg-3)', textUnderlineOffset: 4 }
                  : undefined
              }
            >
              {children}
            </span>
          </Tip>
        ) : (
          children
        )}
      </dd>
      {note ? (
        <small data-note={name} style={MUTED}>
          {note.short}
        </small>
      ) : null}
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
  const size = `${metres(unit.widthM)} × ${metres(unit.heightM)} × ${metres(unit.depthM)} m`;
  return (
    <dl style={GRID}>
      <Value name="azimuth" label={t('telecom.antennas.value.azimuth')} v={unit.azimuthGridDeg} big>
        {azimuthText(unit)}
      </Value>
      {dish ? (
        <>
          <Value
            name="elevation"
            label={t('telecom.antennas.value.elevation')}
            v={unit.elevationDeg}
            big
          >
            {deg(unit.elevationDeg, true)}
          </Value>
          <Value
            name="diameter"
            label={t('telecom.antennas.value.diameter')}
            v={unit.diameterM}
            big
          >
            {unit.diameterM ? `${unit.diameterM.value.toFixed(2)} m` : DASH}
          </Value>
        </>
      ) : (
        <>
          <Value
            name="downtilt"
            label={t('telecom.antennas.value.downtilt')}
            v={unit.downtiltDeg}
            big
            note={{
              short: t('telecom.antennas.mechanical.short'),
              full: t('telecom.antennas.mechanical'),
            }}
          >
            {deg(unit.downtiltDeg)}
          </Value>
          <Value name="plumb" label={t('telecom.antennas.value.plumb')} v={unit.plumbDeg} big>
            {deg(unit.plumbDeg, true)}
          </Value>
        </>
      )}
      <Value name="altitude" label={t('telecom.antennas.card.altitude')}>
        {`${unit.box.centre[2].toFixed(1)} m`}
      </Value>
      <Value name="points" label={t('telecom.antennas.card.points')}>
        {unit.support.toLocaleString()}
      </Value>
      <Value
        name="size"
        label={t('telecom.antennas.card.size')}
        wide
        tip={[unit.widthM, unit.heightM, unit.depthM].map((v) => basisTip(v)).join(' / ')}
      >
        {size}
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
const ELLIPSIS: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
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
  const kindWord = t(`telecom.antennas.card.kind.${unit.kind}`);
  const provider = unit.kindBasis === 'ai' ? unit.ai?.provider : undefined;
  const kindBasis = provider
    ? t('telecom.antennas.kindBasis.aiBy', { provider })
    : t(`telecom.antennas.kindBasis.${unit.kindBasis}`);

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
          {/* the name never gives way: the kind beside it shrinks first */}
          <strong
            data-testid="antenna-card-name"
            style={{ flex: 'none', fontSize: 'var(--t-14)', whiteSpace: 'nowrap' }}
          >
            {unit.name}
          </strong>
          <span style={{ flex: 'none', display: 'inline-flex' }}>
            <Chip kind="status" tone={TONE[unit.status]}>
              {t(`telecom.antennas.status.${unit.status}`)}
            </Chip>
          </span>
          <span
            data-testid="antenna-card-kind"
            title={`${kindWord} · ${kindBasis}`}
            style={{ flex: '1 1 auto', minWidth: 0, display: 'grid', lineHeight: 1.2 }}
          >
            <span style={{ ...ELLIPSIS, color: 'var(--fg-3)' }}>{kindWord}</span>
            <small data-testid="antenna-card-kind-basis" style={{ ...ELLIPSIS, ...MUTED }}>
              {kindBasis}
            </small>
          </span>
          <span
            className="mono"
            data-testid="antenna-card-position"
            style={{ flex: 'none', color: 'var(--fg-2)', whiteSpace: 'nowrap' }}
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
