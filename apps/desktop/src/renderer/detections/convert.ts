/**
 * Turning AI detection results into draft detections (BLD-6), and choosing what to send.
 * Pure, so the rules are tested without a model: normalised boxes become photo pixels, labels map
 * to the project's classes, severities outside the class's model are dropped (the reviewer picks
 * one), and a proposal that repeats one already on the photo (same class, overlapping) is skipped.
 */
import type { AiDetection, DetectClass, DetectSeverity } from '@aio/ai';
import {
  boundsIou,
  normBoxToPixels,
  normPolygonToPixels,
  sourceKey,
  type Detection,
  type DetectionSource,
} from '@aio/annotate/detections';
import type { ClassCatalogue, SeverityModel } from '@aio/schema';

/** A photo or a video frame to send. */
export type DetectItem =
  { kind: 'photo'; layer: string; photo: string } | { kind: 'frame'; layer: string; t: number };

export function itemSource(i: DetectItem): DetectionSource {
  return i.kind === 'photo'
    ? { kind: 'photo', layer: i.layer, photo: i.photo }
    : { kind: 'frame', layer: i.layer, t: i.t };
}

export const itemKey = (i: DetectItem) => sourceKey(itemSource(i));

/** Proposals overlapping an earlier one of the same class this much are repeats. */
const REPEAT_IOU = 0.7;

export interface ConvertInput {
  results: readonly { key: string; detections: readonly AiDetection[] }[];
  items: ReadonlyMap<string, DetectItem>;
  /** Pixel size of each sent image's original, by key. */
  sizes: ReadonlyMap<string, { width: number; height: number }>;
  models: readonly SeverityModel[];
  catalogues: readonly ClassCatalogue[];
  provider: string;
  model: string;
  promptVersion: string;
  runId: string;
  /** The pass file the run writes (`ai-<run>.json`). */
  pass: string;
  now: string;
  existing: readonly Detection[];
  newId: () => string;
}

export function toDraftDetections(o: ConvertInput): { detections: Detection[]; skipped: number } {
  const classes = new Map(o.catalogues.flatMap((c) => c.classes).map((c) => [c.id, c]));
  const models = new Map(o.models.map((m) => [m.id, m]));
  const bySource = new Map<string, Detection[]>();
  for (const d of o.existing) {
    if (d.status === 'rejected') continue;
    const k = sourceKey(d.source);
    bySource.set(k, [...(bySource.get(k) ?? []), d]);
  }
  const out: Detection[] = [];
  let skipped = 0;
  for (const r of o.results) {
    const item = o.items.get(r.key);
    const size = o.sizes.get(r.key);
    if (!item || !size) {
      skipped += r.detections.length;
      continue;
    }
    const source = itemSource(item);
    const here = bySource.get(r.key) ?? [];
    for (const a of r.detections) {
      const geom =
        (a.polygon ? normPolygonToPixels(a.polygon, size) : null) ??
        (a.box ? normBoxToPixels(a.box, size) : null);
      if (!geom) {
        skipped++;
        continue;
      }
      const cls = classes.get(a.classId);
      if (here.some((d) => d.classId === a.classId && boundsIou(d.geom, geom) >= REPEAT_IOU)) {
        skipped++;
        continue;
      }
      const model = cls ? models.get(cls.severityModel) : undefined;
      const severity =
        typeof a.severity === 'number' && model?.levels.some((l) => l.value === a.severity)
          ? a.severity
          : null;
      const d: Detection = {
        id: o.newId(),
        pass: o.pass,
        source,
        size: [size.width, size.height],
        geom,
        classId: cls ? cls.id : '',
        label: a.label,
        severity,
        uncertain: a.uncertain === true,
        note: a.note ?? '',
        status: 'draft',
        origin: {
          kind: 'ai',
          provider: o.provider,
          model: o.model,
          promptVersion: o.promptVersion,
          runId: o.runId,
        },
        createdAt: o.now,
        updatedAt: o.now,
      };
      if (a.confidence !== undefined) d.confidence = a.confidence;
      out.push(d);
      here.push(d);
      bySource.set(r.key, here);
    }
  }
  return { detections: out, skipped };
}

/** The classes and the severity scale sent with a request (the most used model's levels). */
export function promptTaxonomy(
  models: readonly SeverityModel[],
  catalogues: readonly ClassCatalogue[],
): { classes: DetectClass[]; severity?: DetectSeverity } {
  const all = catalogues.flatMap((c) => c.classes);
  const classes = all.map((c) => ({ id: c.id, label: c.label }));
  const uses = new Map<string, number>();
  for (const c of all) uses.set(c.severityModel, (uses.get(c.severityModel) ?? 0) + 1);
  const top = [...uses.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const model = models.find((m) => m.id === top) ?? models[0];
  if (!model) return { classes };
  return {
    classes,
    severity: {
      levels: model.levels.map((l) => ({
        value: l.value,
        label: l.label,
        ...(l.criteria ? { criteria: l.criteria } : {}),
      })),
      ...(model.uncertain ? { uncertain: true } : {}),
    },
  };
}

/** Frame times to sample from a clip: every `everyS` seconds, at most `max`, never at the end. */
export function sampleTimes(durationS: number, everyS: number, max: number): number[] {
  if (!(durationS > 0) || !(everyS > 0) || max < 1) return [];
  const out: number[] = [];
  for (
    let t = Math.min(everyS / 2, durationS / 2);
    t < durationS && out.length < max;
    t += everyS
  ) {
    out.push(Math.round(t * 1000) / 1000);
  }
  return out;
}
