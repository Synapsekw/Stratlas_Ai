import type { ChangeKind, Layer, ProjectManifest } from '@aio/schema';

/** The date pair a producer is offered for. */
export interface ChangePairContext {
  projectId: string;
  manifest: ProjectManifest;
  /** Capture ids of the earlier and later date. */
  from: string;
  to: string;
  /** Layers of each date (explicit `capture` first, then the naming rules). */
  layersFrom: readonly Layer[];
  layersTo: readonly Layer[];
}

export type ChangeRunResult =
  | {
      ok: true;
      /** A pipeline job started. */
      jobId?: string;
      /** Change sets written. */
      ids?: string[];
    }
  | { ok: false; error: string };

/**
 * Something that computes change for a date pair: the in-app comparisons (C1) or a pipeline
 * (`change.raster` and friends, C2 to C4). The Changes panel offers one "Run ..." action each.
 */
export interface ChangeProducer {
  /** Stable id: `issues`, `raster`, `surface`, `cloud`, `mesh`, `frames`... */
  id: string;
  /** Action label in the panel ("Run imagery change"). */
  label: string;
  /** Item kinds its change sets hold. */
  kinds: readonly ChangeKind[];
  /** True when the pair has what it needs; a string says what is missing. */
  available(ctx: ChangePairContext): true | string;
  run(ctx: ChangePairContext): Promise<ChangeRunResult>;
}

const producers = new Map<string, ChangeProducer>();

/** Register a producer; returns the function that removes it. A duplicate id is refused. */
export function registerChangeProducer(producer: ChangeProducer): () => void {
  if (producers.has(producer.id))
    throw new Error(`A change producer "${producer.id}" is already registered.`);
  producers.set(producer.id, producer);
  return () => {
    if (producers.get(producer.id) === producer) producers.delete(producer.id);
  };
}

/** Registered producers, in registration order. */
export function changeProducers(): readonly ChangeProducer[] {
  return [...producers.values()];
}
