// Reference journal bench: the T0 primitives of @aio/journal (seal with the hash chain, sign with
// Ed25519, append one segment line). It stands in until T1 exports `journalBench` from
// packages/journal/src/bench.ts; open, merge and verify wait for T1 and T4.
//
// The segment stays open between appends. Opening and closing it per op (`appendFile`) measured
// about 6 ms an op on a Windows workstation (antivirus scans each open), against 0.1 ms with the
// handle kept: an appender that reopens per op misses the 5 ms budget.
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createClock,
  sealOp,
  signerFromKey,
  writeSegmentLine,
} from '../../packages/journal/src/index.ts';

/** @type {import('./budgets.mjs').JournalBench} */
export const referenceBench = {
  name: 'reference: seal, sign, append',
  append: async (dir) => {
    const signer = signerFromKey(generateKeyPairSync('ed25519').privateKey);
    const chain = `${signer.device}.r_benchbenchbench`;
    const segDir = join(dir, 'journal', 'ops', chain);
    await mkdir(segDir, { recursive: true });
    const file = join(segDir, '000001.jsonl');
    const clock = createClock(signer.device);
    const handle = await open(file, 'a');
    let prev = null;
    const append = async (i) => {
      const op = sealOp(
        {
          v: 1,
          chain,
          dev: signer.device,
          act: 'a_benchbenchbenchbenchbenchb',
          seq: i + 1,
          hlc: clock.tick(),
          prev,
          kind: 'issue.update',
          target: { rec: 'issue', id: `issue-${String(i % 50)}` },
          label: 'Edit severity',
        },
        { fields: { severity: (i % 5) + 1 } },
        signer,
      );
      prev = op.id;
      await handle.write(writeSegmentLine(op));
    };
    append.close = () => handle.close();
    return append;
  },
};
