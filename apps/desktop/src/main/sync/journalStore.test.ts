import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealDeviceRecord, signerFromSeed, type Signer } from '@aio/journal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJournalStore } from './journalStore';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-store-'));
  await mkdir(join(root, 'journal', 'devices'), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function record(signer: Signer, id = signer.device) {
  return sealDeviceRecord(
    {
      schema: 'aio.device/1',
      id,
      alg: 'ed25519',
      key: signer.publicKey,
      actor: `a_${'c'.repeat(26)}`,
      name: 'Rana Example',
      initials: 'RE',
      app: { name: 'test-app', version: '0.9.0' },
      createdAt: '2026-10-01T00:00:00.000Z',
      certs: [],
    },
    signer,
  );
}

const put = (name: string, rec: unknown) =>
  writeFile(join(root, 'journal', 'devices', name), JSON.stringify(rec), 'utf8');

describe('journal store device records', () => {
  it('reads a device record only when its key hashes to its id and its file name', async () => {
    const rana = signerFromSeed('11'.repeat(32));
    const mallory = signerFromSeed('22'.repeat(32));
    await put(`${rana.device}.json`, record(rana));
    // Mallory's key, self-signed, filed under (and claiming) another device's id
    const victim = signerFromSeed('33'.repeat(32)).device;
    await put(`${victim}.json`, record(mallory, victim));
    // a valid record filed under another name
    const omar = signerFromSeed('44'.repeat(32));
    const other = signerFromSeed('55'.repeat(32)).device;
    await put(`${other}.json`, record(omar));
    const devices = await createJournalStore().devices(root);
    expect(devices.map((d) => d.id)).toEqual([rana.device]);
  });
});
