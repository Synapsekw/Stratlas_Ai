import {
  CHECKPOINT_EVERY_OPS,
  SEGMENT_MAX_BYTES,
  SEGMENT_MAX_OPS,
  type Op,
  type Via,
} from '@aio/schema';
import type { DraftOp } from './diff';
import { createClock } from './hlc';
import { sealOp, type UnsealedOp } from './op';
import { writeSegmentLine } from './segment';
import type { Signer } from './sign';

/** Where a chain stands: its head and its open segment. */
export interface ChainTail {
  seq: number;
  id: string;
  hlc: string;
  /** Number of the segment the next op goes to unless it rotates. */
  segment: number;
  segmentBytes: number;
  segmentOps: number;
  /** Ops since the last checkpoint op of this chain. */
  sinceCheckpoint: number;
}

export interface AppendedOp {
  op: Op;
  /** The JSON line, newline included. */
  line: string;
  /** Segment number the line goes to. */
  segment: number;
}

export interface ChainWriter {
  readonly chain: string;
  readonly tail: ChainTail | null;
  /** Seal the next op (clock, seq, prev, segment rotation). Nothing is written here. */
  next(draft: DraftOp, extra?: { via?: Via; deps?: Record<string, string> }): AppendedOp;
  /** A remote clock reading seen (other chains), so this clock never falls behind it. */
  observe(hlc: string): void;
  /** Time for a checkpoint (every CHECKPOINT_EVERY_OPS ops). */
  checkpointDue(): boolean;
}

/**
 * One device's chain in one project folder (`<deviceId>.<replicaId>`). Main keeps one per open
 * project and appends what `next` returns, fsync first, then the state write.
 */
export function createChainWriter(opts: {
  chain: string;
  actor: string;
  signer?: Signer | null;
  tail: ChainTail | null;
  now?: () => number;
}): ChainWriter {
  const dev = opts.chain.split('.')[0] ?? '';
  const clock = createClock(dev, opts.now, opts.tail?.hlc);
  let tail = opts.tail;
  return {
    chain: opts.chain,
    get tail() {
      return tail;
    },
    observe(hlc) {
      try {
        clock.receive(hlc);
      } catch {
        // a reading that is not ours to parse: ignore
      }
    },
    checkpointDue: () => (tail?.sinceCheckpoint ?? 0) >= CHECKPOINT_EVERY_OPS,
    next(draft, extra = {}) {
      const seq = (tail?.seq ?? 0) + 1;
      const unsealed: UnsealedOp = {
        v: 1,
        chain: opts.chain,
        dev,
        act: opts.actor,
        seq,
        hlc: clock.tick(),
        prev: tail?.id ?? null,
        ...(extra.deps && Object.keys(extra.deps).length ? { deps: extra.deps } : {}),
        kind: draft.kind,
        target: draft.target,
        ...(draft.base ? { base: draft.base } : {}),
        ...(extra.via ? { via: extra.via } : {}),
        ...(draft.label ? { label: draft.label } : {}),
      };
      const op = sealOp(unsealed, draft.payload, opts.signer ?? undefined);
      const line = writeSegmentLine(op);
      const bytes = Buffer.byteLength(line, 'utf8');
      let segment = tail?.segment ?? 1;
      let segmentBytes = tail?.segmentBytes ?? 0;
      let segmentOps = tail?.segmentOps ?? 0;
      if (
        segmentOps > 0 &&
        (segmentOps >= SEGMENT_MAX_OPS || segmentBytes + bytes > SEGMENT_MAX_BYTES)
      ) {
        segment += 1;
        segmentBytes = 0;
        segmentOps = 0;
      }
      tail = {
        seq,
        id: op.id,
        hlc: op.hlc,
        segment,
        segmentBytes: segmentBytes + bytes,
        segmentOps: segmentOps + 1,
        sinceCheckpoint: draft.kind === 'checkpoint' ? 0 : (tail?.sinceCheckpoint ?? 0) + 1,
      };
      return { op, line, segment };
    },
  };
}
