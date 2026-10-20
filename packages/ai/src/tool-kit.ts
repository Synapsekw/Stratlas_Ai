/**
 * The renderer tool registry and the helpers tool executors share (project lookups, issue
 * locations, targets). Executors live in renderer-tools.ts and analysis-tools.ts.
 */
import type { SceneHandle } from '@aio/engine';
import type {
  AccuracyReport,
  ComparisonResult,
  GcpFile,
  GlobeSite,
  Issue,
  Layer,
  PhotoPreset,
  PhotoProduct,
  PhotoRun,
  PhotoRunSummary,
  SurveyMeasurement,
  SurveySettings,
  Vec3,
  WindowKind,
} from '@aio/schema';
import { shiftLocal, type DateShift } from '@aio/schema';
import type { Workspace } from '@aio/workspace';
import type { StoreApi } from 'zustand/vanilla';
import { getToolSpec, toolInputs, type ToolInput, type ToolName } from './tools';

export interface RendererToolContext {
  workspace: StoreApi<Workspace>;
  /** The window the agent is bound to. */
  window: WindowKind;
  scene(): SceneHandle | null;
  fetchJson(url: string): Promise<unknown>;
  /** A JPEG or PNG data URL of what the window shows, or null. */
  captureFrame(window: WindowKind): Promise<string | null>;
  now(): Date;
  /** Ask where to save a file and write it (`dialog:saveFile`). Absent outside the desktop app. */
  saveFile?(defaultName: string, data: string): Promise<SaveResult>;
  /** Actions the host app provides: open a screen, use a dedicated exporter. */
  app?: AppHooks;
}

export interface SaveResult {
  /** Null when the person cancelled or the file could not be written. */
  path: string | null;
  error?: string;
}

/** Screens of an open project the agent can open and be docked on. */
export type AppScreen = 'scene' | 'issues' | 'media' | 'detections' | 'reports';
export type SeverityLevel = number | 'uncertain';

/** A set chosen by the agent, shown on the screen as a chip the person can clear. */
export interface ViewScope {
  /** Chip text, e.g. "On Tank T-101". */
  label: string;
  /** Issue ids (Issues) or photo keys `<layerId>/<photoId>` (Media). */
  ids: readonly string[];
}
export interface PhotoViewFilter {
  onlyFindings?: boolean;
  order?: 'file' | 'severity' | 'count';
  /** One level, "highest" for the highest level present on the photos in scope, null for any. */
  severity?: SeverityLevel | 'highest' | null;
  scope?: ViewScope | null;
}
export interface PhotoViewResult {
  shown: number;
  total: number;
  /** The level in force after "highest" was resolved; null when none. */
  severity: SeverityLevel | null;
  severityLabel: string;
}
export interface IssueViewFilter {
  severity?: SeverityLevel | null;
  classId?: string | null;
  status?: 'draft' | 'reviewed' | 'approved' | 'closed' | null;
  text?: string;
  sort?: 'code' | 'severity' | 'status' | 'updated' | 'class';
  dir?: 'asc' | 'desc';
  scope?: ViewScope | null;
}
export interface ViewFilters {
  photos: {
    onlyFindings: boolean;
    order: string;
    severity: SeverityLevel | null;
    scope: string | null;
  };
  issues: {
    severity: SeverityLevel | null;
    classId: string | null;
    status: string | null;
    text: string;
    sort: string;
    scope: string | null;
  };
}

/** What `process_photos` asks the app to start (the dialog's simple flow, without the dialog). */
export interface ProcessPhotosRequest {
  layerId: string;
  preset: PhotoPreset;
  gnss: 'auto' | 'rtk' | 'standard' | 'ignore';
  products: PhotoProduct[];
  groundControlFirst: boolean;
}

/** What the app started: the run id, the time estimate in words, the survey date (or null). */
export interface ProcessPhotosStarted {
  run: string;
  estimate: string;
  surveyDate: string | null;
}

/** One run as `accuracy_summary` reads it. */
export interface PhotoRunRead {
  run: PhotoRun;
  accuracy: AccuracyReport | null;
  gcp: GcpFile | null;
}

