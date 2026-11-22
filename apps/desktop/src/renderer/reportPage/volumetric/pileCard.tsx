// One pile's card on the pile pages of the volumetric report (the founder-approved layout of
// 20 Nov 2026), two to a page:
//
// - the header: the pile's number and name, the change since the compared survey (a badge in
//   cubic metres, with the percentage only when the model gives one) and its volume, or "Not
//   computed" for a pile without one. A pile under zero prints its volume as computed, with the
//   note that the surface is below the base (D10);
// - three pictures at 4:3: the photo straight down with the outline and the A to B profile line
//   drawn over it from the ground it covers, the 3D view, and the compared survey's photo with
//   its outline alone. A missing picture leaves a quiet placeholder of the same size;
// - the elevation profile along A to B: the app's own `ProfileChart`, printed statically, with
//   the latest surface, the compared one and the base, shaded between the surface and the base.
//   The line fills the chart's box (`fill`, as the section window draws it) and the chart's own
//   note says how many times the heights are drawn: at a card's low, wide box a whole-step
//   exaggeration left most piles as a thin strip in a mostly empty plot;
// - six figures: footprint, base, base level, peak height, density and the survey date.
//
// Laid out by counts, never measured: what the name, the notes and the figures take beyond one
// line each comes off the chart (`chartHeightPx`), so two cards always fit a page and no text is
// cut, however long (D9).
import {
  pileTonnesShown,
  type VolumetricModel,
  type VolumetricPile,
  type VolumetricPileProfile,
} from '@aio/project/export';
import {
  REPORT_VIEWS_MAX,
  type ReportViewsFrame,
  type SurveyPrecision,
  type SurveyUnits,
} from '@aio/schema';
import type { ChartSeries } from '@aio/survey';
import { t } from '@aio/ui';
import type { ReactElement } from 'react';
import { autoExaggeration, plotOf } from '../../charts/exaggeration';
import { ProfileChart } from '../../charts/ProfileChart';
import type { Extent, PilePicture, ReportViews } from '../types/template';
import { num, signed, signedPct } from './chrome';

type CaptureRef = NonNullable<VolumetricModel['latest']>;

// ---------------------------------------------------------------- the card's budget

/** A card's height, mm: two of them and the page's heading fill the body (piles.css). */
export const CARD_H = 118;
/** The profile chart's width: the card's 182 mm in CSS pixels. */
export const CHART_W = 688;
const MM_PER_PX = 25.4 / 96;
/** The chart is never drawn lower than this (its axes alone take 16 mm), nor higher. */
const CHART_MIN = 25;
const CHART_MAX = 40;
/**
 * What a card takes beside its chart with one line of everything, mm (the sums of piles.css):
 * padding, header, pictures, their captions, the profile's margin and caption, the figures, and
 * 0.65 for its two rules and the rounding of the chart to whole pixels.
 */
const CARD_FIXED = 3 + 10.5 + 44.25 + 7.2 + 6.6 + 10.8 + 0.65;
/** Characters one line holds: the name beside the figures, a figure's value, a note. */
const NAME_LINE = 30;
/** Characters one picture caption line holds (59 mm at 7 pt, with room): a caption is one line. */
export const CAPTION_LINE = 40;
const VALUE_LINE = 24;
const NOTE_LINE = 150;
const NAME_LINE_MM = 5.1;
const FLAG_MM = 4.2;
const VALUE_LINE_MM = 4.4;
const NOTE_LINE_MM = 3.4;

const linesOf = (chars: number, perLine: number) => Math.max(1, Math.ceil(chars / perLine));

/**
 * The profile chart's height on a card, CSS pixels: what the card's fixed parts leave, less every
 * extra line the name, the flags under the header, the longest figure and the note take. A card
 * gives up nothing for the report's closing block: two cards fill their page, and the closing
 * block then has a page of its own (`pagePlan`).
 */
