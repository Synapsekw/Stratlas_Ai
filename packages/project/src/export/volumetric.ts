// The volumetric customer report (spec 2026-10-25): one pure model of the figures every page and
// the interactive file print, the generated "In short" sentence and method note, the per-pile crop
// boxes and the page plan. Every pile of the input is in the model, with a volume or not (founder,
// 20 Nov 2026): a pile without one is listed and gets a card. The figures are the app's own: the caller (the report page) builds the
// input from the survey data the house report builds (`buildSurveyData`: each pile's per-date
// figures as the Volumes view shows them, densities through `densityOn` / `pileMaterial`), so the
// model only ranks, adds and compares. "Change" is each pile's latest volume less its volume on the
// compared date (founder), never a surface-to-surface figure. JSON safe (the
// `report:volumetricModel` payload). Pure and renderer safe.
import type { ReportPageId, ReportViewsFrame, VolumetricTextId } from '@aio/schema';
import {
  stockpileCsv,
  stockpileInventory,
  type CaptureRef,
  type StockpileReport,
  type SurveyReportData,
} from './surveyCsv';

// ---------------------------------------------------------------- input

/** A pile's figures on one survey date, as the app shows them. */
export interface VolumetricPileDateInput {
  capture: string;
  /** The pile's volume (bank, m³), or null when the date has no current figure. */
  volumeM3: number | null;
  /** Its density on that date (`densityOn`, else the kit's site-wide one), or null. */
  densityTPerM3: number | null;
  /** Footprint, m². */
  areaM2: number | null;
  /** Peak height above the base, m. */
  peakM: number | null;
  /** `uncertainty.plusMinusM3` of the result, or null when it has none. */
  plusMinusM3: number | null;
  /** The outline on that date (`outlineOn`), (E, N) in the project CRS. */
  outline: [number, number][];
}

/** One line of a pile's elevation profile: a survey's surface, or the base under the pile. */
export interface VolumetricProfileSeries {
  /** The latest survey, the compared one, or the pile's base. */
  kind: 'current' | 'earlier' | 'base';
  /** The survey date's id and its date (`YYYY-MM-DD`); a base has neither. */
  capture?: string;
  date?: string;
  /** Distance along the line from `a`, m. */
  chainage: number[];
  /** Height at each station, m; null where there is none (a base outside the outline). */
  z: (number | null)[];
}

/**
 * A pile's elevation profile along its A to B line, as sampled by the report page (the pile
 * panel's default line, the app's own surfaces and base). JSON safe.
 */
export interface VolumetricPileProfile {
  /** The line's ends (E, N) in the project CRS. */
  a: [number, number];
  b: [number, number];
  lengthM: number;
  series: VolumetricProfileSeries[];
  /** The lowest and the highest base height under the pile, m; null without a base. */
  baseLevel: [number, number] | null;
  /** The pile's own base, or the heights along its boundary when no base could be built. */
  baseKind: 'own' | 'boundary';
}

export interface VolumetricPileInput {
  id: string;
  label: string;
  /** Its material (`pileMaterial`; the kit's site-wide one has id `kit`), or null. */
  material: { id: string; name: string } | null;
  /** The base in words: the base picker's name ("Toe surface", "Previous survey"). */
  base: string;
  /**
   * One entry per survey date the pile is known on. A pile that was never computed still has its
   * outline and footprint here, with `volumeM3` null.
   */
  dates: VolumetricPileDateInput[];
  /** Its elevation profile; missing or null when it was not sampled. */
  profile?: VolumetricPileProfile | null;
}

export interface VolumetricInput {
  /** Survey dates, any order. */
  captures: readonly CaptureRef[];
  piles: readonly VolumetricPileInput[];
  /** The capture id the person picked to compare with (`ReportTextFile.compareWith`). */
  compareWith?: string | null;
  project: { name: string; customer: string | null; site: string | null; crs: string };
  method: {
    /** Surface (DSM) cell size, m. */
    cellM: number | null;
    /** Orthophoto ground sample distance, cm. */
    gsdCm: number | null;
    /** The site-wide density the stockpile kit carried, t/m³. */
    siteDensityTPerM3: number | null;
  };
  /** The pictures' framing, or null when no pictures are taken yet. */
  frame: ReportViewsFrame | null;
  /** The texts as resolved (the person's or generated). */
  text?: Partial<Record<VolumetricTextId, string>>;
  /** A note per pile, by measurement id. */
  pileNotes?: Readonly<Record<string, string>>;
  /** Pages switched on or off; a missing page is on. */
  pages?: Partial<Record<ReportPageId, boolean>>;
  /**
   * Pairs of piles (measurement ids) whose outlines substantially overlap on the latest date: the
   * caller's test (`overlapShare` at `SAME_PILE_SHARE`, `@aio/survey`).
   */
  overlaps?: readonly { a: string; b: string }[];
}