/** What placing one finding came to (`place_on_model`). */
export interface PlaceOutcome {
  /** The id the model gave: an issue code or id, or a detection id. */
  id: string;
  /** The issue's code, once there is an issue. */
  code?: string;
  /** What was placed: one entry per sighting written. */
  placed?: { on: 'mesh' | 'pointcloud'; type: string }[];
  /** Why nothing was placed (missed, no-photo-shape, layer-not-loaded, unknown, an accept problem). */
  reason?: string;
}

export interface PlaceOnModelRequest {
  ids: readonly string[];
  /** Layer id or name. */
  layer: string;
}

export interface PlaceOnModelResult {
  layer: { id: string; name: string };
  outcomes: PlaceOutcome[];
  /** Takes the placement back (the issues it changed), when nothing changed them since. */
  undo?: () => void;
}

/** Where `add_sighting` adds a place: a point, or a box on a photo to project onto the layer. */
export type SightingAt =
  | { kind: 'point'; p: Vec3 }
  | { kind: 'photo'; photo: string; box: [number, number, number, number] };

export interface AddSightingRequest {
  /** Issue code or id. */
  issue: string;
  /** Layer id or name. */
  layer: string;
  at: SightingAt;
}

export interface AddSightingResult {
  code: string;
  placed: { on: 'mesh' | 'pointcloud'; type: string }[];
  /** Why nothing was placed (for example the photo box missed the model). */
  reason?: string;
  undo?: () => void;
}

/**
 * Seams to the host app, registered once at startup (apps/desktop). Every hook is optional: a
 * tool that needs a missing one fails with a fixed message.
 */
export interface AppHooks {
  /** A dedicated issue exporter (the exports stream). The tool falls back to CSV when absent. */
  exportIssues?: (issues: readonly Issue[], format: 'csv') => Promise<SaveResult>;
  /** What the stage shows now: the 3D view, the map, or both (split). */
  stageView?: () => { show3d: boolean; showMap: boolean };
  /** Show the 3D view (a Map-only stage switches to 3D). */
  show3d?: () => void;
  /** The library's sites on the Globe (`globe:sites`). */
  listSites?: () => Promise<GlobeSite[]>;
  /** Open the Globe and fly to a site (a project id), or over the whole library (null). */
  showOnGlobe?: (projectId: string | null) => void;
  /** Start `photo.align` on a photos layer and queue its maps (throws a ToolError when refused). */
  processPhotos?: (req: ProcessPhotosRequest) => Promise<ProcessPhotosStarted>;
  /** The open project's photo runs (`photo:runs`, newest first) and one run with its report. */
  photoRuns?: {
    list: () => Promise<PhotoRunSummary[]>;
    read: (run: string) => Promise<PhotoRunRead>;
  };
  /** The screen that is showing; "other" for Globe, Settings, the project list. */
  screen?: () => AppScreen | 'other';
  /** Open a project screen. Opening a screen with the agent column unfolds the column. */
  openScreen?: (screen: AppScreen) => void;
  /** Replace the Media filter (unnamed fields go back to their defaults) and say what it shows. */
  showPhotos?: (filter: PhotoViewFilter) => PhotoViewResult;
  /** Replace the Issues filter and say how many it shows. */
  showIssues?: (filter: IssueViewFilter) => { shown: number };
  /** Open the issue's photo or video frame beside the 3D view, as a click on its pin does. False: it has none. */
  showEvidence?: (issueId: string) => boolean;
  /** Remember the screen, both filters and the stage layout; the returned function puts them back. */
  captureView?: () => () => void;
  /** The filters that are on, for the context. */
  viewFilters?: () => ViewFilters;
  /** Create an issue class in the open project (after the person approved `propose_class`). */
  createClass?: (label: string) => Promise<{ id: string; label: string }>;
  /** Place findings on a mesh or point cloud layer (accepting waiting detections first). */
  placeOnModel?: (req: PlaceOnModelRequest) => Promise<PlaceOnModelResult>;
  /** Add a place on a mesh or point cloud layer to an existing issue. */
  addSighting?: (req: AddSightingRequest) => Promise<AddSightingResult>;
  /**
   * Whether a volume measurement's figure is stale as the app judges it (its fingerprints now):
   * `stored` for the measurement's stored result, else a per-date one. The Volumes view's rule.
   */
  volumeStale?: (m: SurveyMeasurement, r: ComparisonResult, stored: boolean) => boolean;
  /**
   * The measurements and site settings the app's store holds for a project, when it has that
   * project open: what the app shows (the dates worked out, unsaved or in a read-only package).
   * Null when it has not; the tools then read the files.
   */
  surveyMeasurements?: (
    projectId: string,
  ) => { measurements: SurveyMeasurement[]; settings: SurveySettings } | null;
}

