/**
 * A local detection run (`inference:run`): photo by photo, main decodes the image (Electron's
 * codec) and the utility process detects; results go to `detections/model-<run>.json` as draft
 * detections (`source: 'model'`, data-conventions sections 11 and 16). Progress is an event per
 * photo; cancel stops after the photo in hand and keeps the finished ones; running the same run id
 * again skips the photos its pass already assessed (resume).
 *
 * Frames of a walk layer (360 video, `{layer, t}` items) run the same way: main decodes the frame
 * of the playback copy at `t` with ffmpeg and the whole equirectangular frame goes to the model.
 * Their boxes are in source pixels of the playback copy (`space: 'source'`, `frame: {layer, t}`),
 * and the halves of an object cut by the seam at x = width are merged into one box that wraps
 * (x1 > width, `seam.ts`). A walk pass names its frames in `assessed` as `t:<milliseconds>`.
 * Frames of ordinary video layers are refused.
 *
 * An item that cannot be read (its decode fails) is `skipped`: not assessed, so a resume tries it
 * again, and counted with the first reason in progress and the result. A run where every item it
 * tried was skipped fails with that reason and writes nothing, so it never reads as a clean pass.
 * A run with walk frames opens its frame reader once before the first frame (ffmpeg looked up and
 * started once) and is refused early when frames cannot be read on this computer. Stop aborts the
 * frame decode in hand (ffmpeg is killed).
 */
import type {
  Detection,
  DetectionsFile,
  DetectorModelCard,
  IpcEvent,
  IpcRequest,
  IpcResponse,
  ProjectManifest,
  WalkFile,
} from '@aio/schema';
import { createHash } from 'node:crypto';
import type { DecodedImage } from '../maskAssist';
import { layoutProblem, type NamedTensor } from './layouts';
import type { FoundModel } from './models';
import type { ScoredBox } from './nms';
import { frameBoxes } from './seam';
import type { RgbaImage } from './tile';
import type { InferenceHost } from './utility';
import type { ProviderSetting } from './worker';

/** Largest photo side decoded for tiling (a 64 MP photo stays whole). */
export const MAX_TILED_SIDE = 8192;
/** The pass is written after this many photos, so a crash loses little. */
const SAVE_EVERY = 10;

export type RunRequest = IpcRequest<'inference:run'>;
export type RunResponse = IpcResponse<'inference:run'>;

/** Reads walk frames for one run (the env resolves its ffmpeg once, when the reader opens). */
export interface FrameReader {
  /** The frame of a project video (relative path) at `t` s, as RGBA of `width` x `height`. */
  decode(
    root: string,
    rel: string,
    t: number,
    width: number,
    height: number,
    /** The run's stop: a decode in hand ends at once. */
    signal: AbortSignal,
  ): Promise<RgbaImage>;
  /** The picture size of a project video (relative path), read from the file. */
  size(root: string, rel: string): Promise<{ width: number; height: number }>;
}

/** The longest skip reason kept (the schema allows 2000 characters). */
const REASON_MAX = 500;

export interface RunDeps {
  /** An open project folder and its manifest; an error for packages and closed projects. */
  project(
    projectId: string,
  ): Promise<{ root: string; manifest: ProjectManifest } | { error: string }>;
  model(id: string): Promise<FoundModel | null>;
  /** A photo of the project (relative path) decoded, scaled to at most `maxSide`. */
  decode(root: string, rel: string, maxSide: number): Promise<DecodedImage>;
  /**
   * The walk frame reader of one run, opened once before its first frame. Rejects with the reason
   * when frames cannot be read on this computer (ffmpeg cannot be started): the run is refused.
   */
  frames(): Promise<FrameReader>;
  /** A walk's `walk.json` (relative path), or null when it is missing or does not parse. */
  readWalk(root: string, rel: string): Promise<WalkFile | null>;
  host(): InferenceHost;
  provider(): ProviderSetting;
  readPass(root: string, name: string): Promise<DetectionsFile | null>;
  writePass(
    root: string,
    name: string,
    file: DetectionsFile,
  ): Promise<{ ok: boolean; error?: string }>;
  progress(e: IpcEvent<'inference:progress'>): void;
  now(): string;
  log?(message: string): void;
}

/** The pass file of one local model run. */
export const modelPassName = (runId: string) =>
  `model-${runId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100)}.json`;

