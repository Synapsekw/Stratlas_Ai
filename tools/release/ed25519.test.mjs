import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ed25519Valid } from '../../apps/desktop/src/main/ed25519';
import { keygen, signFile, verifyBytes } from './ed25519.mjs';

describe('ed25519 release signing', () => {
  it('signs a file the app accepts under the printed public key, and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-ed25519-'));
    try {
      const k = keygen();
      const file = join(dir, 'stratlas-update.json');
      writeFileSync(file, '{"schema":"aio.update-feed/1"}\n');
      const sig = readFileSync(signFile(k.privatePem, file), 'utf8');
      expect(verifyBytes(k.publicKey, readFileSync(file), sig)).toBe(true);
      // the app's own check (main, ed25519.ts) agrees
      expect(ed25519Valid(readFileSync(file), sig, k.publicKey)).toBe(true);
      expect(ed25519Valid(Buffer.from('changed'), sig, k.publicKey)).toBe(false);
      expect(ed25519Valid(readFileSync(file), sig, keygen().publicKey)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
