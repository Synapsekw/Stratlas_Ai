/**
 * Renderer-side executors for the agent tools. The main process asks for a tool call over
 * `ai:event`; the panel runs it here against the workspace store and the live scene, then answers
 * with `ai:toolResult`. Other packages add tools with registerRendererTool (plus registerToolSpec in
 * a module both processes load). Errors thrown as ToolError carry fixed text for the model.
 */
import { getActiveScene } from '@aio/engine';
import {
  validateIssueAgainstModel,
  type AioBridge,
  type Issue,
  type Sighting,
  type Vec3,
  type WindowKind,
} from '@aio/schema';
import { assetUrl, workspace, type Selection } from '@aio/workspace';
import './analysis-tools';
import { clipStartUtcMs, selectionLabel } from './context';
import { parseFlight, passNear } from './geometry';
import { capturePhoto, MAX_EDGE } from './photo-frame';
import {
  appHooks,
  assetPoint,
  assetRef,
  cameraUndo,
  clip,
  clips,
  define,
  findIssue,
  iso,
  plural,
  project,
  round1,
  severityRank,
  issueRow,
  targetPoint,
  ToolError,
  type RendererToolContext,
} from './tool-kit';
import type { Target } from './tools';

export {
  getRendererTool,
  registerAppHooks,
  registerRendererTool,
  runRendererTool,
  ToolError,
  type AppHooks,
  type RendererToolContext,
  type RendererToolRun,
  type ToolRunResult,
} from './tool-kit';

// Read tools ---------------------------------------------------------------------------------

define('list_layers', ({ kind }, ctx) => {
  const ws = ctx.workspace.getState();
  const layers = project(ctx)
    .manifest.layers.filter((l) => !kind || l.kind === kind)
    .map((l) => ({ id: l.id, name: l.name, kind: l.kind, visible: ws.isLayerVisible(l.id) }));
  return { result: { layers }, summary: plural(layers.length, 'layer') };
});

define('list_clips', (_input, ctx) => {
  const active = ctx.workspace.getState().activeClip;
  const list = clips(ctx).map((c) => ({
    id: c.id,
    name: c.name,
    startUtc: iso(clipStartUtcMs(c)),
    active: c.id === active,
  }));
  return { result: { clips: list }, summary: plural(list.length, 'clip') };
});

define('find_clips_near', async ({ target, radiusM }, ctx) => {
  const p = targetPoint(ctx, target);
  const projectId = project(ctx).id;
  const all = clips(ctx);
  const found = await Promise.all(
    all.map(async (c) => {
      let json: unknown;
      try {
        json = await ctx.fetchJson(assetUrl(projectId, c.flight.src));
      } catch {
        return null;
      }
      const flight = parseFlight(json);
      if (!flight) return null;
      const r = passNear(flight, c.flight.startUtcMs, p, radiusM);
      if (!r) return null;
      const start = clipStartUtcMs(c);
      return {
        id: c.id,
        name: c.name,
        minDistanceM: round1(r.minDistanceM),
        closestAtUtc: iso(r.closestAtUtcMs),
        closestAtClipSeconds: round1((r.closestAtUtcMs - start) / 1000),
        ranges: r.ranges.map(([a, b]) => ({
          fromUtc: iso(a),
          toUtc: iso(b),
          fromClipSeconds: round1((a - start) / 1000),
          toClipSeconds: round1((b - start) / 1000),
        })),
      };
    }),
  );
  const hits = found
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.minDistanceM - b.minDistanceM);
  return {
    result: { point: p, radiusM, clips: hits },
    summary: `${hits.length} of ${plural(all.length, 'clip')}`,
  };
});

define('list_issues', (f, ctx) => {
  const text = f.text?.toLowerCase();
  const matching = ctx.workspace
    .getState()
    .issues.filter(
      (i) =>
        (!f.status || i.status === f.status) &&
        (!f.classId || i.classId === f.classId) &&
        (!f.source || i.source === f.source) &&
        (f.severityMin === undefined || severityRank(i.severity) >= f.severityMin) &&
        (f.severityMax === undefined ||
          (i.severity !== 'uncertain' && i.severity <= f.severityMax)) &&
        (!text || `${i.code} ${i.title} ${i.note}`.toLowerCase().includes(text)),
    );
  const issues = matching.slice(0, f.limit).map(issueRow);
  return {
    result: { total: matching.length, shown: issues.length, issues },
    summary: plural(matching.length, 'issue'),
  };
});

