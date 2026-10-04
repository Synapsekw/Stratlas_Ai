/**
 * The renderer tool registry and the helpers tool executors share (project lookups, issue
 * locations, targets). Executors live in renderer-tools.ts and analysis-tools.ts.
 */
import type { SceneHandle } from '@aio/engine';
import type { Issue, Layer, Vec3, WindowKind } from '@aio/schema';
import type { Workspace } from '@aio/workspace';
import { Box3, Vector3 } from 'three';
import type { StoreApi } from 'zustand/vanilla';
import { getToolSpec, toolInputs, type Target, type ToolInput, type ToolName } from './tools';

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

/**
 * Seams to the host app, registered once at startup (apps/desktop). Every hook is optional: a
 * tool that needs a missing one fails with a fixed message.
 */
export interface AppHooks {
  /** Show the original review (legacy layer) full screen. */
  openReview?: (layerId: string) => void;
  /** A dedicated issue exporter (the exports stream). The tool falls back to CSV when absent. */
  exportIssues?: (issues: readonly Issue[], format: 'csv') => Promise<SaveResult>;
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

/** A 3D point for an issue from its first sighting that has one. */
export function issuePoint(issue: Issue): Vec3 | null {
  for (const s of issue.sightings) {
    if (s.on === 'mesh') {
      const g = s.geom;
      if (g.type === 'spoint') return g.p;
      if (g.type === 'spolyline' || g.type === 'spolygon') return centroid(g.points);
      if (g.center) return g.center;
    }
    if (s.on === 'pointcloud') {
      const g = s.geom;
      if (g.type === 'point3') return g.p;
      if (g.type === 'box3') return centroid([g.min, g.max]);
      if (g.type === 'polygon3') return centroid(g.points);
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

export function assetPoint(ctx: RendererToolContext, id: string): Vec3 {
  const ref = assetRef(ctx, id);
  const scene = ctx.scene();
  if (!scene) {
    throw new ToolError(
      `Open the 3D view to locate asset "${id}", or give a point or an issue instead.`,
    );
  }
  const obj = scene.scene.getObjectByName(ref?.node ?? id);
  if (!obj) throw new ToolError(`No asset "${id}" in the 3D scene.`);
  const c = new Box3().setFromObject(obj).getCenter(new Vector3());
  return [c.x, c.y, c.z];
}

export function targetPoint(ctx: RendererToolContext, t: Target): Vec3 {
  if (t.kind === 'point') return t.p;
  if (t.kind === 'asset') return assetPoint(ctx, t.id);
  const issue = findIssue(ctx, t.id);
  const p = issuePoint(issue);
  if (!p) throw new ToolError(`Issue ${issue.code} has no 3D location.`);
  return p;
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

export function cameraUndo(ctx: RendererToolContext): (() => void) | undefined {
  const scene = ctx.scene();
  if (!scene) return undefined;
  const pos = scene.camera.position.clone();
  const quat = scene.camera.quaternion.clone();
  return () => {
    scene.camera.position.copy(pos);
    scene.camera.quaternion.copy(quat);
    scene.camera.updateMatrixWorld();
    scene.requestRender();
  };
}
