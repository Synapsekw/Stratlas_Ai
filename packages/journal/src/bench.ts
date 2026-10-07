/**
 * The journal's own bench for the 1.0 budgets (`tools/release/budgets.mjs`, T8): the code paths
 * the desktop journal service runs, with TEST-ONLY keys made on the spot.
 *
 * - append: the chain writer seals and signs the next op, the line goes to the open segment and
 *   is synced, as `appendDurable` in `apps/desktop/src/main/journal.ts` does (the segment stays
 *   open between appends: T8 finding 4);
 * - open: what opening a journaled project adds, reading the cache meta and the tail of each
 *   chain's last segment, against reading the state file alone;
 * - verify: the parallel Verify of the whole folder.
 *
 * Merging (T4) is benched in `packages/merge/src/bench.test.ts`; `@aio/merge` depends on this
 * package, so it is not imported here.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JOURNAL_DEVICES_DIR, JOURNAL_OPS_DIR, segmentFileName } from '@aio/schema';
import { createChainWriter, tailOf, type ChainWriter } from './chain';
import { sealDeviceRecord } from './checkpoint';
import { verifyJournalParallel } from './parallel';
import { signerFromKey, type Signer } from './sign';

const ACTOR = 'a_benchbenchbenchbenchbenchb';
const REPLICA = 'r_benchbenchbench';

function testOnlySigner(): Signer {
  return signerFromKey(generateKeyPairSync('ed25519').privateKey);
}

/** The draft of op number `i`: an issue field edit, as the issue editor makes them. */
function draft(i: number) {
  return {
    kind: 'issue.patch' as const,
    target: { rec: 'issue', id: `i_bench${String(i % 50)}` },
    payload: { set: { severity: (i % 5) + 1 } },
    label: 'Edit severity',
  };
}

async function publishDevice(dir: string, signer: Signer): Promise<void> {
  const devDir = join(dir, ...JOURNAL_DEVICES_DIR.split('/'));
  await mkdir(devDir, { recursive: true });
  const rec = sealDeviceRecord(
    {
      schema: 'aio.device/1',
      id: signer.device,
      alg: 'ed25519',
      key: signer.publicKey,
      actor: ACTOR,
      name: 'Bench Example',
      initials: 'BE',
      app: { name: 'bench', version: '0.0.0' },
      createdAt: '2026-10-07T00:00:00.000Z',
      certs: [],
    },
    signer,
  );
  await writeFile(join(devDir, `${signer.device}.json`), `${JSON.stringify(rec, null, 2)}\n`);
}

/** Write `ops` ops of one chain into `dir` (segments rotate as the writer says). */
async function writeChain(dir: string, ops: number): Promise<{ signer: Signer; w: ChainWriter }> {
  const signer = testOnlySigner();
  await publishDevice(dir, signer);
  const chain = `${signer.device}.${REPLICA}`;
  const chainDir = join(dir, ...JOURNAL_OPS_DIR.split('/'), chain);
  await mkdir(chainDir, { recursive: true });
  const w = createChainWriter({ chain, actor: ACTOR, signer, tail: null });
  const bySegment = new Map<number, string[]>();
  for (let i = 0; i < ops; i++) {
    const r = w.next(draft(i));
    const lines = bySegment.get(r.segment) ?? [];
    lines.push(r.line);
    bySegment.set(r.segment, lines);
  }
  for (const [n, lines] of bySegment) {
    await writeFile(join(chainDir, segmentFileName(n)), lines.join(''), 'utf8');
  }
  return { signer, w };
}

/** Every file of `<dir>/journal/` as text, keyed by project-relative path (as the service reads). */
async function journalFiles(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (rel: string) => {
    for (const d of await readdir(join(dir, rel), { withFileTypes: true })) {
      const child = `${rel}/${d.name}`;
      if (d.isDirectory()) await walk(child);
      else out.set(child, await readFile(join(dir, child), 'utf8'));
    }
  };
  await walk('journal');
  return out;
}

/** `tools/release/budgets.mjs` JournalBench. */
export const journalBench = {
  name: 'T1 journal: chain writer, kept segment, parallel verify',

  async append(dir: string) {
    const signer = testOnlySigner();
    const chain = `${signer.device}.${REPLICA}`;
    const chainDir = join(dir, ...JOURNAL_OPS_DIR.split('/'), chain);
    await mkdir(chainDir, { recursive: true });
    const w = createChainWriter({ chain, actor: ACTOR, signer, tail: null });
    let handle: { segment: number; fh: Awaited<ReturnType<typeof open>> } | null = null;
    const append = async (i: number) => {
      const r = w.next(draft(i));
      if (handle?.segment !== r.segment) {
        await handle?.fh.close();
        handle = {
          segment: r.segment,
          fh: await open(join(chainDir, segmentFileName(r.segment)), 'a'),
        };
      }
      await handle.fh.write(r.line, null, 'utf8');
      await handle.fh.sync();
    };
    return Object.assign(append, {
      close: async () => {
        await handle?.fh.close();
      },
    });
  },

  async open(dir: string, ops: number) {
    await writeChain(dir, ops);
    const state = join(dir, 'issues.json');
    await writeFile(state, JSON.stringify({ schema: 'aio.issues/1', issues: [] }), 'utf8');
    const meta = join(dir, 'meta.json');
    await writeFile(meta, JSON.stringify({ schema: 'aio.journal-cache/1', files: {} }), 'utf8');
    const baseline = async () => {
      JSON.parse(await readFile(state, 'utf8'));
    };
    return {
      baseline,
      open: async () => {
        await baseline();
        JSON.parse(await readFile(meta, 'utf8'));
        const opsDir = join(dir, ...JOURNAL_OPS_DIR.split('/'));
        for (const chain of await readdir(opsDir)) {
          const segs = (await readdir(join(opsDir, chain)))
            .filter((n) => /^\d{6}\.jsonl$/.test(n))
            .sort();
          const last = segs[segs.length - 1];
          if (last)
            tailOf(Number(last.slice(0, 6)), await readFile(join(opsDir, chain, last), 'utf8'));
        }
      },
    };
  },

  async verify(dir: string, ops: number) {
    await writeChain(dir, ops);
    const files = await journalFiles(dir);
    return async () => {
      const report = await verifyJournalParallel(files);
      if (!report.ok)
        throw new Error(`Bench journal did not verify: ${report.problems[0]?.message ?? ''}`);
    };
  },
};
