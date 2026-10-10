/**
 * **Suggest boundaries** (M11 G12, ADR 0011, SAI-1): while a polygon is drawn, a click on the
 * ortho asks the local model in the pipeline pack for the outline of what is under it. The
 * outline is the drawing's points, a draft: Buffer (keys U and I) grows or shrinks it, Vertices
 * (keys J and K) thins it, and it becomes a polygon only when accepted (Finish, Enter or a double
 * click), like any drawing. Without the pack or its model the button says what is needed.
 *
 * The crop the model sees is made from the ortho layer's own image or tiles (`orthoCrop.ts`), 60
 * m around the click, grown up to three times when the outline reaches its edge.
 */
import type { IpcResponse, ProjectManifest, SitePoint } from '@aio/schema';
import type { DrawEnv, DrawEvent } from '@aio/survey';
import { assetUrl, useWorkspace, workspace } from '@aio/workspace';
import { useEffect } from 'react';
import { createStore, useStore } from 'zustand';
import { bridge } from '../shell';
import { measureStore, setDrawInterceptor } from './measureStore';
import type { Outline } from './snapRegions';
import {
  browserCropIo,
  composeCrop,
  covers,
  CROP_FORMATS,
  cropKey,
  cropWindow,
  layerCorners,
  type Corners,
  type CropIo,
  type CropWindow,
  type RasterLayer,
} from './orthoCrop';

type Status = IpcResponse<'surveyAi:status'>;

/** Crop sides tried in turn while the outline reaches the crop's edge, metres. */
export const CROP_SIDES_M = [60, 120, 240, 480] as const;
const BUFFER_STEP = 2;
const BUFFER_MAX = 50;

export interface MagicState {
  on: boolean;
  status: Status | null;
  busy: boolean;
  /** The last request, kept for buffer and vertex changes. */
  last: { layer: RasterLayer; click: SitePoint; window: CropWindow; key: string } | null;
  score: number | null;
  touchesEdge: boolean;
  /** Vertex count of the full outline, before thinning. */
  fullVertices: number | null;
  bufferPx: number;
  /** Target vertex count; null keeps every corner of the outline. */
  vertices: number | null;
  message: string | null;
}

const initial: MagicState = {
  on: false,
  status: null,
  busy: false,
  last: null,
  score: null,
  touchesEdge: false,
  fullVertices: null,
  bufferPx: 0,
  vertices: null,
  message: null,
};

export const magicStore = createStore<MagicState>()(() => initial);
export const useMagic = <T,>(f: (s: MagicState) => T): T => useStore(magicStore, f);
const set = (p: Partial<MagicState>) => {
  magicStore.setState(p);
};
const get = () => magicStore.getState();

/** What a person reads when Suggest boundaries cannot run. */
export function unavailableText(s: Status): string {
  switch (s.reason) {
    case 'no-pack':
      return 'Suggest boundaries needs the pipeline pack. Add it on the Jobs page (Check the pipeline pack), then try again.';
    case 'no-model':
      return 'This pipeline pack has no boundary model. Update the pipeline pack to use Suggest boundaries.';
    case 'no-runtime':
      return 'The ONNX runtime is not installed, so Suggest boundaries cannot run.';
    case 'licence':
      return `The boundary model in the pipeline pack has a licence this app does not accept. ${s.detail ?? ''}`.trim();
    default:
      return `The boundary model could not be loaded. ${s.detail ?? ''}`.trim();
  }
}

/** Turn Suggest boundaries on (after checking the model is there) or off. */
export async function toggleMagic(): Promise<void> {
  if (get().on) {
    set({ ...initial, status: get().status });
    return;
  }
  const r = await bridge.call('surveyAi:status', {});
  const status: Status = r.ok ? r.value : { available: false, reason: 'failed', detail: r.error };
  if (!status.available) {
    set({ on: false, status, message: unavailableText(status) });
    return;
  }
  set({ on: true, status, message: 'Click an object on the ortho to outline it.' });
}

