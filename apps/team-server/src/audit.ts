/**
 * `export-audit` and `verify`: a project's history as the server holds it, in the journal's own
 * folder layout (`journal/ops/<chain>/NNNNNN.jsonl`, data-conventions section 17) so the app's
 * **Verify** reads the same files, plus the server's receipt chain and its public key.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkOp, verifySignature } from '@aio/journal';
import { SEGMENT_MAX_OPS, segmentFileName, type Op, type Receipt } from '@aio/schema';
import type { ServerIdentity } from './identity';
import { verifyReceipts } from './receipts';
import { TeamState, TEAM_KINDS } from './roles';
import type { Store } from './store/store';

export const AUDIT_EXPORT_SCHEMA = 'aio.server-audit/1';

export interface AuditSummary {
  schema: typeof AUDIT_EXPORT_SCHEMA;
  server: string;
  publicKey: string;
  project: string;
  exportedAt: string;
  ops: number;
  chains: number;
  receipts: number;
  heads: Record<string, { seq: number; id: string }>;
}

/** Write the export into `dir` (which must be empty or new). */
export async function exportAudit(
  store: Store,
  identity: ServerIdentity,
  project: string,
  dir: string,
  now = new Date(),
): Promise<AuditSummary> {
  if (!(await store.project(project))) throw new Error(`This server holds no project ${project}.`);
  const byChain = new Map<string, Op[]>();
  const ids = new Set<string>();
  for await (const op of store.allOps(project)) {
    const list = byChain.get(op.chain) ?? [];
    list.push(op);
    byChain.set(op.chain, list);
    ids.add(op.id);
  }
  for (const [chain, ops] of byChain) {
    ops.sort((a, b) => a.seq - b.seq);
    const folder = join(dir, 'journal', 'ops', chain);
    mkdirSync(folder, { recursive: true });
    for (let i = 0; i * SEGMENT_MAX_OPS < ops.length; i++) {
      const part = ops.slice(i * SEGMENT_MAX_OPS, (i + 1) * SEGMENT_MAX_OPS);
      writeFileSync(
        join(folder, segmentFileName(i + 1)),
        part.map((o) => `${JSON.stringify(o)}\n`).join(''),
      );
    }
  }
  // the public records of the enrolled devices that wrote ops (as the journal keeps them)
  const writers = new Set([...byChain.values()].flat().map((o) => o.dev));
  const devicesDir = join(dir, 'journal', 'devices');
  mkdirSync(devicesDir, { recursive: true });
  for (const d of await store.devices())
    if (writers.has(d.device))
      writeFileSync(
        join(devicesDir, `${d.device}.json`),
        `${JSON.stringify(d.record, null, 2)}
`,
      );
  // the whole receipt chain (hashes only), so it verifies; this project's ops are marked
  const receipts: string[] = [];
  let count = 0;
  for (let after = 0; ;) {
    const page = await store.receipts(after, 1000);
    for (const r of page) {
      receipts.push(JSON.stringify({ ...r, thisProject: ids.has(r.op) }));
      if (ids.has(r.op)) count++;
    }
    const last = page[page.length - 1];
    if (!last) break;
    after = last.seq;
  }
  writeFileSync(join(dir, 'receipts.jsonl'), receipts.map((r) => `${r}\n`).join(''));
  const summary: AuditSummary = {
    schema: AUDIT_EXPORT_SCHEMA,
    server: identity.id,
    publicKey: identity.publicKey,
    project,
    exportedAt: now.toISOString(),
    ops: ids.size,
    chains: byChain.size,
    receipts: count,
    heads: Object.fromEntries(
      [...byChain].flatMap(([chain, ops]) => {
        const last = ops[ops.length - 1];
        return last ? [[chain, { seq: last.seq, id: last.id }]] : [];
      }),
    ),
  };
  writeFileSync(join(dir, 'server-audit.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

export interface AuditVerdict {
  ok: boolean;
  ops: number;
  chains: number;
  receipts: number;
  problems: string[];
}

/** Check an export: op hashes, signatures and chains, every op countersigned, the receipt chain. */
export function verifyAuditExport(dir: string): AuditVerdict {
  const problems: string[] = [];
  const summary = JSON.parse(readFileSync(join(dir, 'server-audit.json'), 'utf8')) as AuditSummary;
  const opsDir = join(dir, 'journal', 'ops');
  const all: { op: Op; raw: Record<string, unknown>; where: string }[] = [];
  const chains = readdirSync(opsDir).sort();
  for (const chain of chains) {
    let prev: string | null = null;
    let seq = 0;
    for (const file of readdirSync(join(opsDir, chain)).sort()) {
      const lines = readFileSync(join(opsDir, chain, file), 'utf8').split('\n');
      lines.forEach((text, i) => {
        if (text.trim() === '') return;
        const where = `${chain}/${file} line ${i + 1}`;
        const raw = JSON.parse(text) as Record<string, unknown>;
        const op = raw as unknown as Op;
        const check = checkOp(raw);
        if (!check.id) problems.push(`${where}: the op does not match its id`);
        if (check.payload === false) problems.push(`${where}: the payload does not match its hash`);
        if (op.seq !== seq + 1 || op.prev !== prev)
          problems.push(`${where}: the chain is broken (seq ${op.seq})`);
        prev = op.id;
        seq = op.seq;
        all.push({ op, raw, where });
      });
    }
  }
  // signatures: keys from the project's own member ops, in clock order
  const team = new TeamState();
  for (const { op } of [...all].sort((a, b) => (a.op.hlc < b.op.hlc ? -1 : 1)))
    if (TEAM_KINDS.has(op.kind)) team.apply(op);
  const records = new Map<string, { actor: string; key: string }>();
  const devicesDir = join(dir, 'journal', 'devices');
  for (const f of readdirSync(devicesDir).filter((n) => n.endsWith('.json'))) {
    const r = JSON.parse(readFileSync(join(devicesDir, f), 'utf8')) as {
      id: string;
      actor: string;
      key: string;
    };
    records.set(r.id, { actor: r.actor, key: r.key });
  }
  for (const { op, where } of all) {
    const fromRecord = records.get(op.dev);
    const key =
      team.deviceKey(op.dev)?.key ?? (fromRecord?.actor === op.act ? fromRecord.key : undefined);
    if (!key) problems.push(`${where}: no member op names the device that signed it`);
    else if (typeof op.sig !== 'string' || !verifySignature(key, 'aio.op/1', op.id, op.sig))
      problems.push(`${where}: the signature does not verify`);
  }
  const receipts = readFileSync(join(dir, 'receipts.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Receipt & { thisProject?: boolean });
  const plain = receipts.map((r) => {
    const copy: Partial<typeof r> = { ...r };
    delete copy.thisProject;
    return copy;
  });
  for (const p of verifyReceipts(plain, summary.publicKey))
    problems.push(`receipt ${p.seq}: ${p.problem}`);
  const countersigned = new Set(receipts.map((r) => r.op));
  for (const { op, where } of all)
    if (!countersigned.has(op.id)) problems.push(`${where}: the server has no receipt for it`);
  return {
    ok: problems.length === 0,
    ops: all.length,
    chains: chains.length,
    receipts: receipts.filter((r) => r.thisProject).length,
    problems,
  };
}