// ---------------------------------------------------------------- model

/** A square box on the pictures, in frame pixels from the top left. */
export interface PixelBox {
  x: number;
  y: number;
  size: number;
}

export interface VolumetricPileDate {
  capture: string;
  volumeM3: number | null;
  tonnes: number | null;
}

export interface VolumetricPile {
  id: string;
  /**
   * Its number on the map and in the tables: 1 for the largest latest volume; piles without a
   * volume follow, by name.
   */
  number: number;
  /**
   * The short label for its map marker and badges: "Pile 10" is "10", else up to 4 characters.
   * When two piles would share one, every pile's tag is its number.
   */
  tag: string;
  label: string;
  material: string | null;
  base: string;
  latestM3: number | null;
  previousM3: number | null;
  /** Latest less previous, m³; null unless the pile has both. */
  changeM3: number | null;
  /** The change in % of the previous volume; null unless both volumes are above zero. */
  changePct: number | null;
  /** The latest volume is under zero: the surface lies below the base. */
  belowBase: boolean;
  tonnes: number | null;
  previousTonnes: number | null;
  densityTPerM3: number | null;
  areaM2: number | null;
  peakM: number | null;
  plusMinusM3: number | null;
  /**
   * The outline (E, N) on the latest date, else the compared date's, else the pile's last one;
   * the date's own outline also when the pile has no figure there.
   */
  outline: [number, number][];
  previousOutline: [number, number][];
  /** The centre of the latest outline (E, N), and where it falls on the pictures. */
  centre: [number, number] | null;
  marker: [number, number] | null;
  /** The before and after crop box (`pileCrop`), null without pictures. */
  crop: PixelBox | null;
  note: string | null;
  /** Its figures on every report date, oldest first. */
  byDate: VolumetricPileDate[];
  /** Its elevation profile, null when it was not sampled. */
  profile: VolumetricPileProfile | null;
}

/** A pile as a sentence names it: its number, its short label and its name. */
export interface VolumetricPileRef {
  id: string;
  number: number;
  tag: string;
  label: string;
}

/** Two piles whose outlines substantially overlap; `a` is the one listed first. */
export interface VolumetricOverlap {
  a: VolumetricPileRef;
  b: VolumetricPileRef;
}

export interface VolumetricKpis {
  /** Piles counted on the latest date. */
  piles: number;
  /** Every pile the report lists, with a volume or not. */
  listed: number;
  stockM3: number;
  /** Tonnes of the piles with a density; null when none has one. */
  tonnes: number | null;
  /** Piles whose tonnes are added (the "tonnes for n of m piles" note when under `piles`). */
  tonnesPiles: number;
  /** The change over the piles counted on both dates, m³, and in % of their previous total. */
  changeM3: number | null;
  changePct: number | null;
  /** The summed survey error, only when every counted pile has one. */
  errorM3: number | null;
  errorPct: number | null;
}

/**
 * One segment of the share-of-stock bar: a pile, or the Others (`id` null). Only piles above zero
 * have a part in the bar.
 */
export interface ShareSegment {
  id: string | null;
  label: string | null;
  m3: number;
  /** Fraction of the stock of the piles above zero, 0 to 1; the segments add up to 1. */
  share: number;
}

