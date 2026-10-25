// The volumetric report editor's rules (spec section 6): the texts the person sees (their own or
// generated from the figures), edits saved as versions in `report/volumetric.json`, Reset to
// generated, pile notes, pages on or off and the compared date. Pure, so the rules are tested
// without the UI; `useVolumetric` loads, previews and saves through them.
import {
  inShortSentence,
  methodNote,
  type VolumetricModel,
  type VolumetricT,
} from '@aio/project/export';
import {
  currentVersion,
  REPORT_TEXT_SCHEMA,
  ReportPageId,
  VolumetricTextId,
  withVersion,
  type NarrativeVersion,
  type ReportTextFile,
} from '@aio/schema';

/** A pile note prints at most this many characters. */
export const PILE_NOTE_MAX = 280;
/** Edits save after this pause, and on leaving the editor. */
export const SAVE_DELAY_MS = 600;

export const TEXT_IDS = VolumetricTextId.options;
export const PAGE_IDS = ReportPageId.options;

export type Texts = Record<VolumetricTextId, string>;
export interface ResolvedText {
  text: string;
  /** True while the text follows the figures (nothing written, or Reset to generated). */
  generated: boolean;
}
export type ResolvedTexts = Record<VolumetricTextId, ResolvedText>;

export interface GenerateContext {
  /** The default title, in the app's language. */
  title: string;
  /** The project's customer (`manifest.customer`). */
  customer: string | null | undefined;
  /** Settings, Report branding, company name. */
  companyName: string | null | undefined;
  t: VolumetricT;
}

/** Who wrote an edit. */
export type EditMeta = Pick<NarrativeVersion, 'author'>;

export function emptyReportText(): ReportTextFile {
  return { schema: REPORT_TEXT_SCHEMA, report: 'volumetric', parts: {} };
}

/** Every text as generated from the figures and the project; Intro and Closing start empty. */
export function generatedTexts(model: VolumetricModel, ctx: GenerateContext): Texts {
  return {
    title: ctx.title,
    preparedFor: ctx.customer?.trim() ?? '',
    preparedBy: ctx.companyName?.trim() ?? '',
    summary: inShortSentence(model, ctx.t),
    intro: '',
    method: methodNote(model, ctx.t),
    closing: '',
  };
}

/** A `user` newest version is kept as written; a `template` one, or none, follows the figures. */
export function resolveTexts(file: ReportTextFile | null, generated: Texts): ResolvedTexts {
  const out = {} as ResolvedTexts;
  for (const id of TEXT_IDS) {
    const v = currentVersion(file?.parts[id]);
    out[id] =
      v && v.source !== 'template'
        ? { text: v.text, generated: false }
        : { text: generated[id], generated: true };
  }
  return out;
}

const version = (
  text: string,
  source: NarrativeVersion['source'],
  meta: EditMeta,
  now: Date,
): NarrativeVersion => ({
  text,
  source,
  ...(meta.author ? { author: meta.author } : {}),
  createdAt: now.toISOString(),
});

function withPart(
  file: ReportTextFile | null,
  id: VolumetricTextId,
  v: NarrativeVersion,
): ReportTextFile {
  const base = file ?? emptyReportText();
  const part = base.parts[id];
  const next = withVersion(part, v);
  if (next === part) return base;
  return { ...base, parts: { ...base.parts, [id]: next } };
}

/** The person's text for a part, saved as a `user` version. */
export function editText(
  file: ReportTextFile | null,
  id: VolumetricTextId,
  text: string,
  meta: EditMeta = {},
  now: Date = new Date(),
): ReportTextFile {
  return withPart(file, id, version(text, 'user', meta, now));
}

/** Reset to generated: a `template` version, so the part follows the figures again. */
export function resetText(
  file: ReportTextFile | null,
  id: VolumetricTextId,
  generated: string,
  now: Date = new Date(),
): ReportTextFile {
  return withPart(file, id, version(generated, 'template', {}, now));
}

/**
 * Keep the record honest before a save: a part that follows the figures gets the text it was
 * last generated as. Parts never saved stay absent; returns `file` itself when nothing changed.
 */
export function recordGenerated(
  file: ReportTextFile,
  generated: Texts,
  now: Date = new Date(),
): ReportTextFile {
  let next = file;
  for (const id of TEXT_IDS) {
    const v = currentVersion(next.parts[id]);
    if (v?.source !== 'template' || v.text === generated[id]) continue;
    next = withPart(next, id, version(generated[id], 'template', {}, now));
  }
  return next;
}

/** A pile's note, cut to `PILE_NOTE_MAX` characters, saved as a `user` version. */
export function editPileNote(
  file: ReportTextFile | null,
  pileId: string,
  text: string,
  meta: EditMeta = {},
  now: Date = new Date(),
): ReportTextFile {
  const base = file ?? emptyReportText();
  const notes = base.pileNotes ?? {};
  const part = notes[pileId];
  const next = withVersion(part, version(text.slice(0, PILE_NOTE_MAX), 'user', meta, now));
  if (next === part) return base;
  return { ...base, pileNotes: { ...notes, [pileId]: next } };
}

/** The notes the report prints, by measurement id (empty notes left out). */
export function pileNotesOf(file: ReportTextFile | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, part] of Object.entries(file?.pileNotes ?? {})) {
    const text = currentVersion(part)?.text.trim() ?? '';
    if (text !== '') out[id] = text;
  }
  return out;
}

/** Pages A, B and C; a page not saved is on. */
export function pagesOf(file: ReportTextFile | null): Record<ReportPageId, boolean> {
  const saved = file?.pages ?? {};
  return Object.fromEntries(PAGE_IDS.map((id) => [id, saved[id] ?? true])) as Record<
    ReportPageId,
    boolean
  >;
}

/** Turn a page on or off; turning off the last page that is on returns `file` unchanged. */
export function setPage(
  file: ReportTextFile | null,
  id: ReportPageId,
  on: boolean,
): ReportTextFile {
  const base = file ?? emptyReportText();
  const pages = { ...pagesOf(base), [id]: on };
  if (!PAGE_IDS.some((p) => pages[p])) return base;
  if (pagesOf(base)[id] === on) return base;
  return { ...base, pages };
}

/** The date the report compares with; null goes back to the date before the latest. */
export function setCompareWith(
  file: ReportTextFile | null,
  captureId: string | null,
): ReportTextFile {
  const base = file ?? emptyReportText();
  if ((base.compareWith ?? null) === captureId) return base;
  if (captureId !== null) return { ...base, compareWith: captureId };
  const rest = { ...base };
  delete rest.compareWith;
  return rest;
}

/** The model the preview and export print: the resolved texts, pile notes and pages on it. */
export function previewModel(
  model: VolumetricModel,
  texts: ResolvedTexts,
  file: ReportTextFile | null,
): VolumetricModel {
  const notes = pileNotesOf(file);
  return {
    ...model,
    text: Object.fromEntries(TEXT_IDS.map((id) => [id, texts[id].text])),
    pages: pagesOf(file),
    piles: model.piles.map((p) => ({ ...p, note: notes[p.id] ?? null })),
  };
}
