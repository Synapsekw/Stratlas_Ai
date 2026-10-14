import { localToProject } from '@aio/geo';
import type { Vec3 } from '@aio/schema';
import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * Data that lands far from the project origin (a cloud in the right place, an origin from a
 * camera's wrong GPS): named in a notice that offers to move the origin there.
 */
export const FAR_M = 10_000;

export interface Extent {
  layerId: string;
  min: readonly number[];
  max: readonly number[];
}
export interface FarLayer {
  layerId: string;
  /** Plan distance from the origin to the layer's box, metres. */
  distanceM: number;
  min: readonly number[];
  max: readonly number[];
}

const gap1 = (aLo: number, aHi: number, bLo: number, bHi: number) =>
  Math.max(0, bLo - aHi, aLo - bHi);

/** Plan (x, z) distance between two boxes; 0 when they overlap in plan. */
export function planGap(a: Omit<Extent, 'layerId'>, b: Omit<Extent, 'layerId'>): number {
  return Math.hypot(
    gap1(a.min[0] ?? 0, a.max[0] ?? 0, b.min[0] ?? 0, b.max[0] ?? 0),
    gap1(a.min[2] ?? 0, a.max[2] ?? 0, b.min[2] ?? 0, b.max[2] ?? 0),
  );
}

/**
 * The layers not in `older` that lie more than `limitM` from the origin and from every older
 * layer, nearest first.
 */
export function farLayers(
  extents: readonly Extent[],
  older: ReadonlySet<string>,
  limitM = FAR_M,
): FarLayer[] {
  const origin = { min: [0, 0, 0], max: [0, 0, 0] };
  const old = extents.filter((e) => older.has(e.layerId));
  return extents
    .filter((e) => !older.has(e.layerId))
    .map((e) => ({ ...e, distanceM: planGap(origin, e) }))
    .filter((e) => e.distanceM > limitM && old.every((o) => planGap(o, e) > limitM))
    .sort((a, b) => a.distanceM - b.distanceM);
}

/** The new origin (E, N): the rounded centre of the far layers' boxes. */
export function recentreTarget(far: readonly FarLayer[], origin: Vec3): [number, number] {
  const lo = (k: number) => Math.min(...far.map((f) => f.min[k] ?? 0));
  const hi = (k: number) => Math.max(...far.map((f) => f.max[k] ?? 0));
  const c: Vec3 = [(lo(0) + hi(0)) / 2, 0, (lo(2) + hi(2)) / 2];
  const p = localToProject(c, origin);
  return [Math.round(p[0]), Math.round(p[1])];
}

type Call = (channel: string, req: Record<string, unknown>) => Promise<unknown>;
interface FarProject {
  id: string;
  manifest: { origin: Vec3; layers: readonly { id: string; name: string }[] };
}

export interface FarNoticeState {
  notice: {
    projectId: string;
    text: string;
    canRecentre: boolean;
    target: [number, number] | null;
    busy: boolean;
    done: boolean;
  } | null;
  check(projectId: string, fresh: ReadonlySet<string> | 'all'): Promise<void>;
  recentre(): Promise<void>;
  dismiss(): void;
}

const km = (m: number) => `${(m / 1000).toFixed(1)} km`;

export function createFarNotice(deps: {
  call: Call;
  project: () => FarProject | null;
  /** Reopen the project with this manifest: the local frame moved under every layer. */
  reopen: (manifest: unknown) => void;
}): StoreApi<FarNoticeState> {
  return createStore<FarNoticeState>((set, get) => ({
    notice: null,
    async check(projectId, fresh) {
      const p = deps.project();
      if (p?.id !== projectId) return;
      const r = (await deps.call('builder:layerExtents', { projectId })) as
        | { ok: true; extents: Extent[]; recentre: { blockers: string[] } }
        | { ok: false; error: string };
      if (!r.ok) return;
      const older = new Set(
        fresh === 'all' ? [] : r.extents.map((e) => e.layerId).filter((id) => !fresh.has(id)),
      );
      const far = farLayers(r.extents, older);
      if (far.length === 0) {
        set({
          notice:
            fresh === 'all'
              ? {
                  projectId,
                  text: `Every layer lies within ${km(FAR_M)} of the project origin.`,
                  canRecentre: false,
                  target: null,
                  busy: false,
                  done: true,
                }
              : null,
        });
        return;
      }
      const name = (id: string) => p.manifest.layers.find((l) => l.id === id)?.name ?? id;
      const lines = far.map(
        (f) => `${name(f.layerId)} lies ${km(f.distanceM)} from the project origin.`,
      );
      const blockers = r.recentre.blockers;
      const why = blockers.length
        ? ` Re-centring is not offered: this project holds ${blockers.join(', ')}.`
        : ' Re-centre the project there, or keep it as it is.';
      set({
        notice: {
          projectId,
          text: `${lines.join(' ')}${why}`,
          canRecentre: blockers.length === 0,
          target: recentreTarget(far, p.manifest.origin),
          busy: false,
          done: false,
        },
      });
    },
    async recentre() {
      const n = get().notice;
      if (!n?.canRecentre || !n.target) return;
      set({ notice: { ...n, busy: true } });
      const r = (await deps.call('builder:recentre', { projectId: n.projectId, at: n.target })) as
        { ok: true; manifest: unknown } | { ok: false; error: string };
      if (!r.ok) {
        set({ notice: { ...n, busy: false, canRecentre: false, text: r.error } });
        return;
      }
      deps.reopen(r.manifest);
      set({
        notice: {
          ...n,
          busy: false,
          done: true,
          canRecentre: false,
          text: `Re-centred: the project origin is now E ${String(n.target[0])}, N ${String(n.target[1])}. The previous manifest is kept as manifest.json.bak.`,
        },
      });
    },
    dismiss() {
      set({ notice: null });
    },
  }));
}
