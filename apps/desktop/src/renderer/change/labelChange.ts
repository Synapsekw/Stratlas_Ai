/**
 * **Label with AI** on a change region (V4 change labels): a crop of the region on each date's
 * ortho, the same window on both (each date read where it is drawn, its line-up shift applied),
 * the region outlined in yellow, sent through the Compare route (`ai:ask`, kind `change`); the
 * answer becomes the region's `aiLabel` (kind, what, model, time), saved with the set. The label
 * is a suggestion: the verdict and the review are not touched.
 *
 * Which AI answers is decided as for any custom ask (`routeAsk`, Auto): the cloud's strong model
 * when it is usable and the project keeps nothing local, else this PC's model. A project that
 * forbids the cloud (`aiPolicy`) is answered locally.
 */
import { changeLabelAsk, readChangeLabel, routeAsk, type AskRoute, type UnitBox } from '@aio/ai';
import { changeStore, type ChangePairContext, type RegisterRow } from '@aio/change';
import type { ChangeAiLabel, ChangeItem, ChangeSet, IpcResponse, Layer, Vec3 } from '@aio/schema';
import { t } from '@aio/ui';
import { assetUrl, dateShiftOf, workspace } from '@aio/workspace';
import { bridge } from '../shell';
import {
  browserCropIo,
  composeCrop,
  CROP_FORMATS,
  type CropIo,
  type CropWindow,
  type RasterLayer,
} from '../survey/orthoCrop';

/** Crop size sent, pixels a side (below both send limits). */
export const LABEL_CROP_PX = 1024;
/** The crop is the region grown by this factor, at least `LABEL_MIN_SIDE_M` a side. */
export const LABEL_PAD = 1.5;
export const LABEL_MIN_SIDE_M = 10;

type RegionItem = Extract<ChangeItem, { kind: 'region' }>;

/** The region's extent in the local frame (x east, z south): its bounds, outline or point. */
export function regionExtent(
  item: RegionItem,
): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
  if (item.bounds) {
    const { min, max } = item.bounds;
    return { minX: min[0], maxX: max[0], minZ: min[2], maxZ: max[2] };
  }
  const pts = item.outlineLocal;
  if (pts && pts.length > 0) {
    const xs = pts.map((p) => p[0]);
    const zs = pts.map((p) => p[2]);
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minZ: Math.min(...zs),
      maxZ: Math.max(...zs),
    };
  }
  if (item.at) return { minX: item.at[0], maxX: item.at[0], minZ: item.at[2], maxZ: item.at[2] };
  return null;
}

/**
 * The crop window (project CRS, north up) around the region and where the region falls in it
 * (`mark`, 0 to 1, x right, y down). Null when the region has no position.
 */
export function labelWindow(
  item: RegionItem,
  origin: Vec3,
  size = LABEL_CROP_PX,
): { window: CropWindow; mark: UnitBox } | null {
  const e = regionExtent(item);
  if (!e) return null;
  const side = Math.max(LABEL_MIN_SIDE_M, LABEL_PAD * Math.max(e.maxX - e.minX, e.maxZ - e.minZ));
  const cE = origin[0] + (e.minX + e.maxX) / 2;
  const cN = origin[1] - (e.minZ + e.maxZ) / 2;
  const window: CropWindow = { x0: cE - side / 2, y1: cN + side / 2, res: side / size, size };
  const u = (x: number) => (origin[0] + x - window.x0) / side;
  const v = (z: number) => (window.y1 - (origin[1] - z)) / side;
  return { window, mark: [u(e.minX), v(e.minZ), u(e.maxX), v(e.maxZ)] };
}

/** The region's outline in crop pixels: its local outline, else its bounds as a rectangle. */
export function outlinePixels(
  item: RegionItem,
  window: CropWindow,
  origin: Vec3,
): [number, number][] {
  const px = (x: number, z: number): [number, number] => [
    (origin[0] + x - window.x0) / window.res,
    (window.y1 - (origin[1] - z)) / window.res,
  ];
  if (item.outlineLocal && item.outlineLocal.length >= 3)
    return item.outlineLocal.map((p) => px(p[0], p[2]));
  const e = regionExtent(item);
  if (!e || (e.minX === e.maxX && e.minZ === e.maxZ)) return [];
  return [px(e.minX, e.minZ), px(e.maxX, e.minZ), px(e.maxX, e.maxZ), px(e.minX, e.maxZ)];
}

