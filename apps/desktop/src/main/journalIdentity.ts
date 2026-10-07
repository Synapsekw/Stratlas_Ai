/**
 * Who signs the journal on this machine, until T2's identity service lands (M9 integration swaps
 * this provider for T2's `identity:*` module; the interface stays).
 *
 * - The actor is read from T2's `userData/identity.json` when it exists; otherwise a provisional
 *   actor is kept in `userData/journal-cache/actor.json` (name from the OS account).
 * - The Ed25519 key lives only in the OS vault (`DEVICE_KEY_ACCOUNT`), as PKCS#8 DER in base64url.
 *   A vault value this module cannot read is never overwritten: the journal is then written
 *   unsigned (still chained) and Verify says so.
 */
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomId, signerFromKey, type Signer } from '@aio/journal';
import { DEVICE_KEY_ACCOUNT, IDENTITY_FILE, Identity } from '@aio/schema';
import { z } from 'zod';
import { readJson, writeJsonAtomic } from './fsutil';
import type { KeyEntry } from './keys';

export interface JournalIdentity {
  actor: string;
  name: string;
  initials: string;
  /** This device: its id and raw public key (base64url). */
  device: { id: string; publicKey: string };
  /** Null when the vault is not available: ops are written unsigned. */
  signer: Signer | null;
  app: { name: string; version: string };
}

const Provisional = z.object({
  actor: z.string().regex(/^a_[a-z2-7]{26}$/),
  name: z.string().min(1).max(80),
  initials: z.string().min(1).max(4),
});

/** Up to three initials from the first letters of the first and last words (any script). */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/[\s._-]+/u)
    .filter((w) => /\p{L}/u.test(w));
  const letter = (w: string | undefined) => /\p{L}/u.exec(w ?? '')?.[0] ?? '';
  const first = letter(words[0]) || 'X';
  const last = words.length > 1 ? letter(words[words.length - 1]) : '';
  return `${first}${last}`.toLocaleUpperCase();
}

export function createLocalIdentity(opts: {
  userData: string;
  osUser: () => string | undefined;
  /** The vault entry for the device key (service = brand app id; `.isolated` in tests). */
  entry: (account: string) => KeyEntry;
  app: { name: string; version: string };
}): () => Promise<JournalIdentity> {
  let cached: Promise<JournalIdentity> | null = null;

  async function actor(): Promise<z.infer<typeof Provisional>> {
    try {
      const t2 = Identity.safeParse(await readJson(join(opts.userData, IDENTITY_FILE)));
      if (t2.success) {
        return { actor: t2.data.actor, name: t2.data.name, initials: t2.data.initials };
      }
    } catch {
      // not there or not readable: the provisional actor below
    }
    const file = join(opts.userData, 'journal-cache', 'actor.json');
    try {
      const p = Provisional.safeParse(await readJson(file));
      if (p.success) return p.data;
    } catch {
      // rewritten below
    }
    const name = (opts.osUser() ?? '').trim().slice(0, 80) || 'Unknown author';
    const made = { actor: randomId('a_', 26), name, initials: initialsOf(name) };
    await mkdir(join(opts.userData, 'journal-cache'), { recursive: true });
    await writeJsonAtomic(file, made);
    return made;
  }

  function signer(): Signer | null {
    try {
      const e = opts.entry(DEVICE_KEY_ACCOUNT);
      const stored = e.getPassword();
      if (stored) {
        try {
          return signerFromKey(
            createPrivateKey({
              key: Buffer.from(stored, 'base64url'),
              format: 'der',
              type: 'pkcs8',
            }),
          );
        } catch {
          console.warn('Journal: the device key in the vault is not readable; writing unsigned.');
          return null;
        }
      }
      const { privateKey } = generateKeyPairSync('ed25519');
      const der = privateKey.export({ format: 'der', type: 'pkcs8' });
      e.setPassword(der.toString('base64url'));
      return signerFromKey(privateKey);
    } catch (e) {
      console.warn(
        `Journal: the key vault is not available (${e instanceof Error ? e.name : 'error'}); writing unsigned.`,
      );
      return null;
    }
  }

  return () => {
    cached ??= (async () => {
      const who = await actor();
      const s = signer();
      // without the vault, a key for this session only names the device; nothing is signed
      const named = s ?? signerFromKey(generateKeyPairSync('ed25519').privateKey);
      return {
        ...who,
        device: { id: named.device, publicKey: named.publicKey },
        signer: s,
        app: opts.app,
      };
    })();
    return cached;
  };
}