export function chartHeightPx(c: {
  nameChars: number;
  flags: number;
  valueChars: number;
  noteChars: number;
}): number {
  const extra =
    (linesOf(c.nameChars, NAME_LINE) - 1) * NAME_LINE_MM +
    c.flags * FLAG_MM +
    (linesOf(c.valueChars, VALUE_LINE) - 1) * VALUE_LINE_MM +
    (c.noteChars > 0 ? 1 + linesOf(c.noteChars, NOTE_LINE) * NOTE_LINE_MM : 0);
  const mm = CARD_H - CARD_FIXED - extra;
  return Math.round(Math.min(CHART_MAX, Math.max(CHART_MIN, mm)) / MM_PER_PX);
}

// ---------------------------------------------------------------- formats

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A date in short: "3 Sep 2026". */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  const month = MONTHS[Number(m) - 1] ?? '';
  return [String(Number(d)), month, y].filter(Boolean).join(' ');
}

const way = (v: number | null): string =>
  v === null || v === 0 ? 'is-flat' : v < 0 ? 'is-down' : 'is-up';

const fixed = (v: number, decimals: number) =>
  v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

const pct = (v: number) => `${(Math.round(v * 100000) / 1000).toFixed(3)}%`;

/** A previous volume under this (m³) is a pile that is new: its change reads "new". */
const NEW_UNDER_M3 = 1;

// ---------------------------------------------------------------- pictures

/** A pile picture's shape: 4 to 3, as it is taken. */
const PIC_ASPECT = 4 / 3;