export const appHooks: AppHooks = {};

/** Register host app hooks (merged; later calls replace the hooks they name). */
export function registerAppHooks(hooks: AppHooks): () => void {
  Object.assign(appHooks, hooks);
  return () => {
    for (const k of Object.keys(hooks) as (keyof AppHooks)[]) {
      if (appHooks[k] === hooks[k]) Reflect.deleteProperty(appHooks, k);
    }
  };
}

export interface ToolRunResult {
  /** JSON for the model. `{ image: dataUrl, ... }` reaches the model as an image. */
  result: unknown;
  /** Short text for the step chip, e.g. "4 of 25 clips". */
  summary: string;
  /** Puts the view back as it was (time, camera, selection, visibility, a new draft). */
  undo?: () => void;
}

export type RendererToolRun = (input: unknown, ctx: RendererToolContext) => Promise<ToolRunResult>;

/** A failure with a message that is safe and useful to show the model and the person. */
export class ToolError extends Error {
  override name = 'ToolError';
}

const executors = new Map<string, RendererToolRun>();

export function registerRendererTool(name: string, run: RendererToolRun): void {
  if (executors.has(name)) throw new Error(`A renderer tool named "${name}" is already registered`);
  executors.set(name, run);
}

export function getRendererTool(name: string): RendererToolRun | undefined {
  return executors.get(name);
}

/** Validate the input against the catalogue schema, then run. */
export async function runRendererTool(
  name: string,
  rawInput: unknown,
  ctx: RendererToolContext,
): Promise<ToolRunResult> {
  const run = executors.get(name);
  const spec = getToolSpec(name);
  if (!run || !spec) throw new ToolError(`The tool "${name}" is not available in this window.`);
  if (spec.meta.windows && !spec.meta.windows.includes(ctx.window)) {
    throw new ToolError(`The tool "${name}" is not available in this window.`);
  }
  const parsed = spec.input.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? ` at ${first.path.join('.')}` : '';
    throw new ToolError(`Invalid input${where}: ${first?.message ?? 'does not match the tool'}.`);
  }
  return run(parsed.data, ctx);
}

export function define<N extends ToolName>(
  name: N,
  run: (input: ToolInput<N>, ctx: RendererToolContext) => Promise<ToolRunResult> | ToolRunResult,
): void {
  registerRendererTool(name, (input, ctx) =>
    Promise.resolve(run(toolInputs[name].parse(input) as ToolInput<N>, ctx)),
  );
}

// Helpers ------------------------------------------------------------------------------------

export type VideoLayer = Extract<Layer, { kind: 'video' }>;
export type MeshLayer = Extract<Layer, { kind: 'mesh' }>;

export function project(ctx: RendererToolContext) {
  const p = ctx.workspace.getState().project;
  if (!p) throw new ToolError('No project is open.');
  return p;
}

export function clips(ctx: RendererToolContext): VideoLayer[] {
  return project(ctx).manifest.layers.filter((l): l is VideoLayer => l.kind === 'video');
}

export function clip(ctx: RendererToolContext, id: string): VideoLayer {
  const c = clips(ctx).find((l) => l.id === id || l.name === id);
  if (!c) throw new ToolError(`No clip "${id}" in this project. Use list_clips to see them.`);
  return c;
}

export function findIssue(ctx: RendererToolContext, idOrCode: string): Issue {
  const issues = ctx.workspace.getState().issues;
  const i = issues.find((x) => x.id === idOrCode) ?? issues.find((x) => x.code === idOrCode);
  if (!i) throw new ToolError(`No issue "${idOrCode}" in this project.`);
  return i;
}

export const iso = (ms: number) => new Date(ms).toISOString();
export const round1 = (n: number) => Math.round(n * 10) / 10;
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function centroid(points: readonly Vec3[]): Vec3 | null {
  if (points.length === 0) return null;
  const s = points.reduce<Vec3>((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]);
  return [s[0] / points.length, s[1] / points.length, s[2] / points.length];
}

