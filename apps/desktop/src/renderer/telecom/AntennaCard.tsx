/**
 * The floating antenna card: the selected unit's photos, values and review buttons beside its box
 * in the 3D stage, with a leader line to the box. The header drags it; once dragged it stays where
 * it was put for the session (until `resetCardDrag`). A, R, the arrows and Esc work while it shows
 * a unit (`useAntennaKeys`). Its photo strip, values and kind pick are the inline details'
 * (`AntennaDetails`).
 */
import type { AntennaStatus, AntennaUnit } from '@aio/schema';
import { Button, Chip, IconButton, Kbd, Tip, t } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import {
  DASH,
  KindPick,
  MUTED,
  PhotoStrip,
  Values,
  kindBasisText,
  photoEntries,
} from './AntennaDetails';
import { AntennaTypedValues } from './AntennaTypedValues';
import { AntennaUserFields } from './AntennaUserFields';
import { TONE } from './antennaFormat';
import { KIND_COLOURS } from './antennaScene';
import { askDeleteAntennas } from './antennaDelete';
import {
  beginFlag,
  decideAntenna,
  filteredUnits,
  patchUnitUser,
  selectAntenna,
  stepAntenna,
  useAntennas,
} from './antennaStore';
import { LABELS_CONTROL_SELECTOR } from './AntennaLabelsControl';
import { AVOID_WEIGHT, leaderLine, placeCard, type AvoidArea, type Rect } from './cardPlacement';
import { useAntennaKeys } from './useAntennaKeys';

export interface AntennaCardProps {
  /** The element the card is drawn in (the stage's canvas parent, positioned). */
  stageHost: HTMLElement;
  /** The selected box on screen, in CSS pixels relative to `stageHost`; null when not in view. */
  boxRect: Rect | null;
  /** The selected unit's box and labels, weighted, for when no spot clears `boxRect`. */
  avoid?: readonly AvoidArea[];
}

// ---------------------------------------------------------------- session drag position

let dragged: { x: number; y: number } | null = null;
const dragListeners = new Set<() => void>();

function setDragged(next: { x: number; y: number } | null): void {
  dragged = next;
  for (const l of dragListeners) l();
}

/** Marks the floating card for other stage overlays that keep clear of it (e.g. the RF coverage card). */
export const ANTENNA_CARD_SELECTOR = '[data-antenna-card]';

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

export { STRIP_MAX_H, STRIP_MIN_H, stripHeight } from './AntennaDetails';

const CARD_W = 320;
/** Assumed until the card has been measured once. */
const CARD_H = 420;

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
  display: 'grid',
  gap: 'var(--sp-1)',
  padding: 'var(--sp-3) var(--sp-3) var(--sp-3) var(--sp-5)',
  borderBottom: '1px solid var(--line-soft)',
  cursor: 'grab',
  touchAction: 'none',
  userSelect: 'none',
};
const HEAD_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-3)',
};
/** The middle of the card (photos, values, more) scrolls when the card is capped. */
const BODY: CSSProperties = {
  flex: '1 1 auto',
  overflowY: 'auto',
  minHeight: 0,
};
const BODY_INNER: CSSProperties = {
  display: 'grid',
  gap: 'var(--sp-5)',
  padding: 'var(--sp-5)',
};
const KIND_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-3)',
  minWidth: 0,
};

/** Accept and Reject stay in view below the scrolling middle; Redraw and Delete under them. */
const FOOT: CSSProperties = {
  flex: 'none',
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 'var(--sp-4)',
  padding: 'var(--sp-4) var(--sp-5) var(--sp-5)',
  borderTop: '1px solid var(--line-soft)',
};

interface BodyProps extends AntennaCardProps {
  unit: AntennaUnit;
  position: number;
  count: number;
  readOnly: boolean;
  projectId: string | null;
}

const NO_AREAS: readonly AvoidArea[] = [];

function sameSize(a: { w: number; h: number }, b: { w: number; h: number }): boolean {
  return a.w === b.w && a.h === b.h;
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && sameSize(a, b);
}

