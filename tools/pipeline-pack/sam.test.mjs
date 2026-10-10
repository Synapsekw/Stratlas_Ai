import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installSam, SAM_MODEL, samCard } from './sam.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');

/** A model of two tiny files and a fetch that serves them (counting the calls). */
function fake(bodies) {
  const files = Object.fromEntries(
    Object.entries(bodies).map(([name, body]) => [
      name,
      { url: `https://example.test/${name}`, size: body.length, sha256: sha(Buffer.from(body)) },
    ]),
  );
  const model = { ...SAM_MODEL, files };
  const calls = [];
  const fetchImpl = (url) => {
    calls.push(url);
    const name = url.split('/').pop();
    return Promise.resolve({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(bodies[name] ?? '').buffer),
    });
  };
  return { model, calls, fetchImpl };
}

describe('the pack boundary model', () => {
  const dirs = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'aio-sam-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('pins MobileSAM with an accepted licence and the encoder layout the app reads', () => {
    expect(SAM_MODEL.licence).toBe('Apache-2.0');
    expect(SAM_MODEL.input).toBe('hwc-255');
    for (const f of Object.values(SAM_MODEL.files)) {
      expect(f.url).toMatch(
        /^https:\/\/huggingface\.co\/PulpCut\/mobilesam-onnx\/resolve\/[0-9a-f]{40}\//,
      );
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const card = samCard();
    expect(card).toMatchObject({ name: 'MobileSAM', licence: 'Apache-2.0', input: 'hwc-255' });
    expect(Object.keys(card.sha256)).toEqual(['encoder.onnx', 'decoder.onnx']);
  });

  it('writes the checked files and the card, and uses the cache the second time', async () => {
    const { model, calls, fetchImpl } = fake({ 'encoder.onnx': 'enc', 'decoder.onnx': 'dec' });
    const cache = tmp();
    const dest = join(tmp(), 'models', 'sam');
    const r = await installSam({ cache, dest, fetchImpl, model });
    expect(r.bytes).toBe(6);
    expect(readFileSync(join(dest, 'encoder.onnx'), 'utf8')).toBe('enc');
    expect(JSON.parse(readFileSync(join(dest, 'model.json'), 'utf8'))).toMatchObject({
      name: 'MobileSAM',
      input: 'hwc-255',
    });
    expect(calls).toHaveLength(2);
    const again = join(tmp(), 'sam');
    await installSam({ cache, dest: again, fetchImpl, model });
    expect(calls).toHaveLength(2);
    expect(existsSync(join(again, 'decoder.onnx'))).toBe(true);
  });

  it('refuses a file whose SHA-256 is not the pinned one', async () => {
    const { model, fetchImpl } = fake({ 'encoder.onnx': 'enc', 'decoder.onnx': 'dec' });
    const bad = {
      ...model,
      files: {
        ...model.files,
        'decoder.onnx': { ...model.files['decoder.onnx'], sha256: '0'.repeat(64) },
      },
    };
    await expect(
      installSam({ cache: tmp(), dest: join(tmp(), 'sam'), fetchImpl, model: bad }),
    ).rejects.toThrow(/decoder\.onnx .* has SHA-256 .* expected 0{64}/);
  });
});