/** Stop and forget the draft (the drawing ended). */
export function resetMagic(): void {
  set({ ...initial, status: get().status });
}

// ---------------------------------------------------------------- picking the ortho

const cornersCache = new Map<string, Corners | null>();

/**
 * The ortho under a click: the visible ortho layers the crop can read, the one drawn on top
 * first (later in the manifest), that covers the point.
 */
export async function orthoAt(
  manifest: Pick<ProjectManifest, 'layers' | 'origin'>,
  hidden: Readonly<Record<string, true>>,
  at: readonly [number, number],
  io: CropIo,
): Promise<RasterLayer | null> {
  const orthos = manifest.layers
    .filter(
      (l): l is RasterLayer =>
        l.kind === 'raster' &&
        l.role === 'ortho' &&
        CROP_FORMATS.includes(l.format) &&
        !hidden[l.id],
    )
    .reverse();
  for (const l of orthos) {
    const key = `${l.id}:${JSON.stringify(l.src)}`;
    if (!cornersCache.has(key)) {
      cornersCache.set(key, await layerCorners(l, io).catch(() => null));
    }
    const c = cornersCache.get(key);
    if (c && covers(c, at, manifest.origin)) return l;
  }
  return null;
}

// ---------------------------------------------------------------- asking the model

let seq = 0;
/** The drawing's environment at the last click (terrain heights for the draft's points). */
let lastEnv: DrawEnv = {};

/** Ask for the outline at the last request (or a new click) and put it into the drawing. */
async function suggest(
  req: { layer: RasterLayer; click: SitePoint; side: number } | null,
  env: DrawEnv,
): Promise<void> {
  const ws = workspace.getState();
  const project = ws.project;
  if (!project) return;
  const io = browserCropIo((ref) => assetUrl(project.id, ref));
  const mine = ++seq;
  const s = get();
  const target = req
    ? {
        layer: req.layer,
        click: req.click,
        window: cropWindow([req.click[0], req.click[1]], req.side),
      }
    : s.last;
  if (!target) return;
  set({ busy: true, message: req ? 'Finding the outline...' : null });
  const key = cropKey(target.layer.id, target.window);
  const ask = async (withPixels: boolean) => {
    let rgb: Uint8Array<ArrayBuffer> | undefined;
    if (withPixels) {
      const crop = await composeCrop(target.layer, target.window, project.manifest.origin, io);
      if (!crop.ok) return { ok: false as const, error: crop.error };
      rgb = crop.rgb;
    }
    const res = await bridge.call('surveyAi:suggest', {
      projectId: project.id,
      layer: target.layer.id,
      click: [target.click[0], target.click[1]],
      crop: { key, ...target.window, ...(rgb ? { rgb } : {}) },
      ...(get().bufferPx ? { bufferPx: get().bufferPx } : {}),
      ...(get().vertices ? { vertices: get().vertices ?? undefined } : {}),
    });
    return res.ok ? res.value : { ok: false as const, error: res.error };
  };
  let r = await ask(req !== null);
  if (!r.ok && 'code' in r && r.code === 'stale') r = await ask(true);
  if (mine !== seq) return;
  if (!r.ok) {
    set({ busy: false, message: r.error });
    return;
  }
  // grow the crop while the outline reaches its edge
  const side = target.window.res * target.window.size;
  const next = CROP_SIDES_M.find((m) => m > side + 1e-6);
  if (req && r.touchesEdge && next !== undefined) {
    await suggest({ ...req, side: next }, env);
    return;
  }
  const z = target.click[2];
  const points: SitePoint[] = r.ring.map(([e, n]) => [e, n, env.clampZ?.(e, n) ?? z]);
  const m = measureStore.getState();
  if (!m.draw) {
    set({ busy: false });
    return;
  }
  measureStore.setState({ draw: { ...m.draw, points, cursor: null, snap: null } });
  set({
    busy: false,
    last: { ...target, key },
    score: r.score,
    touchesEdge: r.touchesEdge,
    fullVertices: get().vertices ? get().fullVertices : r.ring.length,
    message: r.touchesEdge
      ? 'The outline reaches the edge of the area the model sees. Accept it, or click closer to the middle of the object.'
      : null,
  });
}

