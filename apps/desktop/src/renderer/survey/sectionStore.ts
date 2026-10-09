/**
 * Cross-sections in the renderer (M11 G5, SRV-7): the section on show (the focused **Section**
 * measurement's line, or a station of the active alignment), the surfaces it samples (every
 * prepared survey surface and design surface layer of the site, up to 20), the profiles and pins
 * from the section worker, the chart's exaggeration and shading, and **Download** as DXF or CSV
 * through the `survey.section` job.
 */
import type { AioBridge, DesignsFile, HeightTiles, IpcResponse, JobRecord } from '@aio/schema';
import {
  alignmentSections,
  clampExaggeration,
  surfaceKey,
  type Pin,
  type SectionRef,
  type StationSection,
} from '@aio/survey';
import { assetUrl, workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { bridge } from '../shell';
import { designs } from './designsStore';
import { sectionEngine, type SectionResult } from './sectionEngine';

export const SECTION_COLOURS = [
  '#4cc9f0',
  '#f72585',
  '#ffd166',
  '#06d6a0',
  '#f77f00',
  '#b388ff',
  '#90be6d',
  '#ff6b6b',
  '#48bfe3',
  '#e9c46a',
];

export interface SectionChoice {
  key: string;
  ref: SectionRef;
  label: string;
  kind: 'survey' | 'design';
}

export type SectionSource =
  { kind: 'measurement'; id: string; label: string } | { kind: 'station'; label: string };

export type SectionFormat =
  'dxf-2d-xy' | 'dxf-2d-xz' | 'dxf-2d-yz' | 'dxf-3d-zup' | 'dxf-3d-yup' | 'csv';

export const FORMAT_LABELS: Record<SectionFormat, string> = {
  'dxf-2d-xz': 'DXF 2D (XZ plane)',
  'dxf-2d-xy': 'DXF 2D (XY plane)',
  'dxf-2d-yz': 'DXF 2D (YZ plane)',
  'dxf-3d-zup': 'DXF 3D (Z up)',
  'dxf-3d-yup': 'DXF 3D (Y up)',
  csv: 'CSV',
};

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
  /** Keys of the sampled surfaces, in the order shown. */
  selected: string[];
  result: SectionResult | null;
  busy: boolean;
  error: string | null;
  /** Pin chainages and their values. */
  pins: Pin[];
  /** Index (in `selected`) of the surface deltas are taken from. */
  reference: number;
  exaggeration: number;
  /** Shade cut and fill between two lines (`to - from`). */
  shade: { from: string; to: string } | null;
  cutaway: boolean;
  /** The large window (the pop-out) is open. */
  window: boolean;
  /** The dock was closed for this source; it opens again for another. */
  dismissed: string | null;
  stations: StationMode | null;
  exporting: { format: SectionFormat; note: string | null; busy: boolean } | null;
}

