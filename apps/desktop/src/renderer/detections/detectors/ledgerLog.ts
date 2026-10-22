/**
 * Review decisions into the local detector ledger (`ledger:append`): an accepted or rejected
 * candidate of a local vision-model detector, and a finding a person drew by hand that a detector
 * of the same class should have found (a miss). The ledger only ever suggests a better threshold,
 * so a failure here is logged and never reaches the review.
 */
import { boundsOf, type Detection } from '@aio/annotate/detections';
import type { LedgerEntry } from '@aio/schema';
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

async function append(entry: LedgerEntry, box: LedgerEntry['box'], ctx: LedgerCtx): Promise<void> {
  try {
    if (!ctx.photoUrl) throw new Error('The photo is not available for a crop.');
    const cropJpegBase64 = await cropJpeg(ctx.photoUrl, box);
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
      ...(d.rejectReason ? { reason: d.rejectReason } : {}),
      ...(d.rejectNote ? { note: d.rejectNote } : {}),
      box,
      ...(d.proposedBox ? { corrected: now } : {}),
      photo: { project: ctx.projectId, layer: d.source.layer, id: d.source.photo },
      at: new Date().toISOString(),
      detectionId: d.id,
    },
    box,
    ctx,
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
  if (d.origin.kind !== 'human' || d.source.kind !== 'photo') return;
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
    );
  }
}