/** The outline, and the A to B line when given, over a straight-down picture of `extent`. */
function Outline({
  extent,
  ring,
  line,
}: {
  extent: Extent;
  ring: readonly (readonly [number, number])[];
  line: Pick<VolumetricPileProfile, 'a' | 'b'> | null;
}): ReactElement {
  const [e0, n0, e1, n1] = extent;
  const w = e1 - e0;
  const h = n1 - n0;
  const x = (e: number) => (e - e0).toFixed(2);
  const y = (n: number) => (n1 - n).toFixed(2);
  const points = ring.map((p) => `${x(p[0])},${y(p[1])}`).join(' ');
  // drawn in metres on the ground; line widths and labels are a share of the picture's width
  const u = w / 100;
  const ends = line
    ? ([
        [t('mcard.endA'), line.a],
        [t('mcard.endB'), line.b],
      ] as const)
    : [];
  return (
    <svg
      className="vr-pile-over"
      viewBox={`0 0 ${w.toFixed(2)} ${h.toFixed(2)}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      {ring.length >= 3 ? (
        <>
          <polygon className="vr-pile-ring-halo" points={points} strokeWidth={u * 1.5} />
          <polygon className="vr-pile-ring" points={points} strokeWidth={u * 0.7} />
        </>
      ) : null}
      {line ? (
        <>
          <line
            className="vr-pile-axis-halo"
            x1={x(line.a[0])}
            y1={y(line.a[1])}
            x2={x(line.b[0])}
            y2={y(line.b[1])}
            strokeWidth={u * 1.1}
          />
          <line
            className="vr-pile-axis"
            x1={x(line.a[0])}
            y1={y(line.a[1])}
            x2={x(line.b[0])}
            y2={y(line.b[1])}
            strokeWidth={u * 0.5}
            strokeDasharray={`${(u * 1.8).toFixed(2)} ${(u * 1.4).toFixed(2)}`}
          />
          {ends.map(([label, at]) => (
            <g key={label} className="vr-pile-end">
              <circle cx={x(at[0])} cy={y(at[1])} r={u * 2.6} strokeWidth={u * 0.35} />
              <text x={x(at[0])} y={y(at[1])} fontSize={u * 3.4} dy={u * 1.2}>
                {label}
              </text>
            </g>
          ))}
        </>
      ) : null}
    </svg>
  );
}

/**
 * A pile's place on the site photo as a 4:3 window (a pile past the pictures' cap): the model's
 * square crop box, its full width and the middle three quarters of its height, with the ground
 * that window covers.
 */
function siteCrop(
  pile: VolumetricPile,
  frame: ReportViewsFrame | null,
  src: string | null,
): { src: string; extent: Extent; style: { width: string; left: string; top: string } } | null {
  const box = pile.crop;
  if (!src || !frame || !box || !(box.size > 0)) return null;
  const top = box.y + (box.size * (1 - 1 / PIC_ASPECT)) / 2;
  const height = box.size / PIC_ASPECT;
  const e0 = frame.extent[0] + box.x * frame.mPerPx;
  const n1 = frame.extent[3] - top * frame.mPerPx;
  return {
    src,
    extent: [e0, n1 - height * frame.mPerPx, e0 + box.size * frame.mPerPx, n1],
    style: {
      width: pct(frame.widthPx / box.size),
      left: pct(-box.x / box.size),
      top: pct(-top / height),
    },
  };
}

function Picture({
  kind,
  picture,
  crop,
  caption,
  children,
}: {
  kind: 'photo' | '3d' | 'before';
  picture: PilePicture | null;
  crop?: ReturnType<typeof siteCrop>;
  caption: string;
  children?: ReactElement | null;
}): ReactElement {
  const shown = picture !== null || (crop ?? null) !== null;
  return (
    <figure className={`vr-pile-pic${shown ? '' : ' is-empty'}`} data-pic={kind}>
      <span className="vr-pile-pic-box">
        {picture ? (
          <img src={picture.src} alt="" />
        ) : crop ? (
          <img className="is-crop" src={crop.src} alt="" style={crop.style} />
        ) : (
          <span className="vr-photo-none">{t('vreport.pictures.placeholder')}</span>
        )}
        {shown ? children : null}
      </span>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------- the profile

/** The report prints metres, as its figures do. */
const UNITS: SurveyUnits = {
  distance: 'm',
  area: 'm2',
  volume: 'm3',
  density: 't/m3',
  mass: 't',
  grade: 'percent',
};
const PRECISION: SurveyPrecision = { coordinate: 2, distance: 2, area: 1, volume: 1, grade: 1 };

/** The profile's lines as the shared chart draws them, each named as the key under it names it. */
function chartSeries(profile: VolumetricPileProfile): ChartSeries[] {
  return profile.series
    .filter((s) => s.z.filter((z) => z !== null).length >= 2)
    .map((s) => ({
      key: s.kind,
      kind: s.kind,
      label:
        s.kind === 'base'
          ? t(
              profile.baseKind === 'own'
                ? 'vreport.card.profile.base'
                : 'vreport.card.profile.boundary',
            )
          : t('vreport.card.profile.surface', { date: s.date ? shortDate(s.date) : '' }),
      ...(s.capture !== undefined ? { capture: s.capture } : {}),
      ...(s.date !== undefined ? { date: s.date } : {}),
      chainage: s.chainage,
      z: s.z,
    }));
}

function Profile({
  profile,
  height,
}: {
  profile: VolumetricPileProfile | null;
  height: number;
}): ReactElement {
  const series = profile ? chartSeries(profile) : [];
  const surfaces = series.filter((s) => s.kind !== 'base');
  const title = <span className="vr-pile-profile-title">{t('vreport.card.profile')}</span>;
  if (surfaces.length === 0)
    return (
      <figure className="vr-pile-profile is-empty">
        <figcaption>{title}</figcaption>
        <p className="vr-pile-profile-none" style={{ height: `${String(height)}px` }}>
          {t('vreport.card.profile.none')}
        </p>
      </figure>
    );
  const base = series.find((s) => s.kind === 'base');
  return (
    <figure className="vr-pile-profile">
      <figcaption>
        {title}
        <span className="vr-pile-key">
          {series.map((s) => (
            <span
              key={s.key}
              className={`vr-pile-key-item is-${s.kind}`}
              data-key={s.kind}
              data-base={s.kind === 'base' ? profile?.baseKind : undefined}
            >
              {s.label}
            </span>
          ))}
        </span>
      </figcaption>
      <ProfileChart
        series={series}
        shadeVs={base && series.some((s) => s.kind === 'current') ? base.key : null}
        exaggeration={autoExaggeration(series, plotOf(CHART_W, height))}
        fill
        ends={{ a: t('mcard.endA'), b: t('mcard.endB') }}
        units={UNITS}
        precision={PRECISION}
        width={CHART_W}
        height={height}
        interactive={false}
        testId="vreport-pile-profile"
      />
    </figure>
  );
}

// ---------------------------------------------------------------- the card

function Stat({
  id,
  label,
  value,
  quiet,
}: {
  id: string;
  label: string;
  value: string;
  quiet?: boolean;
}) {
  return (
    <div className="vr-pile-stat" data-stat={id}>
      <dt>{label}</dt>
      <dd className={quiet ? 'is-quiet' : undefined}>{value}</dd>
    </div>
  );
}

/** How many piles have pictures of their own in the frame (the pictures' cap, as it fell). */
function picturedPiles(frame: ReportViewsFrame | null): Map<string, number> {
  const ids = new Map<string, number>();
  for (const v of frame?.views ?? [])
    if (v.pile !== undefined) ids.set(v.pile, (ids.get(v.pile) ?? 0) + 1);
  return ids;
}

/**
 * Whether the set of pictures is full: one more pile's pictures would pass the cap, as the
 * capture counts them (`planShots`: a pile is pictured whole or not at all).
 */
function setIsFull(frame: ReportViewsFrame | null, pictured: Map<string, number>): boolean {
  const perPile = Math.max(0, ...pictured.values());
  return perPile > 0 && (frame?.views.length ?? 0) + perPile > REPORT_VIEWS_MAX;
}

export function PileCard({
  model,
  pile,
  note,
  views,
}: {
  model: VolumetricModel;
  pile: VolumetricPile;
  /** The person's note on the pile, or null. */
  note: string | null;
  views: ReportViews;
}): ReactElement {
  const latest: CaptureRef | null = model.latest;
  const compared: CaptureRef | null = model.compared;
  const frame = views.frame ?? model.frame;
  const profile = pile.profile;
  const measured = pile.latestM3 !== null;
  const change = compared ? pile.changeM3 : null;
  const isNew =
    change !== null &&
    pile.changePct === null &&
    pile.previousM3 !== null &&
    // nothing there before; a pile that was under its base then is not new
    pile.previousM3 >= 0 &&
    pile.previousM3 < NEW_UNDER_M3 &&
    (pile.latestM3 ?? 0) > 0;

  // pictures: the pile's own, else its place on the site photo. Only a full set says the pile is
  // past the cap: a pile missing from a set with room left (its pictures failed, or it was drawn
  // after they were taken) is given no reason that would be untrue.
  const pictured = picturedPiles(frame);
  const pastCap = !pictured.has(pile.id) && setIsFull(frame, pictured);
  const photo = latest ? views.pilePicture('photo', pile.id, latest.id) : null;
  const view3d = latest ? views.pilePicture('3d', pile.id, latest.id) : null;
  const before = compared ? views.pilePicture('photo', pile.id, compared.id) : null;
  const photoCrop =
    photo || !latest ? null : siteCrop(pile, frame, views.picture('photo', latest.id));
  const beforeCrop =
    before || !compared ? null : siteCrop(pile, frame, views.picture('photo', compared.id));
  const photoExtent = photo?.extent ?? photoCrop?.extent ?? null;
  const beforeExtent = before?.extent ?? beforeCrop?.extent ?? null;

  const baseName = pile.base.trim();
  // a pile whose base is not set is drawn on the default surface under its boundary: that is
  // no base of the pile's own, so the card gives no base level and the key names the boundary
  const drawn: VolumetricPileProfile | null =
    profile && baseName === '' ? { ...profile, baseKind: 'boundary' } : profile;
  const level = drawn?.baseKind === 'own' ? drawn.baseLevel : null;
  const levelText = level
    ? level[1] - level[0] < 0.05
      ? `${fixed(level[0], 2)} m`
      : `${fixed(level[0], 1)} to ${fixed(level[1], 1)} m`
    : null;
  // a pile at or under zero prints no tonnes: a weight of nothing, or of less, means nothing
  const tonnes = pileTonnesShown(pile.latestM3, pile.tonnes);
  const notSet = t('vreport.pile.baseNotSet');
  const notComputed = t('vreport.notComputed');
  const flags = [
    pile.belowBase ? { id: 'below-base', text: t('vreport.pile.belowBase') } : null,
    pastCap ? { id: 'no-3d', text: t('vreport.card.no3d', { count: pictured.size }) } : null,
  ].filter((f): f is { id: string; text: string } => f !== null);
  const height = chartHeightPx({
    nameChars: pile.label.length,
    flags: flags.length,
    valueChars: Math.max(baseName.length, levelText?.length ?? 0),
    noteChars: note?.length ?? 0,
  });
  const dateOf = (c: CaptureRef | null) => (c ? shortDate(c.date) : '');

  return (
    <article
      className={`vr-pile${measured ? '' : ' is-uncomputed'}${pile.belowBase ? ' is-below-base' : ''}`}
      data-pile={pile.id}
    >
      <header className="vr-pile-head">
        <span className="vr-num">{pile.tag}</span>
        <h2 className="vr-pile-name">
          {pile.label}
          {pile.material ? <span className="vr-pile-material">{pile.material}</span> : null}
        </h2>
        <div className="vr-pile-figures">
          {measured && change !== null && compared ? (
            <span className="vr-pile-change">
              <span className={`vr-chip ${way(change)}`}>
                <span>{signed(change, ' m³')}</span>
                {pile.changePct !== null ? (
                  <span className="vr-chip-pct">{signedPct(pile.changePct)}</span>
                ) : isNew ? (
                  <span className="vr-chip-pct">{t('vreport.change.new')}</span>
                ) : null}
              </span>
              <span className="vr-pile-since">
                {t('vreport.card.since', { date: shortDate(compared.date) })}
              </span>
            </span>
          ) : null}
          {tonnes !== null ? <span className="vr-pile-tonnes">{`${num(tonnes)} t`}</span> : null}
          {measured ? (
            <span className="vr-pile-volume">{`${num(pile.latestM3 ?? 0)} m³`}</span>
          ) : (
            <span className="vr-pile-volume is-none">{notComputed}</span>
          )}
        </div>
      </header>
      {flags.map((f) => (
        <p key={f.id} className="vr-pile-flag" data-flag={f.id}>
          {f.text}
        </p>
      ))}
      <div className="vr-pile-pics">
        <Picture
          kind="photo"
          picture={photo}
          crop={photoCrop}
          caption={t('vreport.card.photo', { date: dateOf(latest) })}
        >
          {photoExtent ? <Outline extent={photoExtent} ring={pile.outline} line={profile} /> : null}
        </Picture>
        <Picture
          kind="3d"
          picture={view3d}
          caption={t('vreport.card.3d', { date: dateOf(latest) })}
        />
        {compared ? (
          <Picture
            kind="before"
            picture={before}
            crop={beforeCrop}
            caption={t('vreport.card.before', { date: dateOf(compared) })}
          >
            {beforeExtent ? (
              <Outline extent={beforeExtent} ring={pile.previousOutline} line={null} />
            ) : null}
          </Picture>
        ) : null}
      </div>
      <Profile profile={drawn} height={height} />
      <dl className="vr-pile-stats">
        <Stat
          id="footprint"
          label={t('vreport.card.footprint')}
          value={pile.areaM2 !== null ? `${fixed(pile.areaM2, 0)} m²` : notComputed}
          quiet={pile.areaM2 === null}
        />
        <Stat
          id="base"
          label={t('vreport.card.base')}
          value={baseName !== '' ? baseName : notSet}
          quiet={baseName === ''}
        />
        <Stat
          id="base-level"
          label={t('vreport.card.baseLevel')}
          value={levelText ?? notSet}
          quiet={levelText === null}
        />
        <Stat
          id="peak"
          label={t('vreport.card.peak')}
          value={pile.peakM !== null ? `${fixed(pile.peakM, 1)} m` : notComputed}
          quiet={pile.peakM === null}
        />
        <Stat
          id="density"
          label={t('vreport.card.density')}
          value={
            pile.densityTPerM3 !== null
              ? `${fixed(pile.densityTPerM3, 2)} t/m³`
              : t('vreport.table.noTonnes')
          }
          quiet={pile.densityTPerM3 === null}
        />
        <Stat
          id="surveyed"
          label={t('vreport.card.surveyed')}
          value={latest ? shortDate(latest.date) : notSet}
          quiet={!latest}
        />
      </dl>
      {note ? <p className="vr-pile-note">{note}</p> : null}
    </article>
  );
}
