/**
 * Review decisions into the local detector ledger (`ledger:append`): an accepted or rejected
 * candidate of a local vision-model detector, and a finding a person drew by hand that a detector
 * of the same class should have found (a miss). The ledger only ever suggests a better threshold,
 * so a failure here is logged and never reaches the review.
 */
import { boundsOf, type Detection } from '@aio/annotate/detections';
import type { DetectionsFile, LedgerEntry } from '@aio/schema';
import { bridge } from '../../shell';
import { cropJpeg } from './crop';

/** Where the decision was made, and the URL of the photo the review shows (null when unknown). */
export interface LedgerCtx {
  projectId: string;
  layer: string;
  photoUrl: string | null;
}

/** One local-detector pass (`vlm-*`): the photos it looked at and the detectors that ran in it. */
export interface MissPass {
  name: string;
  assessed: readonly string[];
  detectors: readonly { id: string; version: number; modelSha256: string; classId: string }[];
}

/**
 * The local-detector passes among `list`'s passes. A pass lists the detectors its run asked about
 * in its header (`detectors`, even those that found nothing); an older pass has none, so the
 * detectors of its candidates stand in. Each listed detector carries the model's hash.
 */
export function missPassesFrom(
  list: readonly Detection[],
  headers: ReadonlyMap<string, Pick<DetectionsFile, 'assessed' | 'detectors'>>,
): MissPass[] {
  const out: MissPass[] = [];
  const names = new Set([...headers.keys(), ...list.map((d) => d.pass)]);
  for (const name of names) {
    if (!name.startsWith('vlm-')) continue;
    const header = headers.get(name) ?? {};
    const mine = list.flatMap((d) =>
      d.pass === name && d.origin.kind === 'model' && d.origin.detector ? [d] : [],
    );
    const detectors: MissPass['detectors'][number][] = [];
    for (const h of header.detectors ?? [])
      detectors.push({
        id: h.id,
        version: h.version,
        modelSha256: h.modelSha256,
        classId: h.classId,
      });
    for (const d of mine) {
      const det = d.origin.kind === 'model' ? d.origin.detector : undefined;
      if (det && !detectors.some((x) => x.id === det.id))
        detectors.push({
          id: det.id,
          version: det.version,
          modelSha256: det.modelSha256,
          classId: d.classId,
        });
    }
    out.push({
      name,
      assessed: Array.isArray(header.assessed) ? header.assessed : [],
      detectors,
    });
  }
  return out;
}

async function append(
  entry: LedgerEntry,
  box: LedgerEntry['box'],
  ctx: LedgerCtx,
  grid: readonly [number, number],
): Promise<void> {
  try {
    if (!ctx.photoUrl) throw new Error('The photo is not available for a crop.');
    const cropJpegBase64 = await cropJpeg(ctx.photoUrl, box, 512, 0.15, { grid });
    const r = await bridge.call('ledger:append', { entry, cropJpegBase64 });
    const error = !r.ok ? r.error : r.value.ok ? null : r.value.error;
    if (error) throw new Error(error);
  } catch (e) {
    console.warn('The detector ledger could not take this decision', e);
  }
}

/** An accepted or rejected candidate of a local detector. Nothing for any other detection. */
export async function logReview(
  d: Detection,
  verdict: 'accepted' | 'rejected',
  ctx: LedgerCtx,
): Promise<void> {
  if (d.origin.kind !== 'model' || !d.origin.detector || d.source.kind !== 'photo') return;
  const det = d.origin.detector;
  // an edited draft keeps the box the detector proposed; the new box is the correction
  const now = boundsOf(d.geom);
  const box = d.proposedBox ?? now;
  await append(
    {
      detectorId: det.id,
      detectorVersion: det.version,
      modelSha256: det.modelSha256,
      score: d.unscored || d.confidence === undefined ? null : d.confidence,
      verdict,
      // a reason and note belong to a rejection only, never to an acceptance
      ...(verdict === 'rejected' && d.rejectReason ? { reason: d.rejectReason } : {}),
      ...(verdict === 'rejected' && d.rejectNote ? { note: d.rejectNote } : {}),
      box,
      ...(d.proposedBox ? { corrected: now } : {}),
      photo: { project: ctx.projectId, layer: d.source.layer, id: d.source.photo },
      at: new Date().toISOString(),
      detectionId: d.id,
    },
    box,
    ctx,
    d.size,
  );
}

/**
 * A finding drawn by a person on a photo a local-detector pass assessed, of a class one of its
 * detectors looks for: one `miss` line per such detector.
 */
export async function logMiss(
  d: Detection,
  passes: readonly MissPass[],
  ctx: LedgerCtx,
): Promise<void> {
  if (d.origin.kind !== 'human' || d.source.kind !== 'photo' || d.classId === '') return;
  const { layer, photo } = d.source;
  const box = boundsOf(d.geom);
  const hits = passes
    .filter((p) => p.name.startsWith('vlm-') && p.assessed.includes(photo))
    .flatMap((p) => p.detectors.filter((x) => x.classId === d.classId));
  const seen = new Set<string>();
  for (const det of hits) {
    if (seen.has(det.id)) continue;
    seen.add(det.id);
    await append(
      {
        detectorId: det.id,
        detectorVersion: det.version,
        modelSha256: det.modelSha256,
        score: null,
        verdict: 'miss',
        box,
        photo: { project: ctx.projectId, layer, id: photo },
        at: new Date().toISOString(),
        detectionId: d.id,
      },
      box,
      ctx,
      d.size,
    );
  }
}