define('summarize_issues', ({ status }, ctx) => {
  const m = project(ctx).manifest;
  const label = new Map(m.classCatalogues.flatMap((c) => c.classes.map((k) => [k.id, k.label])));
  const issues = ctx.workspace.getState().issues.filter((i) => !status || i.status === status);
  const count = (key: (i: Issue) => string) => {
    const out: Record<string, number> = {};
    for (const i of issues) out[key(i)] = (out[key(i)] ?? 0) + 1;
    return out;
  };
  const worst = [...issues]
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .slice(0, 10)
    .map(issueRow);
  return {
    result: {
      total: issues.length,
      bySeverity: count((i) => String(i.severity)),
      byStatus: count((i) => i.status),
      byClass: count((i) => label.get(i.classId) ?? i.classId),
      bySource: count((i) => i.source),
      mostSevere: worst,
    },
    summary: plural(issues.length, 'issue'),
  };
});

// Navigate tools -----------------------------------------------------------------------------

define('set_time', (input, ctx) => {
  const ws = ctx.workspace.getState();
  let t: number;
  if (input.iso !== undefined) t = Date.parse(input.iso);
  else if (input.utcMs !== undefined) t = input.utcMs;
  else t = clipStartUtcMs(clip(ctx, input.clipId ?? '')) + (input.clipSeconds ?? 0) * 1000;
  project(ctx);
  const before = ws.nowMs;
  ws.setTime(t);
  return {
    result: { nowUtc: iso(t) },
    summary: iso(t).slice(11, 19),
    undo: () => {
      ctx.workspace.getState().setTime(before);
    },
  };
});

define('play_clip', ({ clipId, fromSeconds }, ctx) => {
  const c = clip(ctx, clipId);
  const ws = ctx.workspace.getState();
  const before = { clip: ws.activeClip, now: ws.nowMs, playing: ws.playing };
  const t = clipStartUtcMs(c) + (fromSeconds ?? 0) * 1000;
  ws.setActiveClip(c.id);
  ws.setTime(t);
  ws.play();
  return {
    result: { playing: c.id, fromUtc: iso(t) },
    summary: c.name,
    undo: () => {
      const s = ctx.workspace.getState();
      s.setActiveClip(before.clip);
      s.setTime(before.now);
      if (before.playing) s.play();
      else s.pause();
    },
  };
});

define('fly_to', ({ target, distanceM }, ctx) => {
  const ws = ctx.workspace.getState();
  const undo = cameraUndo(ctx);
  let label: string;
  if (target.kind === 'point') {
    ws.flyTo(
      distanceM === undefined
        ? { kind: 'point', p: target.p }
        : { kind: 'point', p: target.p, distance: distanceM },
    );
    label = target.p.map((n) => n.toFixed(1)).join(', ');
  } else if (target.kind === 'issue') {
    const issue = findIssue(ctx, target.id);
    ws.flyTo({ kind: 'selection', selection: { kind: 'issue', id: issue.id } });
    label = issue.code;
  } else {
    const ref = assetRef(ctx, target.id);
    if (!ref && !ctx.scene()?.scene.getObjectByName(target.id)) {
      throw new ToolError(`No asset "${target.id}" in this project.`);
    }
    const selection: Selection = ref
      ? { kind: 'asset', id: target.id, layer: ref.layer.id }
      : { kind: 'asset', id: target.id };
    ws.flyTo({ kind: 'selection', selection });
    label = target.id;
  }
  return undo
    ? { result: { flying: label }, summary: label, undo }
    : { result: { flying: label }, summary: label };
});

