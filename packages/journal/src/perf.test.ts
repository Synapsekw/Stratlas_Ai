import { generateKeyPairSync } from 'node:crypto';
import { segmentFileName } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { createChainWriter, tailOf } from './chain';
import { sealDeviceRecord } from './checkpoint';
import { loadJournal } from './load';
import { auditEntries, pageEntries } from './query';
import { signerFromKey } from './sign';
import { verifyJournalParallel } from './parallel';
import { verifyJournal } from './verify';

/**
 * Journal budgets (M9 plan, 1.0 checklist): 100,000 ops open from the tail in well under the
 * snapshot budget (200 ms), replay into audit entries under 3 s, Verify under 10 s, append under
 * 5 ms. Machines vary, so CI gets the margin the plan's numbers already have.
 */
const N = 100_000;
const signer = signerFromKey(generateKeyPairSync('ed25519').privateKey);
const chain = `${signer.device}.r_aaaaaaaaaaaaaaaa`;
const actor = `a_${'b'.repeat(26)}`;

function bigJournal() {
  const w = createChainWriter({ chain, actor, signer, tail: null, now: () => 1_790_000_000_000 });
  const segments = new Map<number, string[]>();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const { line, segment } = w.next({
      kind: 'issue.patch',
      target: { rec: 'issue', id: `i_${String(i % 500)}` },
      payload: { set: { severity: i % 5, note: `Note ${String(i)}` }, was: { severity: 1 } },
      label: `F${String(i % 500).padStart(3, '0')} severity`,
    });
    const s = segments.get(segment) ?? [];
    s.push(line);
    segments.set(segment, s);
  }
  const perAppendMs = (performance.now() - t0) / N;
  const files = new Map<string, string>();
  files.set(
    `journal/devices/${signer.device}.json`,
    JSON.stringify(
      sealDeviceRecord(
        {
          schema: 'aio.device/1',
          id: signer.device,
          alg: 'ed25519',
          key: signer.publicKey,
          actor,
          name: 'Rana Example',
          initials: 'RE',
          app: { name: 'test-app', version: '0.9.0' },
          createdAt: '2026-10-01T00:00:00.000Z',
          certs: [],
        },
        signer,
      ),
    ),
  );
  for (const [n, lines] of segments) {
    files.set(`journal/ops/${chain}/${segmentFileName(n)}`, lines.join(''));
  }
  return { files, perAppendMs, lastSegment: Math.max(...segments.keys()) };
}

// The budgets are for release hardware and are enforced in the nightly budget run
// (QUADRION_BUDGETS=1). Shared CI runners are slower and noisier (the parallel verify takes 10 to
// 13 s there), so an ordinary run only catches gross regressions, at five times the budget.
const budget = (ms: number) =>
  (process.env.QUADRION_BUDGETS ?? process.env.STRATLAS_BUDGETS) === '1' ? ms : ms * 5;

describe('journal budgets at 100,000 ops', () => {
  const big = bigJournal();

  it('seals an op well under the 5 ms append budget (fsync is main)', () => {
    expect(big.lastSegment).toBeGreaterThanOrEqual(10);
    expect(big.perAppendMs).toBeLessThan(budget(1));
  });

  it('opens from the tail of the last segment in under 200 ms', () => {
    const t0 = performance.now();
    const tail = tailOf(
      big.lastSegment,
      big.files.get(`journal/ops/${chain}/${segmentFileName(big.lastSegment)}`) ?? '',
    );
    expect(performance.now() - t0).toBeLessThan(budget(200));
    expect(tail?.seq).toBe(N);
  });

  it('replays every op into audit entries in under 3 s', () => {
    const t0 = performance.now();
    const entries = auditEntries(loadJournal(big.files));
    const page = pageEntries(entries, { target: { rec: 'issue', id: 'i_7' } }, 50);
    const ms = performance.now() - t0;
    expect(entries).toHaveLength(N);
    expect(page.entries).toHaveLength(50);
    expect(ms).toBeLessThan(budget(3000));
  });

  it('verifies every op in under 10 s, signatures on worker threads', async () => {
    const t0 = performance.now();
    const r = await verifyJournalParallel(big.files, { now: new Date(1_790_000_000_000) });
    expect(performance.now() - t0).toBeLessThan(budget(10_000));
    expect(r.problems).toEqual([]);
    expect(r.counts.signed).toBe(N);
  }, 30_000);

  it('gives the same report on worker threads as on one thread', async () => {
    const small = new Map(
      [...big.files].filter(([p]) => !p.startsWith('journal/ops/') || p.endsWith('000001.jsonl')),
    );
    const [line] = (small.get(`journal/ops/${chain}/${segmentFileName(1)}`) ?? '').split('\n');
    const forged = JSON.parse(line ?? '{}') as { sig: string };
    forged.sig = `${forged.sig.slice(0, 10)}${forged.sig[10] === 'A' ? 'B' : 'A'}${forged.sig.slice(11)}`;
    const path = `journal/ops/${chain}/${segmentFileName(1)}`;
    small.set(path, (small.get(path) ?? '').replace(line ?? '', JSON.stringify(forged)));
    const now = new Date(1_790_000_000_000);
    const one = verifyJournal(small, { now });
    expect(one.problems.map((p) => p.code)).toEqual(['bad-signature']);
    expect(await verifyJournalParallel(small, { now })).toEqual(one);
  }, 30_000);
});