const own = (mine: readonly Layer[], other: readonly Layer[]) => {
  const theirs = new Set(other.map((l) => l.id));
  return mine.filter((l) => !theirs.has(l.id) && !l.derived);
};
const isCropOrtho = (l: Layer): l is RasterLayer =>
  l.kind === 'raster' && l.role === 'ortho' && CROP_FORMATS.includes(l.format);

/** The ortho of each date the crops are read from: the first one of each date's own layers. */
export function labelOrthos(
  ctx: Pick<ChangePairContext, 'layersFrom' | 'layersTo'>,
): { from: RasterLayer; to: RasterLayer } | null {
  const from = own(ctx.layersFrom, ctx.layersTo).find(isCropOrtho);
  const to = own(ctx.layersTo, ctx.layersFrom).find(isCropOrtho);
  return from && to ? { from, to } : null;
}

/** Which AI answers a change label, as for any custom change ask on Auto; null when none can. */
export function labelRoute(status: IpcResponse<'ai:askStatus'> | null): AskRoute | null {
  if (!status) return null;
  const routed = routeAsk({
    kind: 'change',
    scope: 'dates',
    choice: 'auto',
    cloud: {
      usable: status.cloud.usable && !status.keepLocal,
      providers: status.cloud.providers,
    },
    local: { ready: status.local.ready },
  });
  return 'route' in routed ? routed.route : null;
}

/** Why a row cannot be labelled now; null when it can. */
export function labelUnavailable(
  item: ChangeItem,
  ctx: Pick<ChangePairContext, 'layersFrom' | 'layersTo'> | null,
  status: IpcResponse<'ai:askStatus'> | null,
  origin: Vec3 | null,
): string | null {
  if (item.kind !== 'region') return null;
  if (!ctx || !origin) return t('change.aiLabel.noProject');
  if (!labelWindow(item, origin)) return t('change.aiLabel.noPlace');
  if (!labelOrthos(ctx)) return t('change.aiLabel.noOrtho');
  if (!labelRoute(status)) return t('change.aiLabel.noAi');
  return null;
}

/** The set with `label` on one item (`null` clears it). */
export function withAiLabel(
  set: ChangeSet,
  itemId: string,
  label: ChangeAiLabel | null,
): ChangeSet {
  if (!set.items.some((i) => i.id === itemId && i.kind === 'region'))
    throw new Error(`The change set ${set.id} has no region "${itemId}".`);
  return {
    ...set,
    items: set.items.map((i) => {
      if (i.id !== itemId || i.kind !== 'region') return i;
      if (label) return { ...i, aiLabel: label };
      const rest = { ...i };
      delete rest.aiLabel;
      return rest;
    }),
  };
}

/** What making the crops and sending them needs from the page (tests stand in for it). */
export interface LabelIo {
  crop: CropIo;
  /** The crop as a JPEG data URL with the outline drawn on it. */
  encode(rgb: Uint8Array, size: number, outline: readonly [number, number][]): Promise<string>;
  ask(req: ReturnType<typeof changeLabelAsk>): Promise<IpcResponse<'ai:ask'>>;
  status(projectId: string): Promise<IpcResponse<'ai:askStatus'> | null>;
  now(): string;
  runId(): string;
}

/**
 * Label one region row and save the label; an error sentence, or null when it is saved.
 * `dates` names each capture as the panel does (said to the model with its image).
 */