define('select', (input, ctx) => {
  const ws = ctx.workspace.getState();
  const before = ws.selection;
  const undo = () => {
    ctx.workspace.getState().select(before);
  };
  if (input.clear === true || !input.kind || !input.id) {
    ws.select(null);
    return { result: { selection: null }, summary: 'Cleared', undo };
  }
  let id = input.id;
  if (input.kind === 'issue') id = findIssue(ctx, input.id).id;
  if (input.kind === 'clip') id = clip(ctx, input.id).id;
  if (input.kind === 'layer' && !project(ctx).manifest.layers.some((l) => l.id === id)) {
    throw new ToolError(`No layer "${id}" in this project.`);
  }
  const sel: Selection = input.layer
    ? { kind: input.kind, id, layer: input.layer }
    : { kind: input.kind, id };
  ws.select(sel);
  return { result: { selection: sel }, summary: selectionLabel(ws, sel), undo };
});

define('set_layer_visible', ({ layerId, visible }, ctx) => {
  const layer = project(ctx).manifest.layers.find((l) => l.id === layerId || l.name === layerId);
  if (!layer) throw new ToolError(`No layer "${layerId}" in this project. Use list_layers.`);
  const ws = ctx.workspace.getState();
  const before = ws.isLayerVisible(layer.id);
  ws.setLayerVisible(layer.id, visible);
  return {
    result: { layer: layer.id, visible },
    summary: `${layer.name} ${visible ? 'shown' : 'hidden'}`,
    undo: () => {
      ctx.workspace.getState().setLayerVisible(layer.id, before);
    },
  };
});

// Write and send tools -----------------------------------------------------------------------

function nextAgentCode(issues: readonly Issue[]): string {
  let n = 0;
  for (const i of issues) {
    const m = /^AG(\d+)$/.exec(i.code);
    if (m?.[1]) n = Math.max(n, Number(m[1]));
  }
  return `AG${String(n + 1).padStart(2, '0')}`;
}

function pointSighting(ctx: RendererToolContext, p: Vec3, layer?: string): Sighting {
  const layers = project(ctx).manifest.layers;
  const mesh =
    layers.find((l) => l.id === layer && l.kind === 'mesh') ??
    layers.find((l) => l.kind === 'mesh');
  if (mesh) return { on: 'mesh', layer: mesh.id, geom: { type: 'spoint', p, n: [0, 1, 0] } };
  const cloud = layers.find((l) => l.kind === 'pointcloud');
  if (cloud) return { on: 'pointcloud', layer: cloud.id, geom: { type: 'point3', p } };
  throw new ToolError('This project has no 3D layer to place the issue on.');
}

/** Where the draft goes, and the class of the issue it was made from, if any. */
function draftLocation(
  ctx: RendererToolContext,
  at: Target | undefined,
): { sightings: Sighting[]; classId?: string } {
  const ws = ctx.workspace.getState();
  const target: Target | null =
    at ??
    (ws.selection?.kind === 'issue' || ws.selection?.kind === 'asset'
      ? { kind: ws.selection.kind, id: ws.selection.id }
      : null);
  if (!target) {
    throw new ToolError(
      'Say where the issue is: select an asset or issue, or give a point, then try again.',
    );
  }
  if (target.kind === 'issue') {
    const src = findIssue(ctx, target.id);
    const first = src.sightings[0];
    if (!first) throw new ToolError(`Issue ${src.code} has no location to copy.`);
    return { sightings: [first], classId: src.classId };
  }
  if (target.kind === 'asset') {
    return {
      sightings: [
        pointSighting(ctx, assetPoint(ctx, target.id), assetRef(ctx, target.id)?.layer.id),
      ],
    };
  }
  return { sightings: [pointSighting(ctx, target.p)] };
}

