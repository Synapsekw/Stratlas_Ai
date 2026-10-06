/**
 * A local detection run (`inference:run`): photo by photo, main decodes the image (Electron's
 * codec) and the utility process detects; results go to `detections/model-<run>.json` as draft
 * detections (`source: 'model'`, data-conventions sections 11 and 16). Progress is an event per
 * photo; cancel stops after the photo in hand and keeps the finished ones; running the same run id
 * again skips the photos its pass already assessed (resume).
 */
import type {
  Detection,
  DetectionsFile,
  DetectorModelCard,
  IpcEvent,
  IpcRequest,
  IpcResponse,
  ProjectManifest,
} from '@aio/schema';
import { createHash } from 'node:crypto';
import type { DecodedImage } from '../maskAssist';
import { layoutProblem, type NamedTensor } from './layouts';
import type { FoundModel } from './models';
import type { InferenceHost } from './utility';
import type { ProviderSetting } from './worker';

/** Largest photo side decoded for tiling (a 64 MP photo stays whole). */
export const MAX_TILED_SIDE = 8192;
/** The pass is written after this many photos, so a crash loses little. */
const SAVE_EVERY = 10;

export type RunRequest = IpcRequest<'inference:run'>;
export type RunResponse = IpcResponse<'inference:run'>;

export interface RunDeps {
  /** An open project folder and its manifest; an error for packages and closed projects. */
  project(
    projectId: string,
  ): Promise<{ root: string; manifest: ProjectManifest } | { error: string }>;
  model(id: string): Promise<FoundModel | null>;
  /** A photo of the project (relative path) decoded, scaled to at most `maxSide`. */
  decode(root: string, rel: string, maxSide: number): Promise<DecodedImage>;
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

const detectionId = (runId: string, layer: string, photo: string, k: number) =>
  `m-${createHash('sha1')
    .update(`${runId}|${layer}|${photo}|${String(k)}`)
    .digest('hex')
    .slice(0, 16)}`;

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
    if (req.items.some((i) => !('photo' in i)))
      return {
        ok: false,
        error: 'Local detection works on photos. Video frames are not supported yet: pick photos.',
      };
    const found = await deps.model(req.model);
    if (!found)
      return {
        ok: false,
        error: `There is no detector model "${req.model}". Import it in Settings, Detection models.`,
      };
    const { card } = found.info;
    const photos = req.items.flatMap((i) => ('photo' in i ? [i] : []));
    const layers = new Map(
      project.manifest.layers.flatMap((l) => (l.kind === 'photos' ? [[l.id, l] as const] : [])),
    );
    for (const it of photos) {
      const layer = layers.get(it.layer);
      if (!layer)
        return { ok: false, error: `There is no photos layer "${it.layer}" in this project.` };
      if (!layer.items.some((p) => p.id === it.photo))
        return { ok: false, error: `There is no photo "${it.photo}" in ${layer.name}.` };
    }

    const host = deps.host();
    let session: string;
    try {
      session = (await host.open(found.onnx, deps.provider())).session;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    const name = modelPassName(req.runId);
    const previous = await deps.readPass(project.root, name);
    const resumed = previous?.source === 'model' ? previous : null;
    const done = new Set(resumed && Array.isArray(resumed.assessed) ? resumed.assessed : []);
    const detections: Detection[] = [...(resumed?.detections ?? [])];
    const assessed = [...done];
    const startedAt = resumed?.run?.at ?? deps.now();
    const singleLayer =
      new Set(photos.map((p) => p.layer)).size === 1 ? photos[0]?.layer : undefined;
    const ac = new AbortController();
    active.set(req.runId, ac);
    const stopped = () => ac.signal.aborted;

    const fileNow = (): DetectionsFile => ({
      schema: 'aio.detections/1',
      source: 'model',
      producer: `${card.name} ${card.version}`,
      createdAt: resumed?.createdAt ?? startedAt,
      ...(singleLayer ? { layer: singleLayer } : {}),
      assessed: [...assessed],
      run: {
        id: req.runId,
        at: startedAt,
        model: req.model,
        images: assessed.length,
        detections: detections.length,
        costUsd: 0,
      },
      detections,
    });
    const save = async () => {
      const w = await deps.writePass(project.root, name, fileNow());
      if (!w.ok) throw new Error(w.error ?? `Could not save detections/${name}.`);
    };

    const todo = photos.filter((p) => !done.has(p.photo));
    const total = photos.length;
    let count = assessed.length;
    const report = (current?: string) => {
      deps.progress({
        runId: req.runId,
        done: count,
        total,
        found: detections.length,
        ...(current ? { current } : {}),
      });
    };
    report();
    const maxSide = req.tile ? MAX_TILED_SIDE : Math.max(card.input.width, card.input.height);
    let failure: string | null = null;
    let sinceSave = 0;
    try {
      for (const it of todo) {
        if (ac.signal.aborted) break;
        const layer = layers.get(it.layer);
        const photo = layer?.items.find((p) => p.id === it.photo);
        if (!photo) continue;
        const rel = 'path' in photo.src ? photo.src.path : `assets/sha256/${photo.src.hash}`;
        let img: DecodedImage;
        try {
          img = await deps.decode(project.root, rel, maxSide);
        } catch (e) {
          deps.log?.(`inference: ${it.photo} skipped: ${String(e)}`);
          count++;
          report(it.photo);
          continue;
        }
        if (stopped()) break;
        const boxes = await host.detect({
          session,
          image: { width: img.scaledWidth, height: img.scaledHeight, rgba: img.rgba },
          card,
          minConfidence: req.minConfidence,
          ...(req.tile ? { tile: req.tile } : {}),
          scale: img.scaledWidth / img.width,
        });
        const at = deps.now();
        boxes.forEach((b, k) => {
          const modelClass = card.classes[b.cls] ?? `class ${String(b.cls)}`;
          const mapped = req.classMap[modelClass];
          detections.push({
            id: detectionId(req.runId, it.layer, it.photo, k),
            photo: it.photo,
            class: mapped ?? modelClass,
            ...(mapped ? {} : { label: modelClass }),
            confidence: Math.round(b.score * 1000) / 1000,
            status: 'draft',
            source: 'model',
            bbox: [
              Math.max(0, b.x0),
              Math.max(0, b.y0),
              Math.min(img.width, b.x1),
              Math.min(img.height, b.y1),
            ],
            space: 'preview',
            origin: { model: req.model, runId: req.runId },
            createdAt: at,
          });
        });
        assessed.push(it.photo);
        count++;
        report(it.photo);
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
    try {
      await save();
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    report();
    if (failure)
      return {
        ok: false,
        error: `${failure} The ${String(assessed.length)} photos done are kept in detections/${name}.`,
      };
    return { ok: true, file: `detections/${name}`, count: detections.length };
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
