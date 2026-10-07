# @aio/journal

The project journal (M9 stream T1): a signed, hash-chained, per-device log of every change.
Public API: `src/index.ts`. Ownership and dependencies: `docs/architecture/SPEC.md` section 2
(depends on schema). Format: `docs/architecture/data-conventions.md` section 17.

- `canonical.ts`: RFC 8785 JSON canonicalisation; every hash is SHA-256 over it.
- `hash.ts`: op ids, payload hashes, device ids from keys, base32 ids.
- `sign.ts`: Ed25519 through `node:crypto` over `<domain>\n<hash>`; a `Signer` is injected (the
  vault in main, a TEST-ONLY seed in tests). No other crypto dependency.
- `hlc.ts`: the hybrid logical clock (`<ms>.<counter>.<device>`), monotonic, receive rule, skew.
- `op.ts`: seal an op (ph, id, sig) and check one from its raw JSON.
- `segment.ts`: `.jsonl` segments with exact line numbers.
- `verify.ts`: Verify (T1 implements it against the golden fixtures in
  `packages/schema/src/__fixtures__/journal/`, whose `cases.json` names each expected problem).

Node only (main and the data process): the renderer never signs and never reads keys.
