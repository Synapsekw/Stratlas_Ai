import type { EngineerSetup, EvidencePack } from '@aio/schema';

/**
 * The measurement summary an engineer request carries (spec 5.2, step 3): the evidence pack's
 * numbers as compact JSON text, rounded (millimetres for lengths, three decimals otherwise), every
 * list cut to at most 16 items (evenly over its length, so a profile keeps its ends), and the
 * setup choices the model should know. No paths, no photo file names, nothing raw: the request
 * treats this text as data.
 */

/** The longest list the summary keeps. */
export const SUMMARY_MAX_ITEMS = 16;

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const v3 = (p: readonly number[]) => p.map(r3);

/** At most `n` items, spread evenly over the list (first and last kept). */
export function spread<T>(items: readonly T[], n = SUMMARY_MAX_ITEMS): T[] {
  if (items.length <= n) return [...items];
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const at = items[Math.round((i * (items.length - 1)) / (n - 1))];
    if (at !== undefined) out.push(at);
  }
  return out;
}

export function measurementSummary(e: EvidencePack | null, setup: EngineerSetup): string {
  const choices = {
    family: setup.family,
    scope: setup.scope,
    detail: setup.detail,
    ...(setup.reference
      ? {
          reference: {
            what: setup.reference.what,
            valueM: r3(setup.reference.valueM),
            ...(setup.reference.label ? { label: setup.reference.label } : {}),
          },
        }
      : {}),
    placement: setup.placement,
  };
  if (!e) return JSON.stringify({ setup: choices, evidence: null });
  const summary = {
    setup: choices,
    units: e.units,
    metric: e.samples.kept > 0,
    height: e.height === null ? null : r3(e.height),
    base: e.base ? v3(e.base) : null,
    axis: e.axis ? { dir: v3(e.axis.dir), tiltDeg: r3(e.axis.tiltDeg) } : null,
    bounds: e.bounds ? { min: v3(e.bounds.min), max: v3(e.bounds.max) } : null,
    samples: e.samples,
    taper: e.taper
      ? {
          profile: spread(e.taper.profile).map((p) => ({ y: r3(p.y), r: r3(p.r) })),
          residualM: r3(e.taper.residualM),
        }
      : null,
    slices: {
      count: e.slices.length,
      items: spread(e.slices).map((s) => ({
        y: r3(s.y),
        r: r3(s.r),
        shape: s.shape,
        residualM: r3(s.residualM),
        coverage: r3(s.coverage),
      })),
    },
    members: e.members.slice(0, SUMMARY_MAX_ITEMS).map((m) => ({
      kind: m.kind,
      count: m.items.length,
      items: spread(m.items).map((i) => ({
        centre: v3(i.centre),
        size: r3(i.size),
        ...(i.azimuthDeg !== undefined ? { azimuthDeg: r3(i.azimuthDeg) } : {}),
      })),
      ...(m.levels ? { levels: spread(m.levels).map(r3) } : {}),
      ...(m.metrics.residualM !== undefined ? { residualM: r3(m.metrics.residualM) } : {}),
      ...(m.metrics.regularity !== undefined ? { regularity: r3(m.metrics.regularity) } : {}),
    })),
    familyHints: e.familyHints
      ? {
          suggested: e.familyHints.suggested,
          fillRatio: r3(e.familyHints.fillRatio),
          slenderness: r3(e.familyHints.slenderness),
          topFeatures: e.familyHints.topFeatures,
        }
      : null,
    colours: spread(e.colours).map((c) => ({
      y0: r3(c.y0),
      y1: r3(c.y1),
      rgb: c.rgb.map((x) => Math.round(x)),
    })),
    photos: {
      count: e.photos.length,
      duplicates: e.photos.filter((p) => p.dupOf !== undefined).length,
    },
    images: spread(e.images).map((i) => ({ id: i.id, kind: i.kind, view: i.view })),
    reconstruction: e.reconstruction,
    warnings: spread(e.warnings),
  };
  return JSON.stringify(summary);
}