/** A click while Suggest boundaries is on: the outline of what is under it. */
export function magicClick(click: SitePoint, env: DrawEnv): void {
  lastEnv = env;
  const ws = workspace.getState();
  const project = ws.project;
  if (!project) return;
  const io = browserCropIo((ref) => assetUrl(project.id, ref));
  set({
    busy: true,
    message: 'Finding the outline...',
    bufferPx: 0,
    vertices: null,
    fullVertices: null,
  });
  void orthoAt(project.manifest, ws.hidden, [click[0], click[1]], io).then((layer) => {
    if (!layer) {
      set({
        busy: false,
        message: 'No ortho is shown here. Show an ortho layer of this survey, then click again.',
      });
      return;
    }
    return suggest({ layer, click, side: CROP_SIDES_M[0] }, env);
  });
}

/** Grow or shrink the draft (pixels of the crop; keys U and I). */
export function setBuffer(px: number, env: DrawEnv = lastEnv): void {
  set({ bufferPx: Math.max(-BUFFER_MAX, Math.min(BUFFER_MAX, Math.round(px))) });
  if (get().last) void suggest(null, env);
}

/** Thin the draft to `n` vertices, or keep them all with null (keys J and K). */
export function setVertices(n: number | null, env: DrawEnv = lastEnv): void {
  set({ vertices: n === null ? null : Math.max(4, Math.min(500, Math.round(n))) });
  if (get().last) void suggest(null, env);
}

/** The keys of the draft: U and I buffer, J and K vertices. True when used. */
export function magicKey(key: string, env: DrawEnv = lastEnv): boolean {
  const s = get();
  if (!s.on || !s.last) return false;
  const k = key.toLowerCase();
  if (k === 'u') setBuffer(s.bufferPx - BUFFER_STEP, env);
  else if (k === 'i') setBuffer(s.bufferPx + BUFFER_STEP, env);
  else if (k === 'j') setVertices((s.vertices ?? s.fullVertices ?? 40) * 0.8, env);
  else if (k === 'k') {
    const more = (s.vertices ?? s.fullVertices ?? 40) * 1.25;
    setVertices(s.fullVertices !== null && more >= s.fullVertices ? null : more, env);
  } else return false;
  return true;
}

/** Take polygon clicks (and keep the rubber band away) while Suggest boundaries is on. */
function intercept(e: DrawEvent, env: DrawEnv): boolean {
  const s = get();
  const m = measureStore.getState();
  if (!s.on || m.draw?.family !== 'polygon') return false;
  if (e.type === 'click') {
    magicClick(e.raw, env);
    return true;
  }
  if (e.type === 'move' || e.type === 'stroke') return s.last !== null || s.busy;
  return false;
}

// ---------------------------------------------------------------- outlines for other tools

/** Whether the boundary model can run, as `surveyAi:status` answers. */
export async function magicStatus(): Promise<Status> {
  const r = await bridge.call('surveyAi:status', {});
  return r.ok ? r.value : { available: false, reason: 'failed', detail: r.error };
}

/**
 * Asks the model for the outline at a point of the open project's ortho within a given crop (the
 * AI cut and fill breakdown snaps its regions with it, `snapRegions.ts`). Null with no project.
 */
export function projectOutline(): Outline | null {
  const ws = workspace.getState();
  const project = ws.project;
  if (!project) return null;
  const io = browserCropIo((ref) => assetUrl(project.id, ref));
  return async (click, window) => {
    const layer = await orthoAt(project.manifest, ws.hidden, click, io);
    if (!layer) return { ok: false, error: 'No ortho is shown here.' };
    const crop = await composeCrop(layer, window, project.manifest.origin, io);
    if (!crop.ok) return crop;
    const res = await bridge.call('surveyAi:suggest', {
      projectId: project.id,
      layer: layer.id,
      click,
      crop: { key: cropKey(layer.id, window), ...window, rgb: crop.rgb },
    });
    if (!res.ok) return { ok: false, error: res.error };
    return res.value.ok
      ? { ok: true, ring: res.value.ring, touchesEdge: res.value.touchesEdge }
      : { ok: false, error: res.value.error };
  };
}

