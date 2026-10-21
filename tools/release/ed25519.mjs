#!/usr/bin/env node
// Ed25519 keys and detached signatures for the update feed and the pipeline packs (the app checks
// them against `signing.updateFeedKey` and `signing.pipelinePackKey` in packages/brand/brand.json).
//
//   node tools/release/ed25519.mjs keygen <private.pem>
//       Make a key pair. The private key goes to <private.pem> (keep it offline, never in git);
//       the public key is printed as base64 of its raw 32 bytes, the value for brand.json.
//   node tools/release/ed25519.mjs sign <private.pem> <file>
//       Write <file>.sig: base64 of the signature over the file's exact bytes.
//   node tools/release/ed25519.mjs verify <public-base64> <file>
//       Check <file>.sig (exit 1 when it does not hold).
//
// The update feed is signed after tools/release/feed.mjs wrote it (stratlas-update.json.sig sits
// next to it); a pack is signed by tools/pipeline-pack/build.mjs when QUADRION_PACK_SIGNING_KEY
// names the private key (manifest.sig inside the pack).
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Base64 of a public key's raw 32 bytes. */
export function publicKeyBase64(publicKey) {
  return Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
}

/** A new pair: the private key as PKCS#8 PEM, the public key as raw base64. */
export function keygen() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: publicKeyBase64(publicKey),
  };
}

/** Base64 signature of `data` with the PEM private key. */
export function signBytes(privatePem, data) {
  return sign(null, data, createPrivateKey(privatePem)).toString('base64');
}

/** Whether `signature` (base64) holds for `data` under the raw base64 public key. */
export function verifyBytes(publicBase64, data, signature) {
  const raw = Buffer.from(publicBase64.trim(), 'base64');
  if (raw.length !== 32) return false;
  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
    format: 'jwk',
  });
  return verify(null, data, key, Buffer.from(signature.trim(), 'base64'));
}

/** Write `<file>.sig` next to `file`; returns its path. */
export function signFile(privatePem, file) {
  const out = `${file}.sig`;
  writeFileSync(out, `${signBytes(privatePem, readFileSync(file))}\n`);
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'keygen' && a) {
    const k = keygen();
    writeFileSync(a, k.privatePem, { mode: 0o600, flag: 'wx' });
    process.stdout.write(`private key: ${a}\npublic key (brand.json): ${k.publicKey}\n`);
  } else if (cmd === 'sign' && a && b) {
    process.stdout.write(`${signFile(readFileSync(a, 'utf8'), b)}\n`);
  } else if (cmd === 'verify' && a && b) {
    const ok = verifyBytes(a, readFileSync(b), readFileSync(`${b}.sig`, 'utf8'));
    process.stdout.write(ok ? 'signature holds\n' : 'signature does NOT hold\n');
    process.exitCode = ok ? 0 : 1;
  } else {
    process.stderr.write(
      'usage: ed25519.mjs keygen <private.pem> | sign <private.pem> <file> | verify <public-base64> <file>\n',
    );
    process.exitCode = 2;
  }
}