const initial = (): SectionState => ({
  projectId: null,
  choices: [],
  sourcesError: null,
  source: null,
  line: null,
  selected: [],
  result: null,
  busy: false,
  error: null,
  pins: [],
  reference: 0,
  exaggeration: 5,
  shade: null,
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

/** The refs of the selected surfaces. */
export function selectedRefs(s: Pick<SectionState, 'choices' | 'selected'>): SectionRef[] {
  return s.selected.flatMap((k) => s.choices.find((c) => c.key === k)?.ref ?? []);
}

export function colourOf(i: number): string {
  return SECTION_COLOURS[i % SECTION_COLOURS.length] ?? '#ffffff';
}

// ------------------------------------------------------------------------------- the surfaces

function choicesOf(surfaces: HeightTiles[], file: DesignsFile | null): SectionChoice[] {
  const out: SectionChoice[] = [];
  for (const s of surfaces) {
    if (s.source.kind === 'design') continue;
    const ref: SectionRef = { kind: 'survey', surface: s.id };
    out.push({ key: surfaceKey(ref), ref, label: s.name, kind: 'survey' });
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
  const choices = choicesOf(surfaces, dfile);
  const captures = [...project.manifest.captures]
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1))
    .map((c) => c.id);
  await sectionEngine().setSources({
    base: assetUrl(projectId, { path: 'x' }).slice(0, -1),
    surfaces,
    designs: dfile?.designs ?? [],
    captures,
  });
  const keep = get().selected.filter((k) => choices.some((c) => c.key === k));
  set({
    choices,
    sourcesError: null,
    selected: keep.length ? keep : choices.map((c) => c.key),
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
    const pins = await Promise.all(
      get().pins.map((p) =>
        sectionEngine().pin({ line, refs, chainage: p.chainage, reference: get().reference }),
      ),
    );
    if (my !== seq) return;
    set({ result, pins, busy: false });
  } catch (e) {
    if (my !== seq) return;
    set({ busy: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Show a section along a line (E, N). */
export function openSection(line: [number, number][], source: SectionSource): void {
  const same = sourceId(source) === sourceId(get().source);
  const sameLine = JSON.stringify(line) === JSON.stringify(get().line);
  set({
    line,
    source,
    dismissed: null,
    ...(same ? {} : { pins: [], stations: source.kind === 'station' ? get().stations : null }),
  });
  if (!same || !sameLine) void recompute();
}

/** Close the dock (it opens again for another section). */
export function closeSection(): void {
  set({ dismissed: sourceId(get().source), window: false, cutaway: false });
}

export function isDismissed(s: Pick<SectionState, 'dismissed' | 'source'>): boolean {
  return s.dismissed !== null && s.dismissed === sourceId(s.source);
}

export function toggleSurface(key: string): void {
  const s = get();
  const selected = s.selected.includes(key)
    ? s.selected.filter((k) => k !== key)
    : s.choices.map((c) => c.key).filter((k) => k === key || s.selected.includes(k));
  const shade =
    s.shade && selected.includes(s.shade.from) && selected.includes(s.shade.to) ? s.shade : null;
  set({ selected, shade, reference: Math.min(s.reference, Math.max(0, selected.length - 1)) });
  void recompute();
}

export async function addPin(chainage: number): Promise<void> {
  const s = get();
  if (!s.line) return;
  const refs = selectedRefs(s);
  if (!refs.length) return;
  try {
    const pin = await sectionEngine().pin({ line: s.line, refs, chainage, reference: s.reference });
    set({ pins: [...get().pins, pin].sort((a, b) => a.chainage - b.chainage) });
  } catch (e) {
    set({ error: e instanceof Error ? e.message : String(e) });
  }
}

export function removePin(i: number): void {
  set({ pins: get().pins.filter((_, k) => k !== i) });
}

export function setReference(i: number): void {
  set({ reference: i });
  void recompute();
}

export function setExaggeration(x: number): void {
  set({ exaggeration: clampExaggeration(x) });
}

export function setShade(shade: { from: string; to: string } | null): void {
  set({ shade });
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

const slug = (s: string) =>
  s
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 60) || 'section';

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
      done({ ok: false, error: 'Jobs are not available here.' });
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

/**
 * **Download**: ask where to save first (`dialog:savePath`), then run `survey.section` with that
 * file as its `out`, so nothing is written into the project. Answers an error sentence or null
 * (null too when the person cancels the dialog).
 */
export async function exportSection(format: SectionFormat): Promise<string | null> {
  const s = get();
  const project = workspace.getState().project;
  if (!project) return 'No project is open.';
  if (!s.line) return 'Draw a section first.';
  const refs = selectedRefs(s);
  if (!refs.length) return 'Pick at least one surface.';
  const ext = format === 'csv' ? 'csv' : 'dxf';
  const name = `${slug(s.source?.label ?? 'section')}-${format}.${ext}`;
  const fail = (error: string) => {
    set({ exporting: { format, busy: false, note: error } });
    return error;
  };
  const chosen = await bridge.call('dialog:savePath', {
    defaultName: name,
    title: `Save the cross-section (${FORMAT_LABELS[format]})`,
    filters: [{ name: ext === 'csv' ? 'CSV' : 'DXF', extensions: [ext] }],
  });
  if (!chosen.ok) return fail(chosen.error);
  if (chosen.value.error) return fail(chosen.value.error);
  const out = chosen.value.path;
  if (!out) {
    set({ exporting: null });
    return null;
  }
  set({ exporting: { format, busy: true, note: 'Writing the section…' } });
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
  set({ exporting: { format, busy: false, note: `Saved ${out}` } });
  return null;
}