// ---------------------------------------------------------------- the panel

/** The Suggest boundaries button and, while it is on, its draft controls (in the drawing bar). */
export function MagicPolygon() {
  const on = useMagic((s) => s.on);
  const busy = useMagic((s) => s.busy);
  const message = useMagic((s) => s.message);
  const score = useMagic((s) => s.score);
  const bufferPx = useMagic((s) => s.bufferPx);
  const vertices = useMagic((s) => s.vertices);
  const fullVertices = useMagic((s) => s.fullVertices);
  const hasDraft = useMagic((s) => s.last !== null);
  const status = useMagic((s) => s.status);
  useWorkspace((s) => s.project?.id);

  useEffect(() => {
    setDrawInterceptor(intercept);
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      )
        return;
      if (magicKey(e.key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    // a finished or cancelled drawing ends the draft
    const off = measureStore.subscribe((s, prev) => {
      if (s.draw !== prev.draw && (!s.draw || s.draw.points.length === 0) && get().last) {
        set({
          last: null,
          score: null,
          touchesEdge: false,
          fullVertices: null,
          bufferPx: 0,
          vertices: null,
        });
      }
      if (!s.draw && get().on) resetMagic();
    });
    return () => {
      setDrawInterceptor(null);
      window.removeEventListener('keydown', onKey, { capture: true });
      off();
    };
  }, []);

  return (
    <>
      <button
        type="button"
        className={`btn sm${on ? ' primary' : ''}`}
        aria-pressed={on}
        data-testid="survey-magic"
        title="Click an object on the ortho for a draft outline from the local model (U and I buffer, J and K vertices)"
        onClick={() => {
          void toggleMagic();
        }}
      >
        Suggest boundaries
      </button>
      {(on || message) && (
        <div className="sv-magic" role="group" aria-label="Suggest boundaries" data-surface="dark">
          {message && (
            <span
              className={`small${status && !status.available ? ' warn' : ''}`}
              role="status"
              data-testid="survey-magic-status"
            >
              {message}
            </span>
          )}
          {busy && !message && (
            <span className="small" role="status" data-testid="survey-magic-status">
              Finding the outline...
            </span>
          )}
          {on && hasDraft && (
            <>
              {score !== null && (
                <span className="faint small" data-testid="survey-magic-score">
                  Draft, model confidence {Math.round(score * 100)}%
                </span>
              )}
              <label className="small sv-magic-range">
                Buffer (U, I)
                <input
                  type="range"
                  min={-BUFFER_MAX}
                  max={BUFFER_MAX}
                  step={1}
                  value={bufferPx}
                  data-testid="survey-magic-buffer"
                  onChange={(e) => {
                    setBuffer(Number(e.target.value));
                  }}
                />
                <span className="mono">
                  {bufferPx > 0 ? `+${String(bufferPx)}` : String(bufferPx)} px
                </span>
              </label>
              <label className="small sv-magic-range">
                Vertices (J, K)
                <input
                  type="range"
                  min={4}
                  max={Math.max(5, fullVertices ?? 200)}
                  step={1}
                  value={vertices ?? fullVertices ?? 200}
                  data-testid="survey-magic-vertices"
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setVertices(fullVertices !== null && n >= fullVertices ? null : n);
                  }}
                />
                <span className="mono">{vertices ?? fullVertices ?? '...'}</span>
              </label>
              <span className="faint small">Finish or Enter accepts the draft.</span>
            </>
          )}
        </div>
      )}
    </>
  );
}

export const magicTest = { intercept, orthoCornersCache: cornersCache };