export interface VolumetricModel {
  project: VolumetricInput['project'];
  /** The newest date with figures, and the date it is compared with (null with one date). */
  latest: CaptureRef | null;
  compared: CaptureRef | null;
  /** Every date with figures, oldest first (the editor's Compare with list). */
  dates: CaptureRef[];
  /** The dates the interactive file shows: the 6 newest with figures, oldest first. */
  shownDates: CaptureRef[];
  method: VolumetricInput['method'] & {
    /** The piles' base names, each once. */
    bases: string[];
    density: 'material' | 'site' | 'none';
  };
  kpis: VolumetricKpis;
  /** Every pile: those with a latest volume first, largest first, then the rest by name. */
  piles: VolumetricPile[];
  share: ShareSegment[];
  /** Pile ids with a card: every pile, in report order. */
  cards: string[];
  /** Overlapping pairs where both piles have a volume on the latest date. */
  overlaps: VolumetricOverlap[];
  /** Pile ids with a change, from the largest drawdown to the largest growth. */
  changeOrder: string[];
  frame: ReportViewsFrame | null;
  text: Partial<Record<VolumetricTextId, string>>;
  pages: Record<ReportPageId, boolean>;
}

/** The named segments of the share bar: the largest piles; the rest are the Others. */
export const VOLUMETRIC_CARDS = 8;
/** Pile cards on one printed page. */
export const PILE_CARDS_PER_PAGE = 2;
/** Dates the interactive file embeds at most. */
export const VOLUMETRIC_SHOWN_DATES = 6;
const PAGE_IDS: readonly ReportPageId[] = ['cover', 'piles', 'change'];

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const byDate = (a: CaptureRef, b: CaptureRef) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const natural = (a: string, b: string) =>
  a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

/** The area centroid of a ring, else the mean of its vertices; null without any. */
function centreOf(ring: readonly [number, number][]): [number, number] | null {
  if (ring.length === 0) return null;
  let a = 0;
  let cx = 0;
  let cy = 0;
  const e0 = ring[0]?.[0] ?? 0;
  const n0 = ring[0]?.[1] ?? 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    if (!p || !q) continue;
    const x1 = p[0] - e0;
    const y1 = p[1] - n0;
    const x2 = q[0] - e0;
    const y2 = q[1] - n0;
    const c = x1 * y2 - x2 * y1;
    a += c;
    cx += (x1 + x2) * c;
    cy += (y1 + y2) * c;
  }
  if (Math.abs(a) > 1e-9) return [e0 + cx / (3 * a), n0 + cy / (3 * a)];
  return [sum(ring.map((p) => p[0])) / ring.length, sum(ring.map((p) => p[1])) / ring.length];
}

/** A point (E, N) on the pictures, in frame pixels. */
export function toFramePx(
  frame: Pick<ReportViewsFrame, 'extent' | 'mPerPx'>,
  [e, n]: readonly [number, number],
): [number, number] {
  return [(e - frame.extent[0]) / frame.mPerPx, (frame.extent[3] - n) / frame.mPerPx];
}

/** Crop margin on each side, as a share of the larger side of the outlines. */
const CROP_MARGIN = 0.25;
/** Smallest crop side, m. */
const CROP_MIN_M = 20;

/**
 * The crop box of a pile on the pictures: the union of its outlines (both dates, so the framing is
 * the same before and after), a quarter of its larger side added on each side, at least 20 m a
 * side, squared about its centre; in frame pixels. Null without a frame or a vertex.
 */
export function pileCrop(
  outlines: readonly (readonly [number, number][])[],
  frame: Pick<ReportViewsFrame, 'extent' | 'mPerPx'> | null,
): PixelBox | null {
  const pts = outlines.flat();
  if (!frame || pts.length === 0) return null;
  const es = pts.map((p) => p[0]);
  const ns = pts.map((p) => p[1]);
  const e0 = Math.min(...es);
  const e1 = Math.max(...es);
  const n0 = Math.min(...ns);
  const n1 = Math.max(...ns);
  const side = Math.max(Math.max(e1 - e0, n1 - n0) * (1 + 2 * CROP_MARGIN), CROP_MIN_M);
  const [x, y] = toFramePx(frame, [(e0 + e1) / 2 - side / 2, (n0 + n1) / 2 + side / 2]);
  return { x, y, size: side / frame.mPerPx };
}

/**
 * The short label a pile shows on the map and in its badge: the number in its name ("Pile 10" is
 * "10", "P08" is "08"), else the name cut to 4 characters, else its rank.
 */
export function pileTag(name: string, rank: number): string {
  const n = name.trim();
  const digits = /\d+(?!.*\d)/.exec(n);
  if (digits) return digits[0].slice(-4);
  const compact = n.replace(/\s+/g, '');
  return compact === '' ? String(rank) : compact.slice(0, 4);
}