export async function labelRegion(i: {
  row: RegisterRow;
  ctx: ChangePairContext;
  dates: { from: string; to: string };
  io?: LabelIo;
}): Promise<string | null> {
  const { row, ctx } = i;
  const item = row.item;
  if (item.kind !== 'region') return null;
  const io = i.io ?? browserLabelIo(ctx.projectId);
  const origin = ctx.manifest.origin;
  const placed = labelWindow(item, origin);
  if (!placed) return t('change.aiLabel.noPlace');
  const orthos = labelOrthos(ctx);
  if (!orthos) return t('change.aiLabel.noOrtho');
  const route = labelRoute(await io.status(ctx.projectId));
  if (!route) return t('change.aiLabel.noAi');
  const outline = outlinePixels(item, placed.window, origin);
  const image = async (layer: RasterLayer, key: string, label: string) => {
    const crop = await composeCrop(
      layer,
      placed.window,
      origin,
      io.crop,
      dateShiftOf(ctx.manifest, layer.id),
    );
    if (!crop.ok) throw new Error(crop.error);
    return {
      key,
      dataUrl: await io.encode(crop.rgb, placed.window.size, outline),
      width: placed.window.size,
      height: placed.window.size,
      label: label.slice(0, 80),
    };
  };
  let answer: IpcResponse<'ai:ask'>;
  try {
    const [before, after] = await Promise.all([
      image(orthos.from, `${orthos.from.id}#${item.id}`, i.dates.from),
      image(orthos.to, `${orthos.to.id}#${item.id}`, i.dates.to),
    ]);
    answer = await io.ask(
      changeLabelAsk({
        runId: io.runId(),
        projectId: ctx.projectId,
        backend: route,
        before,
        after,
        region: { areaM2: item.areaM2 },
      }),
    );
  } catch (e) {
    return t('change.aiLabel.failed', { error: e instanceof Error ? e.message : String(e) });
  }
  const read = readChangeLabel(answer, placed.mark);
  if (!read) return t('change.aiLabel.failed', { error: answer.ok ? '' : answer.error });
  const store = changeStore.getState();
  const set = store.sets[row.setId];
  if (!set) return t('change.aiLabel.failed', { error: `no change set ${row.setId}` });
  const saved = await store.save(withAiLabel(set, item.id, { ...read, at: io.now() }));
  return saved ? null : (changeStore.getState().error ?? t('change.aiLabel.failed', { error: '' }));
}

const YELLOW = 'rgb(255 214 10)';

/** Encode RGB bytes as a JPEG data URL, the outline drawn over them. */
async function encodeJpeg(
  rgb: Uint8Array,
  size: number,
  outline: readonly [number, number][],
): Promise<string> {
  const c = new OffscreenCanvas(size, size);
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas');
  const img = ctx.createImageData(size, size);
  for (let p = 0, q = 0; p < rgb.length; p += 3, q += 4) {
    img.data[q] = rgb[p] ?? 0;
    img.data[q + 1] = rgb[p + 1] ?? 0;
    img.data[q + 2] = rgb[p + 2] ?? 0;
    img.data[q + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  if (outline.length >= 3) {
    ctx.strokeStyle = YELLOW;
    ctx.lineWidth = Math.max(2, Math.round(size / 256));
    ctx.beginPath();
    outline.forEach(([x, y], n) => {
      if (n === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
  }
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let n = 0; n < bytes.length; n += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(n, n + 0x8000));
  return `data:image/jpeg;base64,${btoa(bin)}`;
}

/** The page's crops, encoder and bridge. */
export function browserLabelIo(projectId: string): LabelIo {
  return {
    crop: browserCropIo((ref) => assetUrl(projectId, ref)),
    encode: encodeJpeg,
    async ask(req) {
      const r = await bridge.call('ai:ask', req);
      return r.ok ? r.value : { ok: false, error: r.error };
    },
    async status(id) {
      const r = await bridge.call('ai:askStatus', { projectId: id });
      return r.ok ? r.value : null;
    },
    now: () => new Date().toISOString(),
    runId: () => `chg-label-${globalThis.crypto.randomUUID()}`,
  };
}

/** The open project's manifest origin, or null. */
export const projectOrigin = (): Vec3 | null =>
  workspace.getState().project?.manifest.origin ?? null;
