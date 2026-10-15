import { FAR_M } from '@aio/engine';
import { localToProject } from '@aio/geo';
import type { Vec3 } from '@aio/schema';
import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * Data that lands far from the project origin (a cloud in the right place, an origin from a
 * camera's wrong GPS): named in a notice that offers to move the origin there. The engine's
 * threshold, shared with Centre on project and the street map.
 */
export { FAR_M };

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

/**
 * The ids of layers added since the last look at the open project. A project just opened (or a
 * different one) is its own baseline: nothing is fresh. `seen` is the state to pass next time.
 */
export interface SeenLayers {
  projectId: string;
  ids: ReadonlySet<string>;
}
export function freshLayerIds(
  seen: SeenLayers | null,
  project: { id: string; layerIds: readonly string[] } | null,
): { seen: SeenLayers | null; fresh: Set<string> } {
  if (!project) return { seen: null, fresh: new Set() };
  const ids = new Set(project.layerIds);
  const before = seen?.projectId === project.id ? seen.ids : null;
  const fresh = before ? new Set([...ids].filter((id) => !before.has(id))) : new Set<string>();
  return { seen: { projectId: project.id, ids }, fresh };
}

type Call = (channel: string, req: Record<string, unknown>) => Promise<unknown>;
interface FarProject {
  id: string;
  manifest: { origin: Vec3; layers: readonly { id: string; name: string; kind?: string }[] };
}

export interface FarNoticeState {
  notice: {
    projectId: string;
    text: string;
    canRecentre: boolean;
    target: [number, number] | null;
    busy: boolean;
    done: boolean;
    /** The far layers this notice reports; later additions near them widen the target. */
    far: FarLayer[];
    /**
     * Photos layers far from the survey data (a camera's GPS, often from a linked phone): offered
     * "Ignore their GPS" instead of a re-centre.
     */
    photoLayers: string[];
  } | null;
  check(projectId: string, fresh: ReadonlySet<string> | 'all'): Promise<void>;
  recentre(): Promise<void>;
  /** Clear the GPS places of `photoLayers`; the photos stay in Media. */
  ignorePhotoGps(): Promise<void>;
  dismiss(): void;
}

const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
const PHOTOS_FAR =
  "These photos are far from the survey data: a camera's GPS can be kilometres out. Ignore their" +
  ' GPS to keep them in Media without a place.';
const PHOTOS_ONLY =
  ' Only photos placed this project so far; survey data is the better place for the origin.';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

type ExtentsReply =
  { ok: true; extents: Extent[]; recentre: { blockers: string[] } } | { ok: false; error: string };

const isPhotos = (p: FarProject, id: string) =>
  p.manifest.layers.find((l) => l.id === id)?.kind === 'photos';
const farLines = (p: FarProject, far: readonly FarLayer[]) =>
  far
    .map(
      (f) =>
        `${p.manifest.layers.find((l) => l.id === f.layerId)?.name ?? f.layerId} lies ${km(f.distanceM)} from the project origin.`,
    )
    .join(' ');

export function createFarNotice(deps: {
  call: Call;
  project: () => FarProject | null;
  /** Reopen the project with this manifest: the local frame moved under every layer. */
  reopen: (manifest: unknown) => void;
}): StoreApi<FarNoticeState> {
  let latest = 0;
  return createStore<FarNoticeState>((set, get) => ({
    notice: null,
    async check(projectId, fresh) {
      if (deps.project()?.id !== projectId) return;
      const seq = ++latest;
      let r: ExtentsReply;
      try {
        r = (await deps.call('builder:layerExtents', { projectId })) as ExtentsReply;
      } catch (e) {
        r = { ok: false, error: message(e) };
      }
      // only the latest check applies, and only to the project still open
      const p = deps.project();
      if (seq !== latest || p?.id !== projectId) return;
      const fail = (error: string) => {
        if (fresh !== 'all') return;
        set({
          notice: {
            projectId,
            text: `Could not check where layers lie: ${error}`,
            canRecentre: false,
            target: null,
            busy: false,
            done: true,
            far: [],
            photoLayers: [],
          },
        });
      };
      if (!r.ok) {
        fail(r.error);
        return;
      }
      // layers this notice already reports count as part of it, not as older layers
      const prev = get().notice;
      const reported =
        fresh !== 'all' && prev?.projectId === projectId && !prev.done ? prev.far : [];
      const reportedIds = new Set(reported.map((f) => f.layerId));
      const older = new Set(
        fresh === 'all'
          ? []
          : r.extents.map((e) => e.layerId).filter((id) => !fresh.has(id) && !reportedIds.has(id)),
      );
      const added = farLayers(r.extents, older).filter((f) => !reportedIds.has(f.layerId));
      const kept = reported
        .map((f) => r.extents.find((e) => e.layerId === f.layerId))
        .filter((e): e is Extent => e !== undefined)
        .map((e) => ({ ...e, distanceM: planGap({ min: [0, 0, 0], max: [0, 0, 0] }, e) }));
      const far = [...kept, ...added].sort((a, b) => a.distanceM - b.distanceM);
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
                  far: [],
                  photoLayers: [],
                }
              : prev?.projectId === projectId && !prev.done
                ? prev
                : null,
        });
        return;
      }
      if (added.length === 0 && reported.length > 0 && prev) return; // nothing new: keep it as is
      const lines = farLines(p, far);
      // survey data over a camera's GPS: far photos beside survey data are not a new origin, also
      // when both came in the same import (a model near the origin and handheld photos far off)
      const farIds = new Set(far.map((f) => f.layerId));
      const surveyNear = r.extents.some((e) => !farIds.has(e.layerId) && !isPhotos(p, e.layerId));
      if (surveyNear && far.every((f) => isPhotos(p, f.layerId))) {
        set({
          notice: {
            projectId,
            text: `${lines} ${PHOTOS_FAR}`,
            canRecentre: false,
            target: null,
            busy: false,
            done: false,
            far,
            photoLayers: far.map((f) => f.layerId),
          },
        });
        return;
      }
      // the survey layers among the far ones set the target; far photos beside them are offered
      // "Ignore their GPS" by the check after the re-centre
      const surveyFar = far.filter((f) => !isPhotos(p, f.layerId));
      const photosOnly = older.size > 0 && !surveyNear && surveyFar.length > 0;
      const blockers = r.recentre.blockers;
      const why = blockers.length
        ? ` Re-centring is not offered: this project holds ${blockers.join(', ')}.`
        : ' Re-centre the project there, or keep it as it is.';
      set({
        notice: {
          projectId,
          text: `${lines}${photosOnly ? PHOTOS_ONLY : ''}${why}`,
          canRecentre: blockers.length === 0,
          target: recentreTarget(surveyFar.length > 0 ? surveyFar : far, p.manifest.origin),
          busy: false,
          done: false,
          far,
          photoLayers: [],
        },
      });
    },
    async recentre() {
      const n = get().notice;
      if (!n?.canRecentre || !n.target || n.busy) return;
      // a notice that outlived its project must not touch the one open now
      if (deps.project()?.id !== n.projectId) {
        set({ notice: null });
        return;
      }
      set({ notice: { ...n, busy: true } });
      let r: { ok: true; manifest: unknown } | { ok: false; error: string };
      try {
        r = (await deps.call('builder:recentre', { projectId: n.projectId, at: n.target })) as
          { ok: true; manifest: unknown } | { ok: false; error: string };
      } catch (e) {
        r = { ok: false, error: message(e) };
      }
      if (get().notice?.projectId !== n.projectId) return; // dismissed or replaced meanwhile
      if (!r.ok) {
        set({
          notice: {
            ...n,
            busy: false,
            canRecentre: false,
            text: `Re-centring failed: ${r.error}`,
          },
        });
        return;
      }
      // the move is on disk; show the new frame only while that project is still open
      if (deps.project()?.id === n.projectId) deps.reopen(r.manifest);
      const moved = `Re-centred: the project origin is now E ${String(n.target[0])}, N ${String(n.target[1])}. The previous manifest is kept as manifest.json.bak.`;
      set({
        notice: { ...n, busy: false, done: true, canRecentre: false, text: moved, photoLayers: [] },
      });
      // photos placed by a camera's GPS may now lie far from the survey data at the new origin
      if (deps.project()?.id !== n.projectId) return;
      const seq = ++latest;
      let x: ExtentsReply;
      try {
        x = (await deps.call('builder:layerExtents', { projectId: n.projectId })) as ExtentsReply;
      } catch {
        return; // the re-centre itself stands; the photo check is a courtesy
      }
      const now = deps.project();
      const after = get().notice;
      if (!x.ok || seq !== latest || now?.id !== n.projectId) return;
      if (after?.projectId !== n.projectId || !after.done) return;
      const survey = x.extents.map((e) => e.layerId).filter((id) => !isPhotos(now, id));
      if (survey.length === 0) return;
      const far = farLayers(x.extents, new Set(survey));
      if (far.length === 0) return;
      set({
        notice: {
          projectId: n.projectId,
          text: `${moved} ${farLines(now, far)} ${PHOTOS_FAR}`,
          canRecentre: false,
          target: null,
          busy: false,
          done: false,
          far,
          photoLayers: far.map((f) => f.layerId),
        },
      });
    },
    async ignorePhotoGps() {
      const n = get().notice;
      if (!n || n.photoLayers.length === 0 || n.busy) return;
      // a notice that outlived its project must not touch the one open now
      if (deps.project()?.id !== n.projectId) {
        set({ notice: null });
        return;
      }
      set({ notice: { ...n, busy: true } });
      let r: { ok: true; manifest: unknown } | { ok: false; error: string };
      try {
        r = (await deps.call('builder:updateLayers', {
          projectId: n.projectId,
          layerIds: n.photoLayers,
          patch: { photoPositions: 'clear' },
        })) as { ok: true; manifest: unknown } | { ok: false; error: string };
      } catch (e) {
        r = { ok: false, error: message(e) };
      }
      if (get().notice?.projectId !== n.projectId) return; // dismissed or replaced meanwhile
      if (!r.ok) {
        set({
          notice: {
            ...n,
            busy: false,
            photoLayers: [],
            text: `Clearing the GPS places failed: ${r.error}`,
          },
        });
        return;
      }
      if (deps.project()?.id === n.projectId) deps.reopen(r.manifest);
      set({
        notice: {
          ...n,
          busy: false,
          done: true,
          photoLayers: [],
          text: 'GPS places of the photos were cleared; they stay in Media.',
        },
      });
    },
    dismiss() {
      set({ notice: null });
    },
  }));
}