/**
 * A 3D point for an issue from its first sighting that has one, where it is drawn: with its
 * layer's date shift when `shiftOf` is given (line up dates; `places.ts` `issuePoints` alike).
 */
export function issuePoint(
  issue: Issue,
  shiftOf?: (layerId: string) => DateShift | null,
): Vec3 | null {
  const at = (p: Vec3 | null, layer: string): Vec3 | null =>
    p && shiftOf ? shiftLocal(p, shiftOf(layer)) : p;
  for (const s of issue.sightings) {
    if (s.on === 'mesh') {
      const g = s.geom;
      if (g.type === 'spoint') return at(g.p, s.layer);
      if (g.type === 'spolyline' || g.type === 'spolygon') return at(centroid(g.points), s.layer);
      if (g.center) return at(g.center, s.layer);
    }
    if (s.on === 'pointcloud') {
      const g = s.geom;
      if (g.type === 'point3') return at(g.p, s.layer);
      if (g.type === 'box3') return at(centroid([g.min, g.max]), s.layer);
      if (g.type === 'polygon3') return at(centroid(g.points), s.layer);
    }
  }
  return null;
}

/** The mesh layer and scene node for an asset tag (or node name). */
export function assetRef(
  ctx: RendererToolContext,
  id: string,
): { layer: MeshLayer; node: string } | null {
  for (const l of project(ctx).manifest.layers) {
    if (l.kind !== 'mesh') continue;
    const tag = l.tags?.find((t) => t.tag === id || t.node === id);
    if (tag) return { layer: l, node: tag.node };
  }
  return null;
}

export function issueRow(i: Issue) {
  return {
    id: i.id,
    code: i.code,
    title: i.title,
    classId: i.classId,
    severity: i.severity,
    status: i.status,
    source: i.source,
    layers: [...new Set(i.sightings.map((s) => s.layer))],
  };
}

export function severityRank(s: Issue['severity']): number {
  return s === 'uncertain' ? -1 : s;
}

/**
 * Natural order for codes: prefix, then number (F2 before F10). A copy of `compareCodes` in
 * @aio/annotate (model/query.ts), which this package must not depend on. The two must order alike,
 * so that "the first by code" is the finding the issue register lists first; the desktop app sees
 * both packages and holds them together (renderer/agent/codeOrder.test.ts).
 */
export function compareCodes(a: string, b: string): number {
  const pa = /^([A-Z]*)(\d*)$/.exec(a);
  const pb = /^([A-Z]*)(\d*)$/.exec(b);
  const prefixA = pa?.[1] ?? a;
  const prefixB = pb?.[1] ?? b;
  if (prefixA !== prefixB) return prefixA < prefixB ? -1 : 1;
  return Number(pa?.[2] ?? 0) - Number(pb?.[2] ?? 0);
}

/**
 * Worst first; findings of one level in code order, so the first is the same every time. The
 * register's sort by severity (`sortIssues` in @aio/annotate), and it must stay that.
 */
export const worstFirst = (a: Issue, b: Issue): number =>
  severityRank(b.severity) - severityRank(a.severity) || compareCodes(a.code, b.code);

/** The issue classes of the project. A project without any cannot take a class. */
export function issueClasses(ctx: RendererToolContext) {
  const classes = project(ctx).manifest.classCatalogues.flatMap((c) => c.classes);
  if (classes.length === 0) {
    throw new ToolError(
      'This project has no issue classes yet. Propose one with propose_class; a person confirms it.',
    );
  }
  return classes;
}

/** An issue class by its id or its label. The error lists the classes, so the model can choose. */
export function issueClass(ctx: RendererToolContext, ref: string | undefined) {
  const classes = issueClasses(ctx);
  const label = ref?.toLowerCase();
  const cls =
    classes.find((c) => c.id === ref) ??
    classes.find((c) => c.label === ref) ??
    classes.find((c) => c.label.toLowerCase() === label);
  if (cls) return cls;
  const list = classes
    .slice(0, 20)
    .map((c) => `${c.id} (${c.label})`)
    .join(', ');
  throw new ToolError(`Choose classId from this project's classes: ${list}.`);
}
