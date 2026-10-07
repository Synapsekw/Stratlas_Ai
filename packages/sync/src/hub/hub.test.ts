import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@aio/journal';
import type { TeamProject } from '@aio/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { patches, testDevice } from '../testkit';
import { HubUnreachable, createHubTransport, nodeHubFs, type HubFs } from './index';

const TEAM = 't_bbbbbbbbbbbbbbbbbbbbbbbbbb';
const team: TeamProject = {
  schema: 'aio.team/1',
  teamProjectId: TEAM,
  name: 'Pipe rack review',
  createdAt: '2026-10-07T08:00:00.000Z',
  createdBy: 'a_aaaaaaaaaaaaaaaaaaaaaaaaaa',
};
const rana = testDevice('Rana Example', 'RE');
const omar = testDevice('Omar Sample', 'OS');
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-hub-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const hubFor = (dev = rana, extra: Partial<Parameters<typeof createHubTransport>[0]> = {}) =>
  createHubTransport({ root, team: TEAM, device: dev.signer.device, ...extra });

describe('hub folder', () => {
  it('makes a folder a hub with aio-hub.json and lists its team projects', async () => {
    const hub = hubFor();
    expect(await hub.check()).toBeNull();
    const file = await hub.ensure(team);
    expect(file.projects).toEqual([{ teamProjectId: TEAM, name: 'Pipe rack review' }]);
    expect(JSON.parse(await readFile(join(root, 'aio-hub.json'), 'utf8'))).toMatchObject({
      schema: 'aio.hub/1',
    });
    expect(await hubFor(omar).projects()).toEqual([team]);
    // a second ensure keeps the same hub id
    expect((await hubFor(omar).ensure(team)).id).toBe(file.id);
  });

  it('writes op chunks once, under a temp name then renamed; pushes are idempotent', async () => {
    const ops = patches(rana, 3);
    const hub = hubFor();
    const first = await hub.pushOps(ops);
    expect(first.accepted).toHaveLength(3);
    const dir = join(root, 'projects', TEAM, 'ops', rana.chain);
    expect(await readdir(dir)).toEqual(['000001-000003.jsonl']);
    const again = await hub.pushOps(ops);
    expect(again).toMatchObject({ accepted: [], duplicates: ops.map((o) => o.id) });
    const more = patches(rana, 2, ops.at(-1));
    await hub.pushOps([...ops, ...more]);
    expect((await readdir(dir)).sort()).toEqual(['000001-000003.jsonl', '000004-000005.jsonl']);
    expect(await hubFor(omar).heads()).toEqual({ [rana.chain]: { seq: 5, id: more[1]?.id } });
  });

  it('another device pulls what one pushed, only after the heads it has', async () => {
    const ops = patches(rana, 4);
    await hubFor().pushOps(ops);
    const omarHub = hubFor(omar);
    expect((await omarHub.pullOps({})).ops.map((o) => o.id)).toEqual(ops.map((o) => o.id));
    const since = { [rana.chain]: { seq: 2, id: ops[1]?.id ?? '' } };
    expect((await omarHub.pullOps(since)).ops.map((o) => o.seq)).toEqual([3, 4]);
  });

  it('refuses a push that would leave a gap in a chain', async () => {
    const ops = patches(rana, 4);
    const r = await hubFor().pushOps(ops.slice(2));
    expect(r.refused.map((x) => x.code)).toEqual(['gap', 'gap']);
    expect(await hubFor().heads()).toEqual({});
  });

  it('reads a cloud-drive conflicted copy, dedupes by id and reports it', async () => {
    const ops = patches(omar, 3);
    await hubFor(omar).pushOps(ops.slice(0, 2));
    const dir = join(root, 'projects', TEAM, 'ops', omar.chain);
    const copy = "000001-000002 (Omar Sample's conflicted copy 2026-10-07).jsonl";
    await writeFile(join(dir, copy), ops.map((o) => `${JSON.stringify(o)}\n`).join(''));
    const pulled = await hubFor().pull({});
    expect(pulled.ops.map((o) => o.seq)).toEqual([1, 2, 3]);
    expect(pulled.conflictCopies).toEqual([`projects/${TEAM}/ops/${omar.chain}/${copy}`]);
  });

  it('a share that goes away mid-write leaves only a temp file nobody reads, swept later', async () => {
    const failing: HubFs = {
      ...nodeHubFs,
      rename: () => Promise.reject(Object.assign(new Error('gone'), { code: 'ENOTCONN' })),
    };
    const hub = hubFor(rana, { fs: failing });
    await expect(hub.pushOps(patches(rana, 2))).rejects.toBeInstanceOf(HubUnreachable);
    const dir = join(root, 'projects', TEAM, 'ops', rana.chain);
    expect(await readdir(dir)).toEqual([]);
    // the temp file was removed, or would be ignored and swept: plant one and age it
    const temp = join(dir, `.000001-000002.jsonl.${rana.signer.device.slice(0, 12)}.abcd1234.tmp`);
    await writeFile(temp, 'half');
    expect((await hubFor(omar).pull({})).ops).toEqual([]);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(temp, old, old);
    expect(await hubFor().sweep()).toBe(1);
    await expect(stat(temp)).rejects.toThrow();
  });

  it('a share that does not answer counts as not reachable within the time limit', async () => {
    const hanging: HubFs = { ...nodeHubFs, stat: () => new Promise(() => undefined) };
    const hub = hubFor(rana, { fs: hanging, timeoutMs: 50 });
    await expect(hub.check()).rejects.toBeInstanceOf(HubUnreachable);
    await expect(
      createHubTransport({
        root: join(root, 'missing'),
        team: TEAM,
        device: rana.signer.device,
      }).check(),
    ).rejects.toBeInstanceOf(HubUnreachable);
  });

  it('presence shows others with a fresh heartbeat and expires after two minutes', async () => {
    let now = Date.parse('2026-10-07T09:00:00.000Z');
    const at = () => new Date(now).toISOString();
    await hubFor(omar).putPresence({
      schema: 'aio.presence/1',
      device: omar.signer.device,
      actor: omar.actor,
      name: 'Omar Sample',
      initials: 'OS',
      at: at(),
      open: { kind: 'issue', id: 'i_f03' },
    });
    const hub = hubFor(rana, { now: () => now });
    expect((await hub.presence()).map((p) => p.name)).toEqual(['Omar Sample']);
    now += 3 * 60 * 1000;
    expect(await hub.presence()).toEqual([]);
    // never lists itself
    expect(await hubFor(omar, { now: () => now - 3 * 60 * 1000 }).presence()).toEqual([]);
  });

  it('stores blobs once by hash, checks them, and reads ranges back', async () => {
    const data = Buffer.from('0123456789'.repeat(100));
    const sha = sha256Hex(data);
    const ref = { sha256: sha, size: data.length, path: 'photos/a.jpg', role: 'source' as const };
    const hub = hubFor();
    const once = async function* () {
      await Promise.resolve();
      yield data;
    };
    await hub.putBlob(ref, once());
    expect(await hubFor(omar).hasBlobs([sha, 'f'.repeat(64)])).toEqual(new Set([sha]));
    const parts: Buffer[] = [];
    for await (const c of (await hub.getBlob(sha, { start: 10, end: 20 })) ?? [])
      parts.push(Buffer.from(c));
    expect(Buffer.concat(parts).toString()).toBe('0123456789');
    await expect(hub.putBlob({ ...ref, sha256: 'e'.repeat(64) }, once())).rejects.toThrow(
      /does not match/,
    );
    expect(await hub.hasBlobs(['e'.repeat(64)])).toEqual(new Set());
  });

  it('keeps each device record in its own file', async () => {
    await hubFor().putDevice(rana.record);
    await hubFor(omar).putDevice(omar.record);
    const ids = (await hubFor().devices()).map((d) => d.id).sort();
    expect(ids).toEqual([rana.signer.device, omar.signer.device].sort());
  });
});
