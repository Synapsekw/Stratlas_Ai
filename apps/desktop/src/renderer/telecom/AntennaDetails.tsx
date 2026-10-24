/**
 * The selected antenna's details, open inline under its row in the Antennas group: prev and next
 * through the filtered list, the kind pick, the photo strip, the values with their basis as a tip,
 * "Your values", "Model, weight, frequencies", then Accept (A), Reject (R), Redraw outline and
 * Delete (any unit, detected or flagged; it asks first). The photo strip, values and kind pick are
 * also the floating card's until it is retired.
 */
import type { AntennaKind, AntennaStatus, AntennaUnit, AntennaValue, Layer } from '@aio/schema';
import { Button, Chip, IconButton, Kbd, Tip, t } from '@aio/ui';
import { assetUrl, useWorkspace } from '@aio/workspace';
import {
  useMemo,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { openPhoto } from '../builder/photoOpen';
import { thumbUrl } from '../thumbs/Thumb';
import { askDeleteAntennas } from './antennaDelete';
import { formatDeg, qualityTip, trueAzimuth } from './antennaFormat';
import {
  beginFlag,
  decideAntenna,
  patchUnitUser,
  setUnitKind,
  stepAntenna,
  useAntennas,
} from './antennaStore';
import { isNotMeasured } from './antennaTyped';
import { AntennaTypedValues } from './AntennaTypedValues';
import { AntennaUserFields } from './AntennaUserFields';

// ---------------------------------------------------------------- formatting

/** A value the unit does not have: a symbol, the same in every language. */
export const DASH = '—';

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

export type PhotoEntry =
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
export function photoEntries(
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

/** A linked photo fitted in the strip: its thumbnail, else the full image. */
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

/** The crop and the linked photos, one at a time. Key it by the unit id. */
export function PhotoStrip({ entries }: { entries: PhotoEntry[] }): ReactElement {
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

/** A short muted line: a note under a value, how a kind was found. */
export const MUTED: CSSProperties = { fontSize: 'var(--t-11)', color: 'var(--fg-3)' };

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
        <dd data-note={name} style={{ margin: 0, ...MUTED }}>
          {note.short}
        </dd>
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

/** Azimuth, downtilt and plumb (elevation and diameter for a dish), altitude, points, W × H × D. */
export function Values({ unit }: { unit: AntennaUnit }): ReactElement {
  const dish = unit.kind === 'dish';
  // a flagged unit with too few points has nothing measured: say so instead of a dash
  const none = isNotMeasured(unit);
  const missing = none ? t('telecom.antennas.notMeasured') : DASH;
  const missingTip = none ? t('telecom.antennas.notMeasured.tip') : undefined;
  const sizes = [unit.widthM, unit.heightM, unit.depthM];
  const size =
    none && sizes.every((v) => v === undefined)
      ? missing
      : `${metres(unit.widthM)} × ${metres(unit.heightM)} × ${metres(unit.depthM)} m`;
  return (
    <dl style={GRID}>
      <Value
        name="azimuth"
        label={t('telecom.antennas.value.azimuth')}
        v={unit.azimuthGridDeg}
        tip={unit.azimuthGridDeg ? undefined : missingTip}
        big
      >
        {unit.azimuthGridDeg ? azimuthText(unit) : missing}
      </Value>
      {dish ? (
        <>
          <Value
            name="elevation"
            label={t('telecom.antennas.value.elevation')}
            v={unit.elevationDeg}
            tip={unit.elevationDeg ? undefined : missingTip}
            big
          >
            {unit.elevationDeg ? deg(unit.elevationDeg, true) : missing}
          </Value>
          <Value
            name="diameter"
            label={t('telecom.antennas.value.diameter')}
            v={unit.diameterM}
            tip={unit.diameterM ? undefined : missingTip}
            big
          >
            {unit.diameterM ? `${unit.diameterM.value.toFixed(2)} m` : missing}
          </Value>
        </>
      ) : (
        <>
          <Value
            name="downtilt"
            label={t('telecom.antennas.value.downtilt')}
            v={unit.downtiltDeg}
            tip={unit.downtiltDeg ? undefined : missingTip}
            big
            note={
              unit.downtiltDeg
                ? {
                    short: t('telecom.antennas.mechanical.short'),
                    full: t('telecom.antennas.mechanical'),
                  }
                : undefined
            }
          >
            {unit.downtiltDeg ? deg(unit.downtiltDeg) : missing}
          </Value>
          <Value
            name="plumb"
            label={t('telecom.antennas.value.plumb')}
            v={unit.plumbDeg}
            tip={unit.plumbDeg ? undefined : missingTip}
            big
          >
            {unit.plumbDeg ? deg(unit.plumbDeg, true) : missing}
          </Value>
        </>
      )}
      <Value name="altitude" label={t('telecom.antennas.card.altitude')} v={unit.centreHeightM}>
        {`${(unit.centreHeightM?.value ?? unit.box.centre[2]).toFixed(1)} m`}
      </Value>
      <Value name="points" label={t('telecom.antennas.card.points')}>
        {unit.support.toLocaleString()}
      </Value>
      <Value
        name="size"
        label={t('telecom.antennas.card.size')}
        wide
        tip={
          sizes.every((v) => v === undefined)
            ? missingTip
            : sizes.map((v) => (v ? basisTip(v) : DASH)).join(' / ')
        }
      >
        {size}
      </Value>
    </dl>
  );
}

// ---------------------------------------------------------------- kind

/** The kinds a person can pick, in the order of the review walk. */
const KINDS: readonly AntennaKind[] = ['panel', 'short', 'dish', 'other'];

/** The kind a person picks (basis `user`); read-only shows why it is disabled. */
export function KindPick({
  unit,
  readOnly,
  testId,
}: {
  unit: AntennaUnit;
  readOnly: boolean;
  testId: string;
}): ReactElement {
  const pick = (
    <select
      className="input sm"
      data-testid={testId}
      aria-label={t('telecom.antennas.card.kind')}
      value={unit.kind}
      disabled={readOnly}
      style={{ flex: 'none' }}
      onChange={(e) => {
        void setUnitKind(unit.id, e.target.value as AntennaKind);
      }}
    >
      {KINDS.map((k) => (
        <option key={k} value={k}>
          {t(`telecom.antennas.card.kind.${k}`)}
        </option>
      ))}
    </select>
  );
  return readOnly ? (
    <Tip content={t('telecom.antennas.readOnly')} placement="top">
      {pick}
    </Tip>
  ) : (
    pick
  );
}

/** How the unit's kind was found: from geometry, set by you, labelled by AI (provider). */
export function kindBasisText(unit: AntennaUnit): string {
  const provider = unit.kindBasis === 'ai' ? unit.ai?.provider : undefined;
  return provider
    ? t('telecom.antennas.kindBasis.aiBy', { provider })
    : t(`telecom.antennas.kindBasis.${unit.kindBasis}`);
}

// ---------------------------------------------------------------- the details

export interface AntennaDetailsProps {
  unit: AntennaUnit;
  readOnly: boolean;
  /** The unit's index in the filtered list, or -1 when it is not in it. */
  position: number;
  count: number;
  /** The details' box, for the list that measures it. */
  ref?: Ref<HTMLDivElement>;
}

const HEAD: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-3)',
  minWidth: 0,
};

export function AntennaDetails({
  unit,
  readOnly,
  position,
  count,
  ref,
}: AntennaDetailsProps): ReactElement {
  const running = useAntennas((s) => s.running);
  const flagBusy = useAntennas((s) => s.flagStarting || s.flagJob !== null);
  const projectId = useAntennas((s) => s.projectId);
  const layers = useWorkspace((s) => s.project?.manifest.layers);
  const entries = useMemo(
    () => photoEntries(unit, projectId, layers ?? []),
    [unit, projectId, layers],
  );
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

  return (
    <div ref={ref} className="antenna-details" data-testid="antenna-details">
      <div style={HEAD}>
        <KindPick unit={unit} readOnly={readOnly} testId="antenna-details-kind-pick" />
        <span
          data-testid="antenna-details-kind-basis"
          style={{ ...MUTED, flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere' }}
        >
          {kindBasisText(unit)}
        </span>
        <span
          className="mono"
          data-testid="antenna-details-position"
          style={{ flex: 'none', color: 'var(--fg-2)', whiteSpace: 'nowrap' }}
        >
          {t('telecom.antennas.card.position', {
            i: position < 0 ? DASH : position + 1,
            n: count,
          })}
        </span>
        <IconButton
          icon="chev-r"
          label={t('telecom.antennas.card.prev')}
          data-testid="antenna-details-prev"
          style={{ transform: 'scaleX(-1)' }}
          onClick={() => {
            stepAntenna(-1);
          }}
        />
        <IconButton
          icon="chev-r"
          label={t('telecom.antennas.card.next')}
          data-testid="antenna-details-next"
          onClick={() => {
            stepAntenna(1);
          }}
        />
      </div>
      {unit.origin === 'flagged' || unit.notFoundInLatest ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)' }}>
          {unit.origin === 'flagged' ? (
            <span data-testid="antenna-origin">
              <Chip kind="tag">{t('telecom.antennas.origin.flagged')}</Chip>
            </span>
          ) : null}
          {unit.notFoundInLatest ? <Chip kind="tag">{t('telecom.antennas.notFound')}</Chip> : null}
        </div>
      ) : null}
      <PhotoStrip key={`photos-${unit.id}`} entries={entries} />
      <Values unit={unit} />
      <AntennaTypedValues key={`typed-${unit.id}`} unit={unit} readOnly={readOnly} />
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
      <div className="antenna-details-actions" data-testid="antenna-details-actions">
        <Button
          size="sm"
          icon="check"
          variant={unit.status === 'accepted' ? 'primary' : 'secondary'}
          data-testid="antenna-details-accept"
          pressed={unit.status === 'accepted'}
          {...reason}
          onClick={() => {
            decide('accepted');
          }}
        >
          {t('telecom.antennas.accept')} <Kbd>A</Kbd>
        </Button>
        <Button
          size="sm"
          icon="x"
          variant={unit.status === 'rejected' ? 'danger' : 'secondary'}
          data-testid="antenna-details-reject"
          pressed={unit.status === 'rejected'}
          {...reason}
          onClick={() => {
            decide('rejected');
          }}
        >
          {t('telecom.antennas.reject')} <Kbd>R</Kbd>
        </Button>
        <span style={{ flex: 1 }} />
        <Button
          size="sm"
          variant="quiet"
          icon="polygon"
          data-testid="antenna-details-redraw"
          {...(redrawWhy ? { disabledReason: redrawWhy } : {})}
          onClick={() => {
            beginFlag(unit.id);
          }}
        >
          {t('telecom.antennas.card.redraw')}
        </Button>
        <IconButton
          icon="trash"
          label={t('project.antennas.deleteRow', { name: unit.name })}
          data-testid="antenna-details-delete"
          {...reason}
          onClick={() => {
            askDeleteAntennas([unit.id]);
          }}
        />
      </div>
    </div>
  );
}
