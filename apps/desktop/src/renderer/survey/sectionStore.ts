/**
 * Cross-sections in the renderer (M11 G5, SRV-7; volumetric parity W1): the section on show (the
 * focused **Section** measurement's line, or a station of the active alignment), the surfaces on
 * its chart (the current survey by default; any other survey date or design surface added as a
 * chip, up to 20 to pick from), the profiles and pins from the section worker, the chart's
 * exaggeration and "Shade vs" target, and the files: PNG and CSV written in the app, DXF through
 * the `survey.section` job.
 */
import type {
  AioBridge,
  DesignsFile,
  HeightTiles,
  IpcResponse,
  JobRecord,
  ProjectManifest,
  SurveyPrecision,
  SurveyUnits,
} from '@aio/schema';
import {
  alignmentSections,
  clampExaggeration,
  surfaceKey,
  type ChartSeries,
  type Pin,
  type SeriesKind,
  type SectionRef,
  type StationSection,
} from '@aio/survey';
import { formatDate, t } from '@aio/ui';
import { assetUrl, workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { sectionCsv } from '../charts/exportChart';
import { bridge } from '../shell';
import { designs } from './designsStore';
import { fileBase } from './exportHelpers';
import { sectionEngine, type SectionResult } from './sectionEngine';

export interface SectionChoice {
  key: string;
  ref: SectionRef;
  label: string;
  kind: 'survey' | 'design';
  /** The survey date the surface was made from (surveys only). */
  capture?: string;
  /** That date (ISO), so earlier dates shade by age. */
  date?: string;
  /** What the survey surface is made from (a derived surface: what it was derived from). */
  surface?: SurfaceType;
  /** A derived surface (a cleanup or a crop of another). */
  edited?: boolean;
}

export type SurfaceType = 'dsm' | 'dtm' | 'cloud';

/** Which of a survey's surfaces is its current one: a DSM first, then DTM, then the cloud. */
const TYPE_RANK: Record<SurfaceType, number> = { dsm: 0, dtm: 1, cloud: 2 };
const preference = (c: SectionChoice) =>
  (c.surface ? TYPE_RANK[c.surface] : 3) * 2 + (c.edited ? 1 : 0);

export type SectionSource =
  | {
      kind: 'measurement';
      id: string;
      label: string;
      /** The survey the measurement is scoped to (absent: site-wide, viewed on the latest). */
      capture?: string;
    }
  | { kind: 'station'; label: string };

/** The DXF variants `survey.section` writes (PNG and CSV are made in the app). */
export type SectionFormat = 'dxf-2d-xy' | 'dxf-2d-xz' | 'dxf-2d-yz' | 'dxf-3d-zup' | 'dxf-3d-yup';

/** The DXF variants' names (i18n keys), for the export dialog and the save title. */
export const FORMAT_LABELS = {
  'dxf-2d-xz': 'section.format.dxf2dXz',
  'dxf-2d-xy': 'section.format.dxf2dXy',
  'dxf-2d-yz': 'section.format.dxf2dYz',
  'dxf-3d-zup': 'section.format.dxf3dZup',
  'dxf-3d-yup': 'section.format.dxf3dYup',
} as const satisfies Record<SectionFormat, string>;

/** The DXF variants in the export dialog's order. */
export const DXF_FORMATS = Object.keys(FORMAT_LABELS) as readonly SectionFormat[];

/** What a note under the pins is about: a file written, or Add to report. */
export type ExportKind = SectionFormat | 'csv' | 'png' | 'report';

export interface StationMode {
  intervalM: number;
  leftM: number;
  rightM: number;
  index: number;
}

export interface SectionState {
  projectId: string | null;
  /** The surfaces a section can sample. */
  choices: SectionChoice[];
  sourcesError: string | null;
  source: SectionSource | null;
  line: [number, number][] | null;
  /** Keys of the surfaces on the chart (its chips, all sampled), in the order listed. */
  selected: string[];
  /** Keys of chips switched off: still sampled, not drawn. */
  hidden: string[];
  result: SectionResult | null;
  busy: boolean;
  error: string | null;
  /** Pin chainages and their values. */
  pins: Pin[];
  exaggeration: number;
  /**
   * The shown surface the current survey's cut and fill is shaded against, and the pins' deltas
   * are taken from (null: none, deltas from the current survey).
   */
  shadeVs: string | null;
  cutaway: boolean;
  /** The large window (the pop-out) is open. */
  window: boolean;
  /** The dock was closed for this source; it opens again for another. */
  dismissed: string | null;
  stations: StationMode | null;
  exporting: { format: ExportKind; note: string | null; busy: boolean } | null;
}

const initial = (): SectionState => ({
  projectId: null,
  choices: [],
  sourcesError: null,
  source: null,
  line: null,
  selected: [],
  hidden: [],
  result: null,
  busy: false,
  error: null,
  pins: [],
  exaggeration: 5,
  shadeVs: null,
  cutaway: false,
  window: false,
  dismissed: null,
  stations: null,
  exporting: null,
});

export const sectionStore = createStore<SectionState>()(initial);

export function useSection<T>(selector: (s: SectionState) => T): T {
  return useStore(sectionStore, selector);
}

const get = () => sectionStore.getState();
const set = (p: Partial<SectionState>) => {
  sectionStore.setState(p);
};

const sourceId = (s: SectionSource | null) =>
  !s ? '' : s.kind === 'measurement' ? `m:${s.id}` : `s:${s.label}`;

const manifestNow = (): ProjectManifest | null => workspace.getState().project?.manifest ?? null;

/** The refs of the selected surfaces (all sampled, switched on or off). */
export function selectedRefs(s: Pick<SectionState, 'choices' | 'selected'>): SectionRef[] {
  return s.selected.flatMap((k) => s.choices.find((c) => c.key === k)?.ref ?? []);
}

/** The refs of the surfaces drawn: on the chart and switched on. */
export function visibleRefs(
  s: Pick<SectionState, 'choices' | 'selected' | 'hidden'>,
): SectionRef[] {
  return selectedRefs({
    choices: s.choices,
    selected: s.selected.filter((k) => !s.hidden.includes(k)),
  });
}

/** The survey a section is viewed on: its measurement's own, else the latest date. */
function viewedCapture(
  source: SectionSource | null,
  manifest: ProjectManifest | null,
): string | null {
  if (source?.kind === 'measurement' && source.capture) return source.capture;
  let latest: { id: string; date: string } | null = null;
  for (const c of manifest?.captures ?? []) if (!latest || c.date >= latest.date) latest = c;
  return latest?.id ?? null;
}

/** The surface of `surveys` most preferred as a survey's current one (DSM, edited DSM, DTM ...). */
const preferred = (surveys: readonly SectionChoice[]): SectionChoice | undefined =>
  [...surveys].sort((a, b) => preference(a) - preference(b))[0];

/**
 * The key of the section's current survey: among the surfaces of the survey it is viewed on (else
 * of the latest date that has one, else all of them), the DSM, then an edited DSM, then the DTM,
 * then the cloud; never by list order. Null without survey surfaces.
 */
export function currentKey(
  choices: readonly SectionChoice[],
  source: SectionSource | null,
  manifest: ProjectManifest | null,
): string | null {
  const surveys = choices.filter((c) => c.kind === 'survey');
  const viewed = viewedCapture(source, manifest);
  const own = surveys.filter((c) => viewed !== null && c.capture === viewed);
  if (own.length) return preferred(own)?.key ?? null;
  let latest: string | null = null;
  for (const c of surveys) if (c.date && (latest === null || c.date > latest)) latest = c.date;
  const pool = latest === null ? surveys : surveys.filter((c) => c.date === latest);
  return preferred(pool)?.key ?? null;
}

/**
 * How a surface is drawn, from the surface (never its place in the list): the current survey
 * `current`, another surface of the current survey's date `same-date`, other survey dates
 * `earlier`, design surfaces `design`. A section samples no pile base, so never `base`.
 */
export function kindOf(choice: SectionChoice, current: SectionChoice | null): SeriesKind {
  if (choice.kind === 'design') return 'design';
  if (choice.key === current?.key) return 'current';
  if (current?.capture !== undefined && choice.capture === current.capture) return 'same-date';
  return 'earlier';
}

/** The chart's series, one per sampled profile in the order listed, each with `kindOf`. */
export function sectionSeries(
  s: Pick<SectionState, 'choices' | 'selected' | 'result' | 'source'>,
  manifest: ProjectManifest | null,
): ChartSeries[] {
  const key0 = currentKey(s.choices, s.source, manifest);
  const current = s.choices.find((c) => c.key === key0) ?? null;
  const out: ChartSeries[] = [];
  for (const key of s.selected) {
    const p = s.result?.profiles.find((x) => x.surface === key);
    if (!p) continue;
    const c = s.choices.find((x) => x.key === key);
    out.push({
      key,
      label: c?.label ?? p.label,
      kind: c ? kindOf(c, current) : 'earlier',
      ...(c?.capture ? { capture: c.capture } : {}),
      ...(c?.date ? { date: c.date } : {}),
      chainage: p.chainage,
      z: p.z,
    });
  }
  return out;
}

/** Index (in `selected`, the sampled order) of the surface pins take their deltas from. */
function referenceOf(s: SectionState): number {
  const key = s.shadeVs ?? currentKey(s.choices, s.source, manifestNow());
  return Math.max(0, key === null ? 0 : s.selected.indexOf(key));
}

/** `keys` in the order the surfaces are listed. */
const inListOrder = (s: Pick<SectionState, 'choices'>, keys: readonly string[]) =>
  s.choices.map((c) => c.key).filter((k) => keys.includes(k));

// ------------------------------------------------------------------------------- the surfaces

function choicesOf(
  surfaces: HeightTiles[],
  file: DesignsFile | null,
  manifest: ProjectManifest | null,
): SectionChoice[] {
  const out: SectionChoice[] = [];
  const byId = new Map(surfaces.map((s) => [s.id, s]));
  /** A surface's type, following a derived one back to what it was made from. */
  const typeOf = (s: HeightTiles): SurfaceType | undefined => {
    let at: HeightTiles | undefined = s;
    for (let hops = 0; at && hops < 20; hops++) {
      const src: HeightTiles['source'] = at.source;
      if (src.kind === 'dsm' || src.kind === 'dtm' || src.kind === 'cloud') return src.kind;
      if (src.kind !== 'derived') return undefined;
      at = byId.get(src.of);
    }
    return undefined;
  };
  const surveys = surfaces.filter((s) => s.source.kind !== 'design');
  const perCapture = new Map<string, number>();
  for (const s of surveys)
    if (s.capture) perCapture.set(s.capture, (perCapture.get(s.capture) ?? 0) + 1);
  for (const s of surveys) {
    const ref: SectionRef = { kind: 'survey', surface: s.id };
    const date = manifest?.captures.find((c) => c.id === s.capture)?.date;
    const surface = typeOf(s);
    const edited = s.source.kind === 'derived';
    // a date with one surface reads as its date; with more, each says what it is ("20 Oct, DTM")
    const typeText = surface
      ? edited
        ? t('section.surface.edited', { type: t(`section.surface.${surface}`) })
        : t(`section.surface.${surface}`)
      : s.name;
    const label = !date
      ? s.name
      : s.capture && (perCapture.get(s.capture) ?? 0) > 1
        ? t('section.dateType', { date: formatDate(date), type: typeText })
        : formatDate(date);
    out.push({
      key: surfaceKey(ref),
      ref,
      label,
      kind: 'survey',
      ...(s.capture ? { capture: s.capture } : {}),
      ...(date ? { date } : {}),
      ...(surface ? { surface } : {}),
      ...(edited ? { edited } : {}),
    });
  }
  for (const d of file?.designs ?? [])
    for (const l of d.layers) {
      if (l.kind !== 'surface' || l.archived) continue;
      const ref: SectionRef = { kind: 'design', design: d.id, layer: l.id };
      const off = l.verticalOffsetM !== 0 ? ` (offset ${String(l.verticalOffsetM)} m)` : '';
      out.push({ key: surfaceKey(ref), ref, label: `${d.name}, ${l.name}${off}`, kind: 'design' });
    }
  return out.slice(0, 20);
}

/** Read the site's prepared surfaces and designs and hand them to the section worker. */
export async function loadSectionSources(projectId: string): Promise<void> {
  const project = workspace.getState().project;
  if (project?.id !== projectId) return;
  if (get().projectId !== projectId) set({ ...initial(), projectId });
  const [sf, df] = await Promise.all([
    bridge.call('survey:surfaces', { projectId }),
    bridge.call('survey:readDesigns', { projectId }),
  ]);
  if (get().projectId !== projectId) return;
  if (!sf.ok || !sf.value.ok) {
    set({ sourcesError: !sf.ok ? sf.error : sf.value.ok ? null : sf.value.error });
    return;
  }
  const dfile: DesignsFile | null =
    df.ok && df.value.ok ? df.value.file : (designs.getState().file ?? null);
  const surfaces = sf.value.surfaces;
  const choices = choicesOf(surfaces, dfile, project.manifest);
  const captures = [...project.manifest.captures]
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1))
    .map((c) => c.id);
  await sectionEngine().setSources({
    base: assetUrl(projectId, { path: 'x' }).slice(0, -1),
    surfaces,
    designs: dfile?.designs ?? [],
    captures,
  });
  const s = get();
  const keep = s.selected.filter((k) => choices.some((c) => c.key === k));
  // the current survey is on the chart by default; the others are added as chips
  const current = currentKey(choices, s.source, project.manifest);
  const selected = current && !keep.includes(current) ? [...keep, current] : keep;
  set({
    choices,
    sourcesError: null,
    selected: inListOrder({ choices }, selected),
    hidden: s.hidden.filter((k) => keep.includes(k) && k !== current),
    shadeVs: s.shadeVs !== null && keep.includes(s.shadeVs) ? s.shadeVs : null,
  });
  if (get().line) await recompute();
}

