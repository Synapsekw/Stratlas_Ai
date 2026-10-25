/**
 * The data the interactive view (D) of the volumetric HTML boots from. The exporter writes it as
 * JSON in `<script type="application/json" id="vr-data">` (with `<` escaped as `<`); the
 * viewer script is bundled on its own, so this file imports nothing and the strings come in the
 * data, as raw templates with `{name}` placeholders.
 */

/** The string keys the viewer reads (from `@aio/ui` en.ts), each as its raw template. */
export const VIEWER_STRING_KEYS = [
  'vreport.viewer.date',
  'vreport.viewer.view',
  'vreport.viewer.view.photo',
  'vreport.viewer.view.cutFill',
  'vreport.viewer.view.elevation',
  'vreport.viewer.view.3d',
  'vreport.viewer.units',
  'vreport.viewer.units.m3',
  'vreport.viewer.units.t',
  'vreport.viewer.savePdf',
  'vreport.viewer.csv',
  'vreport.viewer.list',
  'vreport.viewer.list.pile',
  'vreport.viewer.list.volume',
  'vreport.viewer.list.change',
  'vreport.viewer.sortBy',
  'vreport.viewer.select',
  'vreport.viewer.pick',
  'vreport.viewer.map',
  'vreport.kpi.stock',
  'vreport.kpi.change',
  'vreport.piles.before',
  'vreport.piles.after',
  'vreport.piles.footprint',
  'vreport.piles.peak',
  'vreport.piles.base',
  'vreport.piles.share',
  'vreport.piles.note',
  'vreport.piles.less',
  'vreport.piles.more',
  'vreport.piles.same',
  'vreport.table.noTonnes',
  'vreport.key.red',
  'vreport.key.blue',
  'vreport.key.grey',
  'vreport.pictures.placeholder',
] as const;

export type ViewerStringKey = (typeof VIEWER_STRING_KEYS)[number];

export type ViewerViewKind = 'photo' | 'cutfill' | 'elevation' | '3d';
export type ViewerUnit = 'm3' | 't';

export interface ViewerDate {
  /** The capture id. */
  id: string;
  /** The date as the toggles and labels say it, e.g. "3 September 2026". */
  label: string;
}

/** One embedded picture: a `data:image/jpeg` URI. Top-down kinds share the frame. */
export interface ViewerPicture {
  kind: ViewerViewKind;
  /** The date shown (for `cutfill`, the later date of the pair). */
  capture: string;
  src: string;
}

export interface ViewerPileDate {
  capture: string;
  m3: number | null;
  t: number | null;
}

export interface ViewerPile {
  id: string;
  /** Its number on the map: 1 for the largest latest volume. */
  number: number;
  /** Its short label on the map pin and in the list. */
  tag: string;
  label: string;
  /** Where its centre falls on the top-down pictures, in frame pixels. */
  marker: [number, number] | null;
  /** The before and after crop box on the top-down pictures (`pileCrop`), in frame pixels. */
  crop: { x: number; y: number; size: number } | null;
  areaM2: number | null;
  peakM: number | null;
  /** The base in words, as the base picker names it ("Triangulated toe"); empty when unknown. */
  base: string;
  note: string | null;
  /** Its figures on the shown dates (any order; a missing date counts as no figure). */
  byDate: ViewerPileDate[];
}

export interface ViewerData {
  strings: Record<ViewerStringKey, string>;
  /** The on-dark lockup (`lockupSvg({ on: 'dark' })`), trusted markup. */
  lockupSvg: string;
  /** "<site> · stockpile report". */
  title: string;
  /** "N piles · surveys <dates> · works offline, all data is inside this file". */
  subtitle: string;
  /** The shown dates, oldest first. */
  dates: ViewerDate[];
  /** The change is measured from `from` to `to` (capture ids; `from` null with one date). */
  from: string | null;
  to: string;
  /** The top-down pictures' pixel size; null without pictures. */
  frame: { widthPx: number; heightPx: number } | null;
  pictures: ViewerPicture[];
  /** The cut and fill legend: swatch colour and its words (shown in the Cut & fill view). */
  legend: { colour: string; label: string }[];
  /** The stockpile inventory CSV for these dates, and the name it downloads as. */
  csv: string;
  csvName: string;
  piles: ViewerPile[];
}
