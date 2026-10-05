/**
 * The spatial part of the window context: a compact site summary (origin, CRS, extent, named
 * areas with counts and example tags, media counts), the site clock, and where the camera is and
 * what is in view. It tells the model what it can fly to without listing every node; find_places
 * looks up the rest. Kept to a few kilobytes on a 400-tag plant.
 */
import { siteLocation } from '@aio/engine';
import type { WindowKind } from '@aio/schema';
import { cameraReport, currentPose, placesInView, siteBox } from './camera-tools';
import { describePoint, placeIndex, round, words, type Place } from './places';
import type { RendererToolContext } from './tool-kit';

const MAX_GROUPS = 14;
const EXAMPLES = 3;

function crsText(crs: { epsg: number } | { wkt: string }): string {
  if (!('epsg' in crs)) return 'custom (WKT)';
  const e = crs.epsg;
  if (e > 32600 && e <= 32660) return `EPSG:${String(e)} (UTM ${String(e - 32600)}N, WGS84)`;
  if (e > 32700 && e <= 32760) return `EPSG:${String(e)} (UTM ${String(e - 32700)}S, WGS84)`;
  return `EPSG:${String(e)}`;
}

const volume = (p: Place) =>
  p.box
    ? Math.max(1e-3, p.box.max[0] - p.box.min[0]) *
      Math.max(1e-3, p.box.max[1] - p.box.min[1]) *
      Math.max(1e-3, p.box.max[2] - p.box.min[2])
    : 0;

/** A few tags of a group a person would name: the biggest, else one per type code. */
function examples(members: Place[]): string[] {
  if (members.some((m) => m.box)) {
    return [...members]
      .sort((a, b) => volume(b) - volume(a))
      .slice(0, EXAMPLES)
      .map((m) => m.name);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of members) {
    const code = words(m.name).find((w) => /^[a-z]+$/.test(w)) ?? m.name;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(m.name);
    if (out.length === EXAMPLES) break;
  }
  return out;
}

function siteClock(ctx: RendererToolContext, nowMs: number): string | null {
  const project = ctx.workspace.getState().project;
  const loc = project ? siteLocation(project.manifest) : null;
  if (!loc) return null;
  const h = loc.utcOffsetHours;
  const t = new Date(nowMs + h * 3_600_000).toISOString().slice(11, 19);
  return `${t} (UTC${h >= 0 ? '+' : ''}${String(h)})`;
}

export function spatialContext(
  ctx: RendererToolContext,
  window: WindowKind,
): Record<string, unknown> {
  const state = ctx.workspace.getState();
  const project = state.project;
  if (!project || window === 'report') return {};
  try {
    const m = project.manifest;
    const index = placeIndex(ctx, { measure: true });
    const assets = index.filter((p) => p.kind === 'asset');
    const groups = index
      .filter((p) => p.kind === 'group')
      .sort((a, b) => (b.nodes?.length ?? 0) - (a.nodes?.length ?? 0));
    const byNode = new Map(assets.map((a) => [a.nodes?.[0] ?? a.name, a]));
    const box = siteBox(ctx);
    const loc = siteLocation(m);
    const origin = describePoint(ctx, [0, 0, 0]);
    const count = (k: Place['kind']) => index.filter((p) => p.kind === k).length;
    const pose = currentPose(ctx);
    const view = ctx.app?.stageView?.();
    const clock = siteClock(ctx, state.nowMs);
    const site: Record<string, unknown> = {
      crs: crsText(m.crs),
      origin: {
        en: origin.en,
        elevationM: origin.elevationM,
        ...(loc ? { latLon: [round(loc.lat, 6), round(loc.lon, 6)] } : {}),
      },
      frame: 'local metres: x east, y up, z south; E = origin E + x, N = origin N - z',
      ...(box
        ? {
            extent: {
              sizeM: {
                eastWest: Math.round(box.max[0] - box.min[0]),
                northSouth: Math.round(box.max[2] - box.min[2]),
                height: Math.round(box.max[1] - box.min[1]),
              },
              enMin: describePoint(ctx, [box.min[0], box.min[1], box.max[2]]).en,
              enMax: describePoint(ctx, [box.max[0], box.max[1], box.min[2]]).en,
            },
          }
        : {}),
      named: {
        assets: assets.length,
        groups: groups.slice(0, MAX_GROUPS).map((g) => ({
          name: g.name,
          count: g.nodes?.length ?? 0,
          eg: examples(
            (g.nodes ?? []).flatMap((n) => {
              const a = byNode.get(n);
              return a ? [a] : [];
            }),
          ),
        })),
        ...(groups.length > MAX_GROUPS ? { moreGroups: groups.length - MAX_GROUPS } : {}),
        photos: count('photo'),
        panoramas: count('pano'),
        clips: count('clip'),
        issuesWithLocation: index.filter((p) => p.kind === 'issue' && p.p).length,
        ...(count('pile') ? { piles: count('pile') } : {}),
      },
      ...(clock ? { siteTime: clock } : {}),
      ...(view ? { stage: view.show3d ? (view.showMap ? 'split' : '3d') : 'map' } : {}),
    };
    if (pose && ctx.scene()) {
      const r = cameraReport(ctx, pose, index);
      site.camera = {
        lookingAt: r.lookingAt.place ?? r.lookingAt.en,
        lookingAtEn: r.lookingAt.en,
        distanceM: r.distanceM,
        facing: r.facing,
        pitchDeg: r.pitchDeg,
      };
      const seen = placesInView(ctx, index);
      if (seen.length) site.inView = seen;
    }
    return { site };
  } catch {
    // the summary is a help, never a reason to fail a send
    return {};
  }
}