/** `item` is the photo id, or the frame's time in whole milliseconds. */
const detectionId = (runId: string, layer: string, item: string, k: number) =>
  `m-${createHash('sha1')
    .update(`${runId}|${layer}|${item}|${String(k)}`)
    .digest('hex')
    .slice(0, 16)}`;

const frameMs = (t: number) => Math.round(t * 1000);
/** How a walk pass names a frame in `assessed`. */
export const frameKey = (t: number) => `t:${String(frameMs(t))}`;

const relOf = (src: { path: string } | { hash: string }) =>
  'path' in src ? src.path : `assets/sha256/${src.hash}`;

/** The dummy-inference layout check for import: null when the outputs fit the card. */
export function probeWith(host: () => InferenceHost) {
  return async (onnx: string, card: DetectorModelCard): Promise<string | null> => {
    const h = host();
    let opened;
    try {
      opened = await h.open(onnx, 'cpu');
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    try {
      const { width: W, height: H } = card.input;
      const dims = card.input.tensor === 'nhwc' ? [1, H, W, 3] : [1, 3, H, W];
      const out = await h.run(opened.session, {
        [opened.inputNames[0] ?? 'images']: { data: new Float32Array(3 * W * H), dims },
      });
      const outputs: NamedTensor[] = opened.outputNames.map((name) => ({
        name,
        dims: out[name]?.dims ?? [],
        data: out[name]?.data ?? [],
      }));
      return layoutProblem(card.layout, outputs, card.classes.length);
    } catch (e) {
      return `The model failed on a test image of ${String(card.input.width)} x ${String(card.input.height)}: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      await h.close(onnx).catch(() => undefined);
    }
  };
}

/** One photo or walk frame of a run. */
interface PhotoWork {
  kind: 'photo';
  layer: string;
  /** The photo id (as `assessed` names it). */
  key: string;
  rel: string;
}
interface FrameWork {
  kind: 'frame';
  layer: string;
  /** `t:<ms>` (as `assessed` names it). */
  key: string;
  t: number;
  /** The playback copy and the walk's `walk.json`. */
  rel: string;
  record: string;
}
type Work = PhotoWork | FrameWork;

/** The pass of one photos or walk layer during a run. */
interface PassState {
  name: string;
  resumed: DetectionsFile | null;
  done: Set<string>;
  assessed: string[];
  detections: Detection[];
}

export interface Runner {
  run(req: RunRequest): Promise<RunResponse>;
  cancel(runId: string): boolean;
}

export function createRunner(deps: RunDeps): Runner {
  const active = new Map<string, AbortController>();

  async function run(req: RunRequest): Promise<RunResponse> {
    if (active.has(req.runId)) return { ok: false, error: `Run ${req.runId} is already going.` };
    const project = await deps.project(req.projectId);
    if ('error' in project) return { ok: false, error: project.error };
    const found = await deps.model(req.model);
    if (!found)
      return {
        ok: false,
        error: `There is no detector model "${req.model}". Import it in Settings, Detection models.`,
      };
    const { card } = found.info;
    const layers = new Map(project.manifest.layers.map((l) => [l.id, l] as const));

    // the items as work, each once: a photo by its id, a walk frame by `t:<ms>`
    const work: Work[] = [];
    const seen = new Set<string>();
    for (const it of req.items) {
      const layer = layers.get(it.layer);
      let w: Work;
      if ('photo' in it) {
        if (layer?.kind !== 'photos')
          return { ok: false, error: `There is no photos layer "${it.layer}" in this project.` };
        const photo = layer.items.find((p) => p.id === it.photo);
        if (!photo)
          return { ok: false, error: `There is no photo "${it.photo}" in ${layer.name}.` };
        w = { kind: 'photo', layer: it.layer, key: it.photo, rel: relOf(photo.src) };
      } else {
        if (layer?.kind === 'video')
          return {
            ok: false,
            error:
              'Local detection on ordinary video clips is not supported yet: pick photos or a 360 walk.',
          };
        if (layer?.kind !== 'walk')
          return { ok: false, error: `There is no 360 walk layer "${it.layer}" in this project.` };
        if (layer.durationS > 0 && it.t > layer.durationS + 0.5)
          return {
            ok: false,
            error: `${layer.name} lasts ${String(layer.durationS)} s: there is no frame at ${String(it.t)} s.`,
          };
        w = {
          kind: 'frame',
          layer: it.layer,
          key: frameKey(it.t),
          t: it.t,
          rel: relOf(layer.src),
          record: relOf(layer.record),
        };
      }
      const id = `${w.layer}|${w.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      work.push(w);
    }

    // walk frames: ffmpeg looked up and started once, before anything runs
    let reader: FrameReader | null = null;
    if (work.some((w) => w.kind === 'frame'))
      try {
        reader = await deps.frames();
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }

    const host = deps.host();
    let session: string;
    try {
      session = (await host.open(found.onnx, deps.provider())).session;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    // One pass per layer: a pass names its photos by the file's `layer`, and photo ids repeat
    // across layers (each date of a two-date project has its own p01, p02, ...).
    const layerIds = [...new Set(work.map((p) => p.layer))];
    const several = layerIds.length > 1;
    const passes = new Map(
      await Promise.all(
        layerIds.map(async (layer) => {
          const name = modelPassName(several ? `${req.runId}-${layer}` : req.runId);
          const previous = await deps.readPass(project.root, name);
          const resumed = previous?.source === 'model' ? previous : null;
          const done = new Set(resumed && Array.isArray(resumed.assessed) ? resumed.assessed : []);
          const detections: Detection[] = [...(resumed?.detections ?? [])];
          const assessed: string[] = [...done];
          return [layer, { name, resumed, done, assessed, detections }] as [string, PassState];
        }),
      ),
    );
    const all = [...passes.values()];
    const startedAt = all.find((p) => p.resumed?.run?.at)?.resumed?.run?.at ?? deps.now();
    const ac = new AbortController();
    active.set(req.runId, ac);
    const stopped = () => ac.signal.aborted;

    const fileOf = (layer: string, p: (typeof all)[number]): DetectionsFile => ({
      schema: 'aio.detections/1',
      source: 'model',
      producer: `${card.name} ${card.version}`,
      createdAt: p.resumed?.createdAt ?? startedAt,
      layer,
      assessed: [...p.assessed],
      run: {
        id: req.runId,
        at: startedAt,
        model: req.model,
        images: p.assessed.length,
        detections: p.detections.length,
        costUsd: 0,
      },
      detections: p.detections,
    });
    // a layer's pass is written once one of its items is done (a run of one layer always)
    const written = () => [...passes].filter(([, p]) => !several || p.assessed.length > 0);
    const save = async () => {
      for (const [layer, p] of written()) {
        const w = await deps.writePass(project.root, p.name, fileOf(layer, p));
        if (!w.ok) throw new Error(w.error ?? `Could not save detections/${p.name}.`);
      }
    };
    const foundCount = () => all.reduce((n, p) => n + p.detections.length, 0);

    const todo = work.filter((w) => !passes.get(w.layer)?.done.has(w.key));
    const total = work.length;
    let count = all.reduce((n, p) => n + p.assessed.length, 0);
    // items of this run that could not be read, and why the first one could not
    let skipped = 0;
    let reason: string | undefined;
    let assessedNow = 0;
    const skips = () => (skipped > 0 ? { skipped, ...(reason ? { reason } : {}) } : {});
    const report = (current?: string) => {
      deps.progress({
        runId: req.runId,
        done: count,
        total,
        found: foundCount(),
        ...(current ? { current } : {}),
        ...skips(),
      });
    };
    report();
    const maxSide = req.tile ? MAX_TILED_SIDE : Math.max(card.input.width, card.input.height);
    // the source size of each walk's playback copy: walk.json, else the file itself
    const sizes = new Map<string, Promise<{ width: number; height: number }>>();
    const sourceSize = (w: FrameWork) => {
      let p = sizes.get(w.layer);
      if (!p) {
        const size = () => {
          if (!reader) throw new Error('No frame reader for this run.');
          return reader.size(project.root, w.rel);
        };
        p = deps.readWalk(project.root, w.record).then((f) => f?.video ?? size(), size);
        sizes.set(w.layer, p);
      }
      return p;
    };

    /** Decoded pixels and their source size, or why the item cannot be read (skipped). */
    const decodeItem = async (
      w: Work,
    ): Promise<{ img: RgbaImage; width: number; height: number } | { error: string }> => {
      try {
        if (w.kind === 'photo') {
          const d = await deps.decode(project.root, w.rel, maxSide);
          return {
            img: { width: d.scaledWidth, height: d.scaledHeight, rgba: d.rgba },
            width: d.width,
            height: d.height,
          };
        }
        const src = await sourceSize(w);
        // the photo path's pre-scale: the longer side at most maxSide
        const s = Math.min(1, maxSide / Math.max(src.width, src.height));
        const dw = Math.max(1, Math.round(src.width * s));
        const dh = Math.max(1, Math.round(src.height * s));
        if (!reader) throw new Error('No frame reader for this run.');
        const img = await reader.decode(project.root, w.rel, w.t, dw, dh, ac.signal);
        return { img, width: src.width, height: src.height };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        deps.log?.(`inference: ${w.layer} ${w.key} skipped: ${error}`);
        return { error };
      }
    };

    let failure: string | null = null;
    let sinceSave = 0;
    try {
      for (const w of todo) {
        if (ac.signal.aborted) break;
        const pass = passes.get(w.layer);
        if (!pass) continue;
        const got = await decodeItem(w);
        // a decode the stop cut short is not a frame that could not be read
        if (stopped()) break;
        if ('error' in got) {
          skipped++;
          reason ??= got.error.slice(0, REASON_MAX);
          count++;
          report(w.key);
          continue;
        }
        const { img, width, height } = got;
        const frame = w.kind === 'frame';
        const scale = img.width / width;
        let boxes: ScoredBox[] = await host.detect({
          session,
          image: img,
          card,
          minConfidence: req.minConfidence,
          ...(req.tile ? { tile: req.tile } : {}),
          scale,
          ...(frame ? { wrap: true } : {}),
        });
        // folded back into the frame, and the halves of an object the seam cut become one box
        // that wraps (x1 > width); the edge margin is in decoded pixels, so it grows with the
        // scale-down
        if (frame) boxes = frameBoxes(boxes, width, scale);
        const at = deps.now();
        boxes.forEach((b, k) => {
          const modelClass = card.classes[b.cls] ?? `class ${String(b.cls)}`;
          const mapped = req.classMap[modelClass];
          const common = {
            class: mapped ?? modelClass,
            ...(mapped ? {} : { label: modelClass }),
            confidence: Math.round(b.score * 1000) / 1000,
            status: 'draft' as const,
            source: 'model' as const,
            origin: { model: req.model, runId: req.runId },
            createdAt: at,
          };
          if (w.kind === 'frame') {
            const x0 = Math.max(0, b.x0);
            pass.detections.push({
              id: detectionId(req.runId, w.layer, String(frameMs(w.t)), k),
              frame: { layer: w.layer, t: w.t },
              ...common,
              // a box across the seam keeps x1 > width; it never wraps more than once
              bbox: [x0, Math.max(0, b.y0), Math.min(x0 + width, b.x1), Math.min(height, b.y1)],
              space: 'source',
              width,
              height,
            });
          } else
            pass.detections.push({
              id: detectionId(req.runId, w.layer, w.key, k),
              photo: w.key,
              ...common,
              bbox: [
                Math.max(0, b.x0),
                Math.max(0, b.y0),
                Math.min(width, b.x1),
                Math.min(height, b.y1),
              ],
              space: 'preview',
            });
        });
        pass.assessed.push(w.key);
        assessedNow++;
        count++;
        report(w.key);
        if (++sinceSave >= SAVE_EVERY) {
          sinceSave = 0;
          await save();
        }
      }
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    } finally {
      active.delete(req.runId);
    }
    const what = work.every((w) => w.kind === 'photo')
      ? 'photos'
      : work.every((w) => w.kind === 'frame')
        ? 'frames'
        : 'photos and frames';
    // every item tried could not be read: an error, never an empty pass that looks clean
    if (!failure && skipped > 0 && assessedNow === 0) {
      report();
      return {
        ok: false,
        error: `${
          skipped === 1
            ? `The ${what === 'photos' ? 'photo' : what === 'frames' ? 'frame' : 'item'}`
            : `None of the ${String(skipped)} ${what}`
        } could be read: ${reason ?? 'no reason given'}`,
      };
    }
    try {
      await save();
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    report();
    const files = written().map(([, p]) => `detections/${p.name}`);
    if (failure) {
      return {
        ok: false,
        error: `${failure} The ${String(all.reduce((n, p) => n + p.assessed.length, 0))} ${what} done are kept in ${files.join(', ')}.`,
      };
    }
    // the first pass written (a run over several layers writes one per layer)
    return {
      ok: true,
      file: files[0] ?? `detections/${all[0]?.name ?? ''}`,
      count: foundCount(),
      ...skips(),
    };
  }

  return {
    run,
    cancel(runId) {
      const ac = active.get(runId);
      ac?.abort();
      return ac !== undefined;
    },
  };
}
