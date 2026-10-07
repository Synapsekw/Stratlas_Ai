/**
 * Backup and restore of a server's database as JSON lines (`aio.server-backup/1`): metadata,
 * projects, enrolled devices, invites, every op exactly as received, and the receipt chain.
 * Restore needs an empty store and checks the receipt chain and the counts before it reports
 * success. Blobs are files: back up the blob folder (or bucket) with the usual file tools.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import type { Op, Receipt, TeamProject } from '@aio/schema';
import { verifyReceipts } from './receipts';
import type { EnrolledDevice, Invite, Store } from './store/store';

export const BACKUP_SCHEMA = 'aio.server-backup/1';

type Line =
  | {
      schema: typeof BACKUP_SCHEMA;
      server: string;
      publicKey: string;
      createdAt: string;
      version: string;
    }
  | { t: 'meta'; key: string; value: string }
  | { t: 'project'; project: TeamProject }
  | { t: 'device'; device: EnrolledDevice }
  | { t: 'invite'; invite: Invite }
  | { t: 'op'; project: string; op: Op }
  | { t: 'receipt'; receipt: Receipt }
  | { t: 'end'; counts: Counts };

export interface Counts {
  projects: number;
  devices: number;
  invites: number;
  ops: number;
  receipts: number;
}

const META_KEYS = ['name'];

/** Write a backup of everything in `store` to `file`. */
export async function backup(
  store: Store,
  file: string,
  server: { id: string; publicKey: string; version: string },
  now = new Date(),
): Promise<Counts> {
  const out = createWriteStream(file, { flags: 'wx', mode: 0o600 });
  const write = async (line: Line) => {
    if (!out.write(`${JSON.stringify(line)}\n`)) await once(out, 'drain');
  };
  const counts: Counts = { projects: 0, devices: 0, invites: 0, ops: 0, receipts: 0 };
  try {
    await write({
      schema: BACKUP_SCHEMA,
      server: server.id,
      publicKey: server.publicKey,
      createdAt: now.toISOString(),
      version: server.version,
    });
    for (const key of META_KEYS) {
      const value = await store.meta(key);
      if (value !== null) await write({ t: 'meta', key, value });
    }
    const projects = await store.projects();
    for (const project of projects) {
      await write({ t: 'project', project });
      counts.projects++;
    }
    for (const device of await store.devices()) {
      await write({ t: 'device', device });
      counts.devices++;
    }
    for (const invite of await store.invites()) {
      await write({ t: 'invite', invite });
      counts.invites++;
    }
    for (const p of projects) {
      for await (const op of store.allOps(p.teamProjectId)) {
        await write({ t: 'op', project: p.teamProjectId, op });
        counts.ops++;
      }
    }
    for (let after = 0; ;) {
      const page = await store.receipts(after, 1000);
      for (const receipt of page) await write({ t: 'receipt', receipt });
      counts.receipts += page.length;
      const last = page[page.length - 1];
      if (!last) break;
      after = last.seq;
    }
    await write({ t: 'end', counts });
  } finally {
    out.end();
    await once(out, 'close');
  }
  return counts;
}

async function* readLines(file: string): AsyncGenerator<Line> {
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const text of lines) if (text.trim() !== '') yield JSON.parse(text) as Line;
}

/** Read a whole backup without writing anything: header, receipt chain and counts. */
export async function checkBackup(file: string): Promise<Counts> {
  const counts: Counts = { projects: 0, devices: 0, invites: 0, ops: 0, receipts: 0 };
  let header: Extract<Line, { schema: string }> | null = null;
  let end: Counts | null = null;
  const receipts: Receipt[] = [];
  for await (const line of readLines(file)) {
    if (!header) {
      // a line is untrusted input: check the header's schema at run time
      if (!('schema' in line) || (line.schema as string) !== BACKUP_SCHEMA)
        throw new Error('This is not a Team Server backup.');
      header = line;
      continue;
    }
    if (!('t' in line)) throw new Error('The backup has a line it does not know.');
    if (end) throw new Error('The backup has lines after its end.');
    if (line.t === 'project') counts.projects++;
    else if (line.t === 'device') counts.devices++;
    else if (line.t === 'invite') counts.invites++;
    else if (line.t === 'op') counts.ops++;
    else if (line.t === 'receipt') {
      receipts.push(line.receipt);
      counts.receipts++;
    } else if (line.t === 'end') end = line.counts;
  }
  if (!header) throw new Error('The backup is empty.');
  if (!end) throw new Error('The backup is cut short (no end line).');
  if (JSON.stringify(end) !== JSON.stringify(counts))
    throw new Error('The backup counts do not match its content.');
  const problems = verifyReceipts(receipts, header.publicKey);
  if (problems.length > 0)
    throw new Error(
      `The receipt chain in the backup does not verify (${problems.length} problems).`,
    );
  return counts;
}

/** Restore a backup into an empty store; a damaged file or a broken receipt chain writes nothing. */
export async function restore(store: Store, file: string): Promise<Counts> {
  if ((await store.projects()).length > 0 || (await store.lastReceipt()) !== null)
    throw new Error('Restore needs an empty database.');
  const counts = await checkBackup(file);
  let batch: { project: string; ops: Op[] } = { project: '', ops: [] };
  const flush = async () => {
    if (batch.ops.length > 0) await store.appendOps(batch.project, batch.ops);
    batch = { project: '', ops: [] };
  };
  let receipts: Receipt[] = [];
  for await (const line of readLines(file)) {
    if (!('t' in line)) continue;
    if (line.t === 'op') {
      if (batch.project !== line.project || batch.ops.length >= 1000) await flush();
      batch.project = line.project;
      batch.ops.push(line.op);
      continue;
    }
    await flush();
    if (line.t === 'meta') await store.setMeta(line.key, line.value);
    else if (line.t === 'project') await store.createProject(line.project);
    else if (line.t === 'device') await store.putDevice(line.device);
    else if (line.t === 'invite') await store.addInvite(line.invite);
    else if (line.t === 'receipt') {
      receipts.push(line.receipt);
      if (receipts.length >= 1000) {
        await store.appendReceipts(receipts);
        receipts = [];
      }
    }
  }
  await flush();
  await store.appendReceipts(receipts);
  return counts;
}