// ------------------------------------------------------------------------------- the section

let seq = 0;

/** Sample the section again (line or surfaces changed), then its pins. */
export async function recompute(): Promise<void> {
  const s = get();
  if (!s.line || s.line.length < 2) return;
  const refs = selectedRefs(s);
  const my = ++seq;
  if (!refs.length) {
    set({ result: null, busy: false, error: null });
    return;
  }
  set({ busy: true, error: null });
  try {
    const line = s.line;
    const result = await sectionEngine().section({ line, refs });
    if (my !== seq) return;
    const reference = referenceOf(get());
    const pins = await Promise.all(
      get().pins.map((p) => sectionEngine().pin({ line, refs, chainage: p.chainage, reference })),
    );
    if (my !== seq) return;
    set({ result, pins, busy: false });
  } catch (e) {
    if (my !== seq) return;
    set({ busy: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Pin values again (deltas from the new reference) without sampling the section again. */
async function repin(): Promise<void> {
  const s = get();
  if (!s.line || !s.pins.length) return;
  const refs = selectedRefs(s);
  if (!refs.length) return;
  const line = s.line;
  const reference = referenceOf(s);
  const my = ++seq;
  try {
    const pins = await Promise.all(
      s.pins.map((p) => sectionEngine().pin({ line, refs, chainage: p.chainage, reference })),
    );
    if (my === seq) set({ pins });
  } catch (e) {
    if (my === seq) set({ error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Show a section along a line (E, N). Its current survey joins the chart, switched on, when it is
 * not there yet, so a section always opens on the survey it is viewed on.
 */
export function openSection(
  line: [number, number][],
  source: SectionSource,
  manifest: ProjectManifest | null = manifestNow(),
): void {
  const s = get();
  const same = sourceId(source) === sourceId(s.source);
  const sameLine = JSON.stringify(line) === JSON.stringify(s.line);
  const current = currentKey(s.choices, source, manifest);
  const joins = current !== null && !s.selected.includes(current);
  set({
    line,
    source,
    dismissed: null,
    ...(joins ? { selected: inListOrder(s, [...s.selected, current]) } : {}),
    ...(current !== null && s.hidden.includes(current)
      ? { hidden: s.hidden.filter((k) => k !== current) }
      : {}),
    ...(same ? {} : { pins: [], stations: source.kind === 'station' ? s.stations : null }),
  });
  if (!same || !sameLine || joins) void recompute();
}

/** Close the dock (it opens again for another section). */
export function closeSection(): void {
  set({ dismissed: sourceId(get().source), window: false, cutaway: false });
}

export function isDismissed(s: Pick<SectionState, 'dismissed' | 'source'>): boolean {
  return s.dismissed !== null && s.dismissed === sourceId(s.source);
}

/** Switch a chip off (still sampled, not drawn) or on. Switched off, it is no longer shaded. */
export function toggleShown(key: string): void {
  const s = get();
  if (!s.selected.includes(key)) return;
  if (s.hidden.includes(key)) {
    set({ hidden: s.hidden.filter((k) => k !== key) });
    return;
  }
  // off, the target is no longer shaded; with the current off, nothing is
  const clears =
    s.shadeVs !== null &&
    (s.shadeVs === key || key === currentKey(s.choices, s.source, manifestNow()));
  set({ hidden: [...s.hidden, key], ...(clears ? { shadeVs: null } : {}) });
  if (clears) void repin();
}

/** Put a survey date or design surface on the chart, in the order the surfaces are listed. */
export function addSurface(ref: SectionRef): void {
  const key = surfaceKey(ref);
  const s = get();
  if (!s.choices.some((c) => c.key === key) || s.selected.includes(key)) return;
  set({
    selected: inListOrder(s, [...s.selected, key]),
    hidden: s.hidden.filter((k) => k !== key),
  });
  void recompute();
}

/** Take a surface off the chart. The current survey stays on it (its chip switches it off). */
export function removeSurface(key: string): void {
  const s = get();
  if (!s.selected.includes(key)) return;
  if (key === currentKey(s.choices, s.source, manifestNow())) return;
  set({
    selected: s.selected.filter((k) => k !== key),
    hidden: s.hidden.filter((k) => k !== key),
    ...(s.shadeVs === key ? { shadeVs: null } : {}),
  });
  void recompute();
}

export async function addPin(chainage: number): Promise<void> {
  const s = get();
  if (!s.line) return;
  const refs = selectedRefs(s);
  if (!refs.length) return;
  try {
    const pin = await sectionEngine().pin({
      line: s.line,
      refs,
      chainage,
      reference: referenceOf(s),
    });
    set({ pins: [...get().pins, pin].sort((a, b) => a.chainage - b.chainage) });
  } catch (e) {
    set({ error: e instanceof Error ? e.message : String(e) });
  }
}

export function removePin(i: number): void {
  set({ pins: get().pins.filter((_, k) => k !== i) });
}

export function setExaggeration(x: number): void {
  set({ exaggeration: clampExaggeration(x) });
}

/** Shade against a shown surface (null: none); the pins' deltas follow it. */
export function setShadeVs(key: string | null): void {
  const s = get();
  const next = key !== null && s.selected.includes(key) && !s.hidden.includes(key) ? key : null;
  if (next === s.shadeVs) return;
  set({ shadeVs: next });
  void repin();
}

export function setCutaway(on: boolean): void {
  set({ cutaway: on });
}

export function setWindow(open: boolean): void {
  set({ window: open });
}

// ------------------------------------------------------------------------------ alignment stations

/** The station sections of the active alignment for the current settings. */
export function stationSections(mode: StationMode): StationSection[] {
  const active = designs.getState().active;
  if (!active) return [];
  return alignmentSections(active.alignment, {
    intervalM: mode.intervalM,
    leftM: mode.leftM,
    rightM: mode.rightM,
  });
}

/** Show the section at a station of the active alignment (index into its stations). */
export function showStation(mode: StationMode): void {
  const all = stationSections(mode);
  if (!all.length) {
    set({ stations: mode, error: 'There is no active alignment, or it has no stations.' });
    return;
  }
  const index = Math.min(Math.max(mode.index, 0), all.length - 1);
  const st = all[index];
  if (!st) return;
  const active = designs.getState().active;
  set({ stations: { ...mode, index } });
  openSection([st.line[0], st.line[1]], {
    kind: 'station',
    label: `${active?.name ?? 'Alignment'} ${st.label}`,
  });
}

export function leaveStations(): void {
  set({ stations: null });
}

// ------------------------------------------------------------------------------------ download

type Ended = { ok: true } | { ok: false; error: string };

function ended(job: JobRecord): Ended | null {
  if (job.status === 'done') return { ok: true };
  if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'interrupted')
    return { ok: false, error: job.error ?? `The section job was ${job.status}.` };
  return null;
}

/** Wait for a job to end (its pushed updates, and the list once in case it already ended). */
export function waitForJob(id: string): Promise<Ended> {
  const aio = (globalThis as { aio?: AioBridge }).aio;
  return new Promise((done) => {
    if (!aio) {
      done({ ok: false, error: 'Processing is not available here.' });
      return;
    }
    let settled = false;
    const finish = (r: Ended) => {
      if (settled) return;
      settled = true;
      off();
      done(r);
    };
    const off = aio.on('jobs:event', (e) => {
      if (e.type !== 'update' || e.job.id !== id) return;
      const r = ended(e.job);
      if (r) finish(r);
    });
    void bridge.call('jobs:list', {}).then((l) => {
      const job = l.ok ? l.value.jobs.find((j) => j.id === id) : undefined;
      const r = job ? ended(job) : null;
      if (r) finish(r);
    });
  });
}

/** The section's file name, as the measurement exports name theirs (`fileBase`). */
const fileName = (ext: string, suffix = '') =>
  `${fileBase(get().source?.label ?? 'section')}${suffix}.${ext}`;

/** Say how an export ended under the pins: where it went, or why it did not. */
export function noteExport(format: ExportKind, note: string | null): void {
  set({ exporting: note === null ? null : { format, busy: false, note } });
}

/**
 * The section's lines as CSV: chainage, E and N of every station, then one column per surface
 * drawn (`sectionCsv`, in the site units), written in the app, so a package exports it too.
 * Answers an error sentence or null.
 */
export async function exportSectionCsv(
  series: readonly ChartSeries[],
  units: SurveyUnits,
  precision: SurveyPrecision,
): Promise<string | null> {
  const fail = (error: string) => {
    noteExport('csv', error);
    return error;
  };
  const result = get().result;
  if (!series.length || !result) return fail(t('section.showOne'));
  const r = await bridge.call('dialog:saveFile', {
    defaultName: fileName('csv'),
    data: sectionCsv(result, series, units, precision),
  });
  if (!r.ok) return fail(r.error);
  if (r.value.error) return fail(r.value.error);
  const path = r.value.path;
  noteExport('csv', path ? t('section.saved', { path }) : null);
  return null;
}

/**
 * The DXF: ask where to save first (`dialog:savePath`), then run `survey.section` with that file
 * as its `out`, so nothing is written into the project. Only the surfaces drawn go in, as in the
 * PNG and the CSV. Answers an error sentence or null (null too when the person cancels).
 */
export async function exportSection(format: SectionFormat): Promise<string | null> {
  const s = get();
  const project = workspace.getState().project;
  if (!project) return t('report.noProject');
  if (!s.line) return t('section.drawFirst');
  const refs = visibleRefs(s);
  const fail = (error: string) => {
    noteExport(format, error);
    return error;
  };
  if (!refs.length) return fail(t('section.showOne'));
  const chosen = await bridge.call('dialog:savePath', {
    defaultName: fileName('dxf', `-${format}`),
    title: t('section.saveTitle', { format: t(FORMAT_LABELS[format]) }),
    filters: [{ name: t('chart.dxf'), extensions: ['dxf'] }],
  });
  if (!chosen.ok) return fail(chosen.error);
  if (chosen.value.error) return fail(chosen.value.error);
  const out = chosen.value.path;
  if (!out) {
    noteExport(format, null);
    return null;
  }
  set({ exporting: { format, busy: true, note: t('section.writing') } });
  const r = await bridge.call('jobs:start', {
    pipeline: 'survey.section',
    project: project.root,
    params: { line: s.line, surfaces: refs, format, out },
  });
  if (!r.ok) return fail(r.error);
  const started: IpcResponse<'jobs:start'> = r.value;
  if (!started.ok) return fail(started.error);
  const done = await waitForJob(started.job.id);
  if (!done.ok) return fail(done.error);
  noteExport(format, t('section.saved', { path: out }));
  return null;
}
