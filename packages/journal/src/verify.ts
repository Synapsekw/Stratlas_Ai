import type { KeyObject } from 'node:crypto';
import {
  CLOCK_AHEAD_NOTICE_MS,
  JOURNAL_OPS_DIR,
  segmentFileName,
  type VerifyProblem,
  type VerifyReport,
} from '@aio/schema';
import { checkCheckpoint, checkDeviceRecord, merkleRoot, type ChainHead } from './checkpoint';
import { loadJournal, type JournalFiles, type LoadedJournal } from './load';
import { checkOp } from './op';
import { publicKeyObject } from './sign';

export type { JournalFiles } from './load';

export interface VerifyOptions {
  /** This machine's time, for clock readings far ahead (default: now). */
  now?: Date;
  /** Ops the merge engine holds in quarantine (counted, not problems). */
  quarantined?: ReadonlySet<string>;
}

/** One op as Verify saw it, in chain order. */
interface SeenOp {
  file: string;
  line: number;
  raw: Record<string, unknown>;
  seq: number;
  id: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const int = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) ? v : undefined;

const short = (chain: string) => chain.slice(0, 10);

/**
 * Verify chains, `deps`, signatures, forks, gaps, checkpoints and redactions, naming the exact
 * file and line of each problem (data-conventions section 17, the golden fixtures' `cases.json`).
 * Works on the raw JSON of every line, never on a parser's output. Runs in the data process or a
 * worker, never on the UI thread.
 */
export function verifyJournal(files: JournalFiles, opts: VerifyOptions = {}): VerifyReport {
  return verifyLoaded(loadJournal(files), opts);
}