function CardBody(props: BodyProps): ReactElement {
  const { unit, stageHost: host, boxRect, readOnly } = props;
  const running = useAntennas((s) => s.running);
  const flagBusy = useAntennas((s) => s.flagStarting || s.flagJob !== null);
  const card = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const grab = useRef<{ dx: number; dy: number } | null>(null);
  const drag = useSyncExternalStore(subscribeDrag, getDragged, getDragged);
  const layers = useWorkspace((s) => s.project?.manifest.layers);
  const [size, setSize] = useState({ w: CARD_W, h: CARD_H });
  const [stage, setStage] = useState({ w: host.clientWidth, h: host.clientHeight });
  // the Labels control in the stage's bottom-left corner: the card keeps clear of it
  const [control, setControl] = useState<Rect | null>(null);

  // the card's own size and the stage's, read after each render and on resizes; state changes
  // only when a size does, so this settles at once
  useLayoutEffect(() => {
    const measure = () => {
      const el = card.current;
      if (el) {
        // the full height, as if not capped: the scrolling middle at its content's height
        const scroller = body.current;
        const inner = scroller?.firstElementChild as HTMLElement | null | undefined;
        const capped = scroller && inner ? inner.offsetHeight - scroller.clientHeight : 0;
        const next = { w: el.offsetWidth || CARD_W, h: el.offsetHeight + capped || CARD_H };
        setSize((s) => (sameSize(s, next) ? s : next));
      }
      const st = { w: host.clientWidth, h: host.clientHeight };
      setStage((s) => (sameSize(s, st) ? s : st));
      const c = host.querySelector<HTMLElement>(LABELS_CONTROL_SELECTOR);
      const r = c ? { x: c.offsetLeft, y: c.offsetTop, w: c.offsetWidth, h: c.offsetHeight } : null;
      setControl((o) => (sameRect(o, r) ? o : r));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    if (card.current) ro.observe(card.current);
    const inner = body.current?.firstElementChild;
    if (inner) ro.observe(inner);
    const c = host.querySelector(LABELS_CONTROL_SELECTOR);
    if (c) ro.observe(c);
    return () => {
      ro.disconnect();
    };
  }, [host, unit.id]);

  const at = placeCard(boxRect, { x: 0, y: 0, w: stage.w, h: stage.h }, size, drag, {
    reserved: control ? [control] : [],
    areas: props.avoid ?? NO_AREAS,
  });
  const entries = useMemo(
    () => photoEntries(unit, props.projectId, layers ?? []),
    [unit, props.projectId, layers],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // a control in the header (the arrows, the kind picker) is used, not dragged
    if (e.button !== 0 || (e.target as Element).closest('button, select, input')) return;
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

  const unitBox = props.avoid?.find((a) => a.weight === AVOID_WEIGHT.box)?.rect;
  // the line meets the card as drawn: at its capped height, on the side placement chose
  const leader = boxRect
    ? leaderLine(at.anchor ?? boxRect, at, { w: size.w, h: at.maxH ?? size.h }, at.side)
    : null;
  const decide = (status: Exclude<AntennaStatus, 'draft'>) => {
    void decideAntenna(status);
  };
  const reason = readOnly ? { disabledReason: t('telecom.antennas.readOnly') } : {};
  // Redraw outline starts the flag tool, refused while a detection or a flag job runs
  const redrawWhy = readOnly
    ? t('telecom.antennas.readOnly')
    : running
      ? t('telecom.antennas.running')
      : flagBusy
        ? t('telecom.antennas.flag.busy')
        : null;
  const kindWord = t(`telecom.antennas.card.kind.${unit.kind}`);
  const kindBasis = kindBasisText(unit);

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
        data-antenna-card=""
        data-docked={at.docked ? 'true' : undefined}
        // the selected box on screen (x y w h, host px), for checks that the card keeps off it
        data-unit-box={unitBox ? `${unitBox.x} ${unitBox.y} ${unitBox.w} ${unitBox.h}` : undefined}
        data-capped={at.maxH !== undefined ? 'true' : undefined}
        style={{
          ...CARD,
          left: at.x,
          top: at.y,
          ...(at.maxH !== undefined ? { maxHeight: at.maxH } : {}),
        }}
      >
        <div
          data-testid="antenna-card-head"
          style={HEAD}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          <div style={HEAD_ROW}>
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
            <span style={{ flex: 1 }} />
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
          <div style={KIND_ROW}>
            {/* the kind and how it was found, whole: they wrap rather than get cut */}
            <Tip content={`${kindWord} · ${kindBasis}`} placement="top" repeatsName>
              <span
                data-testid="antenna-card-kind"
                tabIndex={0}
                style={{ ...MUTED, flex: '1 1 auto', lineHeight: 1.3, overflowWrap: 'anywhere' }}
              >
                {kindWord} · <span data-testid="antenna-card-kind-basis">{kindBasis}</span>
              </span>
            </Tip>
            <KindPick unit={unit} readOnly={readOnly} testId="antenna-card-kind-pick" />
          </div>
        </div>
        <div ref={body} data-testid="antenna-card-body" style={BODY}>
          <div style={BODY_INNER}>
            <PhotoStrip key={unit.id} entries={entries} />
            <Values unit={unit} />
            <AntennaTypedValues key={unit.id} unit={unit} readOnly={readOnly} />
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
        <div data-testid="antenna-card-actions" style={FOOT}>
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
          <Button
            variant="quiet"
            icon="polygon"
            data-testid="antenna-card-redraw"
            {...(redrawWhy ? { disabledReason: redrawWhy } : {})}
            onClick={() => {
              beginFlag(unit.id);
            }}
          >
            {t('telecom.antennas.card.redraw')}
          </Button>
          {unit.origin === 'flagged' ? (
            <Button
              variant="quiet"
              icon="trash"
              data-testid="antenna-card-delete"
              {...reason}
              onClick={() => {
                askDeleteAntennas([unit.id]);
              }}
            >
              {t('telecom.antennas.card.delete')}
            </Button>
          ) : null}
        </div>
      </div>
    </>
  );
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