define('create_issue_draft', (input, ctx) => {
  const m = project(ctx).manifest;
  const classes = m.classCatalogues.flatMap((c) => c.classes);
  if (classes.length === 0) {
    throw new ToolError('This project has no issue classes yet. Add a class catalogue first.');
  }
  const { sightings, classId: inferred } = draftLocation(ctx, input.at);
  const classId = input.classId ?? inferred ?? (classes.length === 1 ? classes[0]?.id : undefined);
  const cls = classes.find((c) => c.id === classId || c.label === classId);
  if (!cls) {
    const list = classes
      .slice(0, 20)
      .map((c) => `${c.id} (${c.label})`)
      .join(', ');
    throw new ToolError(`Choose classId from this project's classes: ${list}.`);
  }
  const model = m.severityModels.find((s) => s.id === cls.severityModel);
  if (!model) throw new ToolError(`Class ${cls.label} has no severity model in this project.`);
  const ws = ctx.workspace.getState();
  const now = ctx.now().toISOString();
  const issue: Issue = {
    id: globalThis.crypto.randomUUID(),
    code: nextAgentCode(ws.issues),
    classId: cls.id,
    severityModelId: model.id,
    severity: input.severity,
    status: 'draft',
    title: input.title,
    note: input.note,
    author: 'Agent',
    createdAt: now,
    updatedAt: now,
    sightings,
    source: 'agent',
  };
  const valid = validateIssueAgainstModel(issue, model);
  if (!valid.ok) throw new ToolError(valid.error);
  ws.upsertIssue(issue);
  return {
    result: { id: issue.id, code: issue.code, status: 'draft' },
    summary: `${issue.code} drafted`,
    undo: () => {
      ctx.workspace.getState().removeIssue(issue.id);
    },
  };
});

define('capture_frame', async (_input, ctx) => {
  let image: string | null;
  try {
    image = await ctx.captureFrame(ctx.window);
  } catch {
    throw new ToolError('This window cannot be captured right now.');
  }
  if (!image) throw new ToolError('Nothing to capture in this window yet.');
  const nowMs = ctx.workspace.getState().nowMs;
  return {
    result: { image, window: ctx.window, atUtc: iso(nowMs) },
    summary: `Frame at ${iso(nowMs).slice(11, 19)}`,
  };
});

// Frame capture and the default context ------------------------------------------------------

type FrameSource = () => Promise<string | null> | string | null;
const frameSources = new Map<WindowKind, FrameSource>();

/** Let a window (video, photo viewer, map) provide its current frame as a data URL. */
export function registerFrameSource(window: WindowKind, source: FrameSource): () => void {
  frameSources.set(window, source);
  return () => {
    if (frameSources.get(window) === source) frameSources.delete(window);
  };
}

/** Longest edge sent to vision models (MAX_EDGE): larger frames cost more and do not help. */

function canvasFrom(source: CanvasImageSource, width: number, height: number): string | null {
  if (!width || !height) return null;
  const k = Math.min(1, MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * k);
  canvas.height = Math.round(height * k);
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

async function defaultCapture(window: WindowKind): Promise<string | null> {
  const registered = frameSources.get(window);
  if (registered) return registered();
  if (typeof document === 'undefined') return null;
  if (window === 'video') {
    const v = document.querySelector('video');
    if (!v || v.readyState < 2) return null;
    return canvasFrom(v, v.videoWidth, v.videoHeight);
  }
  if (window === 'scene3d' || window === 'pointcloud') {
    const scene = getActiveScene();
    if (!scene) return null;
    // Render and read in the same task, so the drawing buffer still holds the frame.
    scene.renderer.render(scene.scene, scene.camera);
    const c = scene.renderer.domElement;
    return canvasFrom(c, c.width, c.height);
  }
  if (window === 'photo') return capturePhoto(workspace.getState());
  // The map registers its own source (it must repaint before reading its WebGL canvas).
  return null;
}

function bridgeSave(): RendererToolContext['saveFile'] {
  const aio = (globalThis as { aio?: AioBridge }).aio;
  if (!aio) return undefined;
  return async (defaultName, data) => {
    const r = await aio.invoke('dialog:saveFile', { defaultName, data });
    return r.error ? { path: r.path, error: r.error } : { path: r.path };
  };
}

export function defaultToolContext(window: WindowKind): RendererToolContext {
  const save = bridgeSave();
  return {
    workspace,
    window,
    scene: getActiveScene,
    fetchJson: async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as unknown;
    },
    captureFrame: defaultCapture,
    now: () => new Date(),
    ...(save ? { saveFile: save } : {}),
    app: appHooks,
  };
}