export function verifyLoaded(j: LoadedJournal, opts: VerifyOptions = {}): VerifyReport {
  const now = opts.now ?? new Date();
  const problems: VerifyProblem[] = [];
  const add = (p: VerifyProblem) => problems.push(p);

  // ---- devices: self-signed public keys
  const keys = new Map<string, KeyObject | null>();
  for (const [dev, d] of j.devices) {
    if (d.raw?.id !== dev || !checkDeviceRecord(d.raw)) {
      add({
        code: 'bad-signature',
        file: d.file,
        message: `The device record ${dev.slice(0, 10)} is not signed by its own key.`,
      });
      keys.set(dev, null);
      continue;
    }
    keys.set(dev, publicKeyObject(d.raw.key as string));
  }

  // ---- every op line, in chain order
  const counts = { ops: 0, signed: 0, unsigned: 0, external: 0, quarantined: 0, redacted: 0 };
  const chains: VerifyReport['chains'] = [];
  const byChain = new Map<string, SeenOp[]>();
  const byId = new Map<string, SeenOp>();
  const stripped: SeenOp[] = [];
  const redactedIds = new Set<string>();
  const revoked = new Map<string, string>();
  const unknownDevices = new Set<string>();
  const aheadMs = now.getTime() + CLOCK_AHEAD_NOTICE_MS;

  for (const c of j.chains.values()) {
    const dev = c.chain.split('.')[0] ?? '';
    const seen: SeenOp[] = [];
    // a whole segment file missing while a later one exists
    const missingSegments: number[] = [];
    const last = c.segments[c.segments.length - 1]?.n ?? 0;
    const present = new Set(c.segments.map((s) => s.n));
    for (let n = 1; n < last; n++) if (!present.has(n)) missingSegments.push(n);
    for (const n of missingSegments) {
      add({
        code: 'segment-missing',
        file: `${JOURNAL_OPS_DIR}/${c.chain}/${segmentFileName(n)}`,
        chain: c.chain,
        message: `Segment ${String(n)} of chain ${short(c.chain)} is missing; later segments follow it.`,
      });
    }
    for (const s of c.segments) {
      for (const l of s.lines) {
        if (!l.ok) {
          add({
            code: 'parse',
            file: s.file,
            line: l.line,
            message: `Line ${String(l.line)} is not a valid entry (${l.error}).`,
          });
          continue;
        }
        const raw = l.raw;
        const id = str(raw.id);
        const seq = int(raw.seq);
        if (id === undefined || seq === undefined || seq < 1 || raw.chain !== c.chain) {
          add({
            code: 'parse',
            file: s.file,
            line: l.line,
            message: `Line ${String(l.line)} is not an entry of chain ${short(c.chain)}.`,
          });
          continue;
        }
        const op: SeenOp = { file: s.file, line: l.line, raw, seq, id };
        seen.push(op);
        counts.ops += 1;
        const at = { file: s.file, line: l.line, chain: c.chain, seq, op: id };

        if (!keys.has(dev) && !unknownDevices.has(dev)) {
          unknownDevices.add(dev);
          add({
            ...at,
            code: 'unknown-device',
            message: `Chain ${short(c.chain)} has no device record with its public key.`,
          });
        }
        const check = checkOp(raw, keys.get(dev) ?? null);
        if (!check.id) {
          add({
            ...at,
            code: 'hash-mismatch',
            message: `Line ${String(l.line)} was changed after it was written: it no longer matches its hash.`,
          });
        }
        if (check.payload === false) {
          add({
            ...at,
            code: 'payload-hash',
            message: `The content of line ${String(l.line)} was changed after it was written.`,
          });
        }
        if (check.payload === null) stripped.push(op);
        if (typeof raw.sig !== 'string') {
          counts.unsigned += 1;
          add({
            ...at,
            code: 'unsigned',
            message: `Line ${String(l.line)} is not signed (the key vault was not available).`,
          });
        } else if (keys.get(dev)) {
          if (check.signature === true) counts.signed += 1;
          else
            add({
              ...at,
              code: 'bad-signature',
              message: `The signature on line ${String(l.line)} is not from the device that wrote it.`,
            });
        }
        if (
          raw.kind === 'record.external' ||
          (raw.via as { external?: unknown } | undefined)?.external
        ) {
          counts.external += 1;
        }
        if (opts.quarantined?.has(id)) counts.quarantined += 1;
        const payload = raw.payload as Record<string, unknown> | undefined;
        if (raw.kind === 'op.redact' && check.id && typeof payload?.op === 'string') {
          redactedIds.add(payload.op);
        }
        if (raw.kind === 'comment.redact' && check.id && Array.isArray(payload?.ops)) {
          for (const x of payload.ops) if (typeof x === 'string') redactedIds.add(x);
        }
        if (raw.kind === 'device.revoke' && check.id && typeof payload?.device === 'string') {
          const hlc = str(raw.hlc) ?? '';
          const prev = revoked.get(payload.device);
          if (prev === undefined || hlc < prev) revoked.set(payload.device, hlc);
        }
        const hlc = str(raw.hlc);
        if (hlc && Number(hlc.slice(0, 13)) > aheadMs) {
          add({
            ...at,
            code: 'clock-ahead',
            message: `Line ${String(l.line)} was written with a clock ahead of this computer.`,
          });
        }
      }
    }

    // ---- order, gaps and forks within the chain
    const seqs = new Set(seen.map((o) => o.seq));
    const kept = new Map<number, SeenOp>();
    let expected = 1;
    let reordered = false;
    // a missing first segment explains the gap before the first op that is there
    const firstPresentGapExplained = missingSegments.includes(1);
    for (const o of seen) {
      const at = { file: o.file, line: o.line, chain: c.chain, seq: o.seq, op: o.id };
      if (kept.has(o.seq)) {
        add({
          ...at,
          code: 'fork',
          message: `Line ${String(o.line)} is a second entry ${String(o.seq)} of chain ${short(c.chain)}: a copy of the project kept writing.`,
        });
        continue;
      }
      kept.set(o.seq, o);
      if (o.seq === expected) {
        while (kept.has(expected)) expected += 1;
        continue;
      }
      if (o.seq < expected) continue; // already named as out of order
      if (!reordered && [...Array(o.seq - expected).keys()].some((k) => seqs.has(expected + k))) {
        reordered = true;
        add({
          ...at,
          code: 'order',
          message: `Line ${String(o.line)} is out of order in chain ${short(c.chain)}.`,
        });
        continue;
      }
      if (!(firstPresentGapExplained && expected === 1)) {
        add({
          ...at,
          code: 'chain-gap',
          message: `Entries ${String(expected)} to ${String(o.seq - 1)} of chain ${short(c.chain)} are missing before line ${String(o.line)}.`,
        });
      }
      expected = o.seq + 1;
    }
    // prev links between consecutive seqs
    const ordered = [...kept.values()].sort((a, b) => a.seq - b.seq);
    ordered.forEach((o, i) => {
      const before = ordered[i - 1];
      const prev = o.raw.prev;
      const ok =
        o.seq === 1 ? prev === null : before?.seq === o.seq - 1 ? prev === before.id : true; // a gap: already named
      if (!ok) {
        add({
          code: 'fork',
          file: o.file,
          line: o.line,
          chain: c.chain,
          seq: o.seq,
          op: o.id,
          message: `Line ${String(o.line)} does not follow the entry before it in chain ${short(c.chain)}.`,
        });
      }
    });
    for (const o of ordered) byId.set(o.id, o);
    byChain.set(c.chain, ordered);
    const head = ordered[ordered.length - 1];
    chains.push({
      chain: c.chain,
      device: dev,
      ops: seen.length,
      segments: c.segments.length,
      head: head ? { seq: head.seq, id: head.id } : null,
    });
  }

  // ---- payloads removed: only with a redaction op naming them
  for (const o of stripped) {
    if (redactedIds.has(o.id)) {
      counts.redacted += 1;
      continue;
    }
    add({
      code: 'payload-missing',
      file: o.file,
      line: o.line,
      chain: o.raw.chain as string,
      seq: o.seq,
      op: o.id,
      message: `The content of line ${String(o.line)} was removed without a redaction.`,
    });
  }

  // ---- revoked devices: ops after the revocation
  for (const [dev, hlc] of revoked) {
    for (const [chain, ops] of byChain) {
      if (!chain.startsWith(`${dev}.`)) continue;
      for (const o of ops) {
        if ((str(o.raw.hlc) ?? '') > hlc) {
          add({
            code: 'revoked-device',
            file: o.file,
            line: o.line,
            chain,
            seq: o.seq,
            op: o.id,
            message: `Line ${String(o.line)} was written after its device was revoked.`,
          });
        }
      }
    }
  }

  // ---- references from other chains (deps) and checkpoints: truncated tails
  const truncated = new Map<string, number>();
  const missingRef = (chain: string, id: string, seq: number | undefined) => {
    if (byId.has(id)) return;
    const ops = byChain.get(chain);
    const lastSeq = ops?.[ops.length - 1]?.seq ?? 0;
    if (seq !== undefined && seq <= lastSeq) return; // present but different: a fork, named above
    const want = seq ?? lastSeq + 1;
    truncated.set(chain, Math.max(truncated.get(chain) ?? 0, want));
  };
  for (const ops of byChain.values()) {
    for (const o of ops) {
      const deps = o.raw.deps;
      if (deps && typeof deps === 'object' && !Array.isArray(deps)) {
        for (const [chain, id] of Object.entries(deps as Record<string, unknown>)) {
          if (typeof id === 'string') missingRef(chain, id, undefined);
        }
      }
    }
  }
  for (const cp of j.checkpoints) {
    if (!cp.raw) {
      add({ code: 'parse', file: cp.file, message: 'This checkpoint is not valid JSON.' });
      continue;
    }
    const dev = str(cp.raw.dev) ?? '';
    const key = keys.get(dev);
    const check = checkCheckpoint(cp.raw, key ?? undefined);
    if (!check.id || !check.root || (key && check.signature !== true)) {
      add({
        code: 'checkpoint-mismatch',
        file: cp.file,
        message: 'This checkpoint was changed after it was signed.',
      });
      continue;
    }
    const heads = cp.raw.heads as Record<string, unknown>;
    const wellFormed = Object.values(heads).every(
      (h) =>
        h !== null &&
        typeof h === 'object' &&
        typeof (h as ChainHead).id === 'string' &&
        Number.isInteger((h as ChainHead).seq),
    );
    if (!wellFormed) {
      add({
        code: 'checkpoint-mismatch',
        file: cp.file,
        message: 'This checkpoint lists a chain head that is not valid.',
      });
      continue;
    }
    for (const [chain, h] of Object.entries(heads as Record<string, ChainHead>)) {
      const ops = byChain.get(chain);
      const there = ops?.find((o) => o.seq === h.seq);
      if (there && there.id !== h.id) {
        add({
          code: 'checkpoint-mismatch',
          file: cp.file,
          chain,
          seq: h.seq,
          message: `Entry ${String(h.seq)} of chain ${short(chain)} is not the one this checkpoint signed.`,
        });
        continue;
      }
      if (!there) missingRef(chain, h.id, h.seq);
    }
  }
  for (const [chain, seq] of truncated) {
    // a missing segment in the middle already explains references into it
    const dropped = problems.some((p) => p.code === 'segment-missing' && p.chain === chain);
    const ops = byChain.get(chain) ?? [];
    const lastSeq = ops[ops.length - 1]?.seq ?? 0;
    if (dropped && seq <= lastSeq) continue;
    add({
      code: 'truncated',
      chain,
      seq,
      ...(ops.length
        ? {
            file: `${JOURNAL_OPS_DIR}/${chain}/${segmentFileName(j.chains.get(chain)?.segments.at(-1)?.n ?? 1)}`,
          }
        : {}),
      message: `Chain ${short(chain)} ends at entry ${String(lastSeq)}, but entry ${String(seq)} is referenced: its end was cut off.`,
    });
  }

  // ---- the audit head: the Merkle root over every chain's head
  const heads: Record<string, ChainHead> = {};
  for (const c of chains) if (c.head) heads[c.chain] = c.head;
  chains.sort((a, b) => (a.chain < b.chain ? -1 : a.chain > b.chain ? 1 : 0));
  return {
    ok: problems.length === 0,
    checkedAt: now.toISOString(),
    head: chains.length ? { root: merkleRoot(heads), count: counts.ops } : null,
    chains,
    counts,
    problems,
  };
}