/**
 * The volumetric report's model: the dates (the newest with figures, compared with the person's
 * pick when it is an earlier date with figures, else the one before), each pile's figures on both,
 * every pile ranked by latest volume (those without one last), the KPIs, the share of stock, the
 * cards, the overlaps and the change order.
 */
export function volumetricModel(input: VolumetricInput): VolumetricModel {
  const captures = [...input.captures].sort(byDate);
  const figure = (p: VolumetricPileInput, c: string) =>
    p.dates.find((d) => d.capture === c && d.volumeM3 !== null) ?? null;
  /** The pile's outline on a date, with a figure or not; null when it has none there. */
  const ringOn = (p: VolumetricPileInput, c: CaptureRef | null): [number, number][] | null => {
    const d = c ? p.dates.find((x) => x.capture === c.id && x.outline.length > 0) : undefined;
    return d?.outline ?? null;
  };
  // Every pile is reported; one with no volume on any date reads "Not computed" (D1).
  const piles0 = [...input.piles];
  const dates = captures.filter((c) => piles0.some((p) => figure(p, c.id)));
  const latest = dates.at(-1) ?? null;
  const earlier = dates.slice(0, -1);
  const compared = earlier.find((c) => c.id === input.compareWith) ?? earlier.at(-1) ?? null;
  const frame = input.frame;
  const notes = input.pileNotes ?? {};

  const rows = piles0.map((p) => {
    const cur = latest ? figure(p, latest.id) : null;
    const prev = compared ? figure(p, compared.id) : null;
    const latestM3 = cur?.volumeM3 ?? null;
    const previousM3 = prev?.volumeM3 ?? null;
    const changeM3 = latestM3 !== null && previousM3 !== null ? latestM3 - previousM3 : null;
    const tonnesOf = (d: VolumetricPileDateInput | null): number | null => {
      const v = d?.volumeM3 ?? null;
      const density = d?.densityTPerM3 ?? null;
      return v !== null && density !== null ? v * density : null;
    };
    const outline = ringOn(p, latest) ?? ringOn(p, compared) ?? p.dates.at(-1)?.outline ?? [];
    const previousOutline = ringOn(p, compared) ?? outline;
    const onLatest = latest ? p.dates.find((d) => d.capture === latest.id) : undefined;
    const centre = centreOf(outline);
    const note = notes[p.id]?.trim() ?? '';
    return {
      id: p.id,
      number: 0,
      tag: '',
      label: p.label,
      material: p.material?.name ?? null,
      base: p.base,
      latestM3,
      previousM3,
      changeM3,
      changePct: changeShare(changeM3, previousM3),
      belowBase: latestM3 !== null && latestM3 < 0,
      tonnes: tonnesOf(cur),
      previousTonnes: tonnesOf(prev),
      densityTPerM3: cur?.densityTPerM3 ?? null,
      areaM2: cur?.areaM2 ?? onLatest?.areaM2 ?? p.dates.at(-1)?.areaM2 ?? null,
      peakM: cur?.peakM ?? null,
      plusMinusM3: cur?.plusMinusM3 ?? null,
      outline,
      previousOutline,
      centre,
      marker: frame && centre ? toFramePx(frame, centre) : null,
      crop: pileCrop([previousOutline, outline], frame),
      note: note === '' ? null : note,
      byDate: dates.map((c) => {
        const d = figure(p, c.id);
        return { capture: c.id, volumeM3: d?.volumeM3 ?? null, tonnes: tonnesOf(d) };
      }),
      profile: p.profile ?? null,
    } satisfies VolumetricPile;
  });
  const ranked = rows
    .sort((a, b) => {
      if (a.latestM3 === null || b.latestM3 === null)
        return a.latestM3 === b.latestM3 ? natural(a.label, b.label) : a.latestM3 === null ? 1 : -1;
      return b.latestM3 - a.latestM3 || natural(a.label, b.label);
    })
    .map((p, k) => ({ ...p, number: k + 1, tag: pileTag(p.label, k + 1) }));
  // two piles never share a tag: with a duplicate, every pile is told apart by its number
  const unique = new Set(ranked.map((p) => p.tag)).size === ranked.length;
  const piles = unique ? ranked : ranked.map((p) => ({ ...p, tag: String(p.number) }));

  // ------------------------------------------------ KPIs
  const counted = piles.filter((p) => p.latestM3 !== null);
  const stockM3 = sum(counted.map((p) => p.latestM3 ?? 0));
  const weighed = counted.filter((p) => p.tonnes !== null);
  const both = piles.filter((p) => p.changeM3 !== null);
  const bothPrev = sum(both.map((p) => p.previousM3 ?? 0));
  const changeM3 = compared && both.length > 0 ? sum(both.map((p) => p.changeM3 ?? 0)) : null;
  const errorM3 =
    counted.length > 0 && counted.every((p) => p.plusMinusM3 !== null)
      ? sum(counted.map((p) => p.plusMinusM3 ?? 0))
      : null;
  const kpis: VolumetricKpis = {
    piles: counted.length,
    listed: piles.length,
    stockM3,
    tonnes: weighed.length > 0 ? sum(weighed.map((p) => p.tonnes ?? 0)) : null,
    tonnesPiles: weighed.length,
    changeM3,
    changePct: changeShare(changeM3, bothPrev),
    errorM3,
    errorPct: errorM3 !== null && stockM3 > 0 ? (errorM3 / stockM3) * 100 : null,
  };

  // ------------------------------------------------ share, cards, change order
  // A pile at or below zero has no part in the bar (D10), so the bar is the stock of the piles
  // above zero; the site total (`stockM3`) keeps every counted pile, as the app's does (D11).
  const stocked = counted.filter((p) => (p.latestM3 ?? 0) > 0);
  const barM3 = sum(stocked.map((p) => p.latestM3 ?? 0));
  const named = stocked.slice(0, VOLUMETRIC_CARDS);
  const rest = stocked.slice(VOLUMETRIC_CARDS);
  const share: ShareSegment[] = named.map((p) => ({
    id: p.id,
    label: p.label,
    m3: p.latestM3 ?? 0,
    share: barM3 > 0 ? (p.latestM3 ?? 0) / barM3 : 0,
  }));
  if (rest.length > 0) {
    const m3 = sum(rest.map((p) => p.latestM3 ?? 0));
    share.push({ id: null, label: null, m3, share: barM3 > 0 ? m3 / barM3 : 0 });
  }
  const cards = piles.map((p) => p.id);

  // ------------------------------------------------ overlaps
  // Only between two piles that both have a volume on the latest date (D3); each pair once, the
  // pile listed first as `a`.
  const byId = new Map(piles.map((p) => [p.id, p]));
  const refOf = (p: VolumetricPile): VolumetricPileRef => ({
    id: p.id,
    number: p.number,
    tag: p.tag,
    label: p.label,
  });
  const seen = new Set<string>();
  const overlaps: VolumetricOverlap[] = [];
  for (const pair of input.overlaps ?? []) {
    const x = byId.get(pair.a);
    const y = byId.get(pair.b);
    if (!x || !y || x.id === y.id || x.latestM3 === null || y.latestM3 === null) continue;
    const [a, b] = x.number < y.number ? [x, y] : [y, x];
    const key = `${String(a.number)}:${String(b.number)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    overlaps.push({ a: refOf(a), b: refOf(b) });
  }
  overlaps.sort((p, q) => p.a.number - q.a.number || p.b.number - q.b.number);
  const changeOrder = [...both]
    .sort((a, b) => (a.changeM3 ?? 0) - (b.changeM3 ?? 0) || a.number - b.number)
    .map((p) => p.id);

  // ------------------------------------------------ method
  // read from the piles that have a volume: a pile nobody computed rests no figure on a base
  const bases = [...new Set(counted.map((p) => p.base.trim()).filter((b) => b !== ''))];
  const withDensity = counted.filter((p) => p.densityTPerM3 !== null);
  const measured = new Set(counted.map((p) => p.id));
  const kitOnly = piles0
    .filter((p) => measured.has(p.id))
    .every((p) => !p.material || p.material.id === 'kit');
  const density: VolumetricModel['method']['density'] =
    withDensity.length === 0
      ? 'none'
      : kitOnly && input.method.siteDensityTPerM3 !== null
        ? 'site'
        : 'material';

  const on = input.pages ?? {};
  return {
    project: { ...input.project },
    latest,
    compared,
    dates,
    shownDates: dates.slice(-VOLUMETRIC_SHOWN_DATES),
    method: { ...input.method, bases, density },
    kpis,
    piles,
    share,
    cards,
    overlaps,
    changeOrder,
    frame,
    text: { ...input.text },
    pages: Object.fromEntries(PAGE_IDS.map((id) => [id, on[id] ?? true])) as Record<
      ReportPageId,
      boolean
    >,
  };
}

// ---------------------------------------------------------------- words

/** The `@aio/ui` message keys the model's text uses (the app's `t` accepts them). */
export type VolumetricKey =
  | 'vreport.short.rose'
  | 'vreport.short.fell'
  | 'vreport.short.roseNoPct'
  | 'vreport.short.fellNoPct'
  | 'vreport.short.steady'
  | 'vreport.short.mostFrom'
  | 'vreport.short.pileLess'
  | 'vreport.short.pileMore'
  | 'vreport.short.and'
  | 'vreport.short.grew'
  | 'vreport.short.shrank'
  | 'vreport.short.withPiles'
  | 'vreport.short.withCounter'
  | 'vreport.short.end'
  | 'vreport.short.oneDate'
  | 'vreport.method.base'
  | 'vreport.method.basePerPile'
  | 'vreport.method.cell'
  | 'vreport.method.gsd'
  | 'vreport.method.crs'
  | 'vreport.method.densityMaterial'
  | 'vreport.method.densitySite'
  | 'vreport.method.densityNone';

/** The app's `t`, narrowed to the keys used here. */
export type VolumetricT = (key: VolumetricKey, vars?: Record<string, string | number>) => string;

export interface WordsOptions {
  /** A volume, m³, as the app shows it (default `formatVolumeM3`). */
  volume?: (m3: number) => string;
  /** A survey date (`YYYY-MM-DD`) in words (default "3 September 2026"). */
  date?: (iso: string) => string;
}

/**
 * A volume as the app formats volumes: thousands grouped, no decimals from 100 m³ (one below),
 * always without a sign (the words say less or more).
 */
export function formatVolumeM3(m3: number): string {
  const v = Math.abs(m3);
  const decimals = v >= 100 ? 0 : 1;
  return `${v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} m³`;
}

/** A survey date in words: "3 September 2026". */
export function formatReportDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** A previous volume under this (m³) is about zero: a share of it means nothing. */
const SHARE_MIN_PREVIOUS_M3 = 1;
/** A share beyond this (per cent) is a new or collapsed pile, not a percentage worth printing. */
const SHARE_MAX_PCT = 999;

/**
 * The tonnes a pile's own row and card print: none for a pile at or under zero volume, where a
 * weight means nothing. The site's tonnes (`kpis.tonnes`) still add such a pile's, as the app's
 * own site total does, so the report's totals stay the app's (plan D11).
 */
export function pileTonnesShown(volumeM3: number | null, tonnes: number | null): number | null {
  return volumeM3 !== null && volumeM3 > 0 ? tonnes : null;
}

/**
 * A change in per cent of the previous volume. Null unless the previous volume and the latest one
 * (the previous plus the change) are both above zero: a share of, or down to, a volume at or under
 * zero means nothing, so such a change is given in cubic metres alone. Null also when the previous
 * volume is under 1 m³ (a pile that is new) or when the share would exceed 999 %.
 */
export function changeShare(change: number | null, previous: number | null): number | null {
  if (change === null || previous === null || previous < SHARE_MIN_PREVIOUS_M3) return null;
  if (!(previous + change > 0)) return null;
  const pct = (change / previous) * 100;
  return Math.abs(pct) > SHARE_MAX_PCT ? null : pct;
}

/** A share in whole per cent, at least 1 %: "8 %". */
const pctText = (pct: number) => `${String(Math.max(1, Math.round(Math.abs(pct))))} %`;

/** Under this share of the stock the total "held steady". */
const STEADY_SHARE = 0.01;
/** A pile moving against the total is named from this share of the total change. */
const COUNTER_SHARE = 0.05;

/**
 * The "In short" sentence (spec section 5): the site total's rise or fall since the compared date
 * (or "held steady" under 1 % of the stock), up to two piles that moved most the same way, then the
 * largest pile that moved the other way when its change is at least 5 % of the total's. With one
 * date, the stock on hand across the piles. Never a minus sign or a dash.
 */
export function inShortSentence(
  model: VolumetricModel,
  t: VolumetricT,
  opts: WordsOptions = {},
): string {
  const vol = opts.volume ?? formatVolumeM3;
  const date = opts.date ?? formatReportDate;
  const { kpis, latest, compared } = model;
  if (!compared || kpis.changeM3 === null)
    return t('vreport.short.oneDate', {
      volume: vol(kpis.stockM3),
      count: kpis.piles,
      date: latest ? date(latest.date) : '',
    });
  const total = kpis.changeM3;
  const since = date(compared.date);
  if (Math.abs(total) < STEADY_SHARE * kpis.stockM3 || total === 0)
    return t('vreport.short.end', { text: t('vreport.short.steady', { date: since }) });
  const up = total > 0;
  let text =
    kpis.changePct === null
      ? t(up ? 'vreport.short.roseNoPct' : 'vreport.short.fellNoPct', {
          volume: vol(Math.abs(total)),
          date: since,
        })
      : t(up ? 'vreport.short.rose' : 'vreport.short.fell', {
          volume: vol(Math.abs(total)),
          pct: pctText(kpis.changePct),
          date: since,
        });
  const moved = model.piles.filter((p) => p.changeM3 !== null && p.changeM3 !== 0);
  const bySize = (a: VolumetricPile, b: VolumetricPile) =>
    Math.abs(b.changeM3 ?? 0) - Math.abs(a.changeM3 ?? 0) || a.number - b.number;
  const same = moved
    .filter((p) => (p.changeM3 ?? 0) > 0 === up)
    .sort(bySize)
    .slice(0, 2);
  const named = same.map((p) =>
    t(up ? 'vreport.short.pileMore' : 'vreport.short.pileLess', {
      pile: p.label,
      volume: vol(Math.abs(p.changeM3 ?? 0)),
    }),
  );
  const [a, b] = named;
  if (a !== undefined) {
    const list = b !== undefined ? t('vreport.short.and', { a, b }) : a;
    text = t('vreport.short.withPiles', {
      lead: text,
      piles: t('vreport.short.mostFrom', { piles: list }),
    });
  }
  const counter = moved.filter((p) => (p.changeM3 ?? 0) > 0 !== up).sort(bySize)[0];
  if (counter && Math.abs(counter.changeM3 ?? 0) >= COUNTER_SHARE * Math.abs(total))
    text = t('vreport.short.withCounter', {
      lead: text,
      counter: t(up ? 'vreport.short.shrank' : 'vreport.short.grew', {
        pile: counter.label,
        volume: vol(Math.abs(counter.changeM3 ?? 0)),
      }),
    });
  return t('vreport.short.end', { text });
}

const trim = (n: number, decimals: number) => String(Number(n.toFixed(decimals)));

/**
 * The method note: the base (its picker name when every pile shares it, else "Base per pile, see
 * table"), the surface cell size, the orthophoto ground
 * sample distance, the CRS and how tonnes were weighed (each pile's material density, the site-wide
 * kit density, or none). A part the project does not know is left out.
 */
export function methodNote(model: VolumetricModel, t: VolumetricT): string {
  const m = model.method;
  const parts: string[] = [];
  // one base for every pile is stated; mixed bases, or a pile whose base is unknown, are named
  // per pile in the table and cards
  const [only] = m.bases;
  const allNamed = model.piles.every((p) => p.latestM3 === null || p.base.trim() !== '');
  if (m.bases.length === 1 && only !== undefined && allNamed)
    parts.push(t('vreport.method.base', { base: only }));
  else if (m.bases.length >= 1) parts.push(t('vreport.method.basePerPile'));
  if (m.cellM !== null) parts.push(t('vreport.method.cell', { cell: trim(m.cellM, 3) }));
  if (m.gsdCm !== null) parts.push(t('vreport.method.gsd', { gsd: trim(m.gsdCm, 1) }));
  if (model.project.crs !== '') parts.push(t('vreport.method.crs', { crs: model.project.crs }));
  if (m.density === 'site' && m.siteDensityTPerM3 !== null)
    parts.push(t('vreport.method.densitySite', { density: m.siteDensityTPerM3.toFixed(2) }));
  else if (m.density === 'none') parts.push(t('vreport.method.densityNone'));
  else parts.push(t('vreport.method.densityMaterial'));
  return parts.join(' ');
}

// ---------------------------------------------------------------- pages

/** Ranked-table rows on page A, and on each "A, continued". */
export const COVER_ROWS = 12;
export const COVER_CONTINUED_ROWS = 30;
/** Bars of the change chart on page C, and on each "C, continued". */
export const CHANGE_ROWS = 24;
export const CHANGE_CONTINUED_ROWS = 40;

/**
 * One printed page: which report page it is, whether it continues one, and the rows it holds
 * (`from` to `to`, end excluded): ranked piles on A, `cards` on a card page of B (none on the
 * overview), `changeOrder` on C.
 */
export interface PlannedPage {
  page: ReportPageId;
  /**
   * On B only: the site overview, a page of pile cards, or the page that holds nothing but the
   * report's closing block (after a last page of two cards, which leaves it no room).
   */
  part?: 'overview' | 'cards' | 'closing';
  continued: boolean;
  from: number;
  to: number;
  /** Page number, from 1. */
  number: number;
}

function split(
  page: ReportPageId,
  rows: number,
  first: number,
  next: number,
): Omit<PlannedPage, 'number'>[] {
  const out: Omit<PlannedPage, 'number'>[] = [
    { page, continued: false, from: 0, to: Math.min(rows, first) },
  ];
  for (let from = first; from < rows; from += next)
    out.push({ page, continued: true, from, to: Math.min(rows, from + next) });
  return out;
}

/**
 * The printed pages, by counts (not by measuring), so the page count is known before printing:
 * A takes 12 table rows and 30 on each continued page; B is the site overview and then the pile
 * cards, two to a page (the first card page does not count as continued, the later ones do); C
 * takes 24 bars, then 40. `pages` (default the model's) turns A, B or C off, B with its overview
 * and its cards together; C needs a compared date. At least one page stays on: A when nothing else
 * would print.
 */
export function pagePlan(
  model: VolumetricModel,
  pages: Partial<Record<ReportPageId, boolean>> = model.pages,
): PlannedPage[] {
  const on = (id: ReportPageId) => pages[id] ?? true;
  const plan: Omit<PlannedPage, 'number'>[] = [];
  const cover = () => split('cover', model.piles.length, COVER_ROWS, COVER_CONTINUED_ROWS);
  if (on('cover')) plan.push(...cover());
  if (on('piles')) {
    plan.push({ page: 'piles', part: 'overview', continued: false, from: 0, to: 0 });
    const cards = model.cards.length;
    for (let from = 0; from < cards; from += PILE_CARDS_PER_PAGE)
      plan.push({
        page: 'piles',
        part: 'cards',
        continued: from > 0,
        from,
        to: Math.min(cards, from + PILE_CARDS_PER_PAGE),
      });
  }
  if (on('change') && model.compared)
    plan.push(...split('change', model.changeOrder.length, CHANGE_ROWS, CHANGE_CONTINUED_ROWS));
  if (plan.length === 0) plan.push(...cover());
  // The last page closes the report with the closing remarks and the method note. Two cards fill
  // their page, so after such a page the closing block gets a page of its own.
  const end = plan.at(-1);
  if (end?.part === 'cards' && end.to - end.from >= PILE_CARDS_PER_PAGE)
    plan.push({ page: 'piles', part: 'closing', continued: true, from: end.to, to: end.to });
  return plan.map((p, k) => ({ ...p, number: k + 1 }));
}

// ---------------------------------------------------------------- CSV

/**
 * The interactive file's CSV: the app's stockpile inventory CSV (`stockpileCsv`) for the report's
 * dates. With the default compared date it is that CSV as is; with another one, the inventory of
 * the dates up to the compared one and the latest, so its previous date is the one compared.
 */
export function volumetricCsv(data: SurveyReportData, compareWith?: string | null): string {
  const inv = data.stockpiles;
  const current = inv.current;
  if (!compareWith || !current || compareWith === inv.previous?.id) return stockpileCsv(data);
  const compared = inv.captures.find((c) => c.id === compareWith);
  if (!compared || byDate(compared, current) >= 0) return stockpileCsv(data);
  const keep = inv.captures.filter((c) => byDate(c, compared) <= 0 || c.id === current.id);
  const ids = new Set(keep.map((c) => c.id));
  const piles: StockpileReport[] = inv.rows.map((r) => ({
    ref: r.ref,
    id: r.id,
    label: r.label,
    material: r.material,
    base: r.base,
    volumes: r.volumes.filter((v) => ids.has(v.capture.id)),
  }));
  return stockpileCsv({ ...data, stockpiles: stockpileInventory(piles, keep) });
}
