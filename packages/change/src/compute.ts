import {
  turnOf,
  type ChangeItem,
  type ChangeKind,
  type ChangeSet,
  type ChangeThresholds,
  type Issue,
  type Layer,
  type ProjectManifest,
  type Vec3,
} from '@aio/schema';
import { dateShiftOf } from '@aio/workspace';
import { detectionChanges, photoDetectionLocator, type DetectionPass } from './detections';
import { issueChanges } from './issues';
import {
  changeSetId,
  counterpartPairs,
  IN_APP_PRODUCERS,
  orderPair,
  type DateIndex,
  type InAppKind,
} from './pairs';
import { buildChangeSet, mergeReviews } from './register';
import { lineUpOfPair, lineUpTurnOfPair } from './stale';
import { vectorChanges } from './vector';

/**
 * The in-app producers of a date pair (`change:compute`): issues, detections and map vectors,
 * one change set each, merged with the previous file so reviews survive. Pure apart from the
 * sources it is given, so main runs it and tests run it on fixtures.
 */

type VectorLayer = Extract<Layer, { kind: 'vector' }>;

export interface ComputeSources {
  manifest: ProjectManifest;
  index: DateIndex;
  thresholds: ChangeThresholds;
  issues(): Promise<readonly Issue[]>;
  passes(): Promise<readonly DetectionPass[]>;
  /**
   * Width and height in pixels of a photo file (to place its detections on the ground); without
   * it, detections count per class and zone only.
   */
  photoSize?(
    layer: string,
    photo: { id: string; src: unknown },
  ): Promise<readonly [number, number] | null>;
  /** The GeoJSON of a vector layer (null when it cannot be read). */
  geojson(layer: VectorLayer): Promise<unknown>;
  /** The set already written under this id, if any. */
  previous(id: string): Promise<ChangeSet | null>;
  /** Lon/lat to the project local frame (vector `at`). */
  toLocal?: (lonLat: [number, number]) => Vec3;
  /** A plain-words note on something the run left out (shown to the person by the caller). */
  note?(text: string): void;
  now(): string;
  jobId?: string;
  progress?(phase: string, done: number, total: number): void;
  cancelled?(): boolean;
}

export class ChangeCancelled extends Error {
  constructor() {
    super('Change detection was cancelled.');
  }
}

/** The in-app kinds of a request, in the producers' order. */
export function inAppKinds(kinds: readonly ChangeKind[]): InAppKind[] {
  return (Object.keys(IN_APP_PRODUCERS) as InAppKind[]).filter((k) => kinds.includes(k));
}

export async function computeInApp(
  src: ComputeSources,
  a: string,
  b: string,
  kinds: readonly ChangeKind[],
): Promise<ChangeSet[]> {
  const pair = orderPair(src.index, a, b);
  if (!pair) throw new Error('Pick two different survey dates of this project.');
  const { from, to } = pair;
  const todo = inAppKinds(kinds);
  if (todo.length === 0)
    throw new Error('Issues, detections and map layers are compared in the app; pick one of them.');
  const shiftOf = (layerId: string) => dateShiftOf(src.manifest, layerId);
  const lineUp = lineUpOfPair(src.manifest, from, to);
  const lineUpTurn = lineUpTurnOfPair(src.manifest, from, to);
  const out: ChangeSet[] = [];
  let done = 0;
  const step = (phase: string) => {
    if (src.cancelled?.()) throw new ChangeCancelled();
    src.progress?.(phase, done, todo.length);
  };
  for (const kind of todo) {
    step(kind);
    const producer = IN_APP_PRODUCERS[kind];
    let items: ChangeItem[];
    let skipped = 0;
    let pairsCount = 0;
    if (kind === 'issue') {
      items = issueChanges({
        manifest: src.manifest,
        index: src.index,
        issues: await src.issues(),
        from,
        to,
        thresholds: src.thresholds,
        shiftOf,
      });
    } else if (kind === 'detection') {
      const passes = await src.passes();
      items = detectionChanges({
        manifest: src.manifest,
        index: src.index,
        passes,
        from,
        to,
        ...(src.photoSize
          ? {
              locate: await photoDetectionLocator(
                src.manifest,
                passes,
                (l, p) => src.photoSize?.(l, p) ?? Promise.resolve(null),
              ),
            }
          : {}),
      });
    } else {
      items = [];
      const pairs = counterpartPairs(src.index, src.manifest.layers, 'vector', from, to);
      pairsCount = pairs.length;
      for (const [la, lb] of pairs) {
        step(kind);
        // a turn is about a pivot in the project frame: without the coordinate system it cannot
        // be placed, and the pair is left out rather than compared at a wrong place
        if (!src.toLocal && (turnOf(shiftOf(la.id)) || turnOf(shiftOf(lb.id)))) {
          skipped += 1;
          continue;
        }
        const [ga, gb] = await Promise.all([src.geojson(la), src.geojson(lb)]);
        if (ga === null || gb === null) continue;
        items.push(
          ...vectorChanges({
            layerFrom: la.id,
            layerTo: lb.id,
            from: ga,
            to: gb,
            ...(src.toLocal ? { toLocal: src.toLocal } : {}),
            shiftFrom: shiftOf(la.id),
            shiftTo: shiftOf(lb.id),
          }),
        );
      }
    }
    if (kind === 'vector' && skipped > 0) {
      src.note?.(
        "Vector changes were skipped: a turned line-up needs the project's coordinate system.",
      );
      // every pair was left out: an empty set would read as "nothing changed"
      if (skipped === pairsCount) {
        done += 1;
        continue;
      }
    }
    const id = changeSetId(from, to, producer);
    const now = src.now();
    const fresh = buildChangeSet({
      id,
      from,
      to,
      producer,
      items,
      createdAt: now,
      run: { at: now, ...(src.jobId ? { jobId: src.jobId } : {}) },
      lineUp,
      lineUpTurn,
    });
    out.push(mergeReviews(await src.previous(id), fresh));
    done += 1;
  }
  src.progress?.('done', done, todo.length);
  return out;
}
