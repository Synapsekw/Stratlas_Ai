# ADR 0006: Identity and device keys

- Status: **Draft, awaiting founder sign-off** (7 Oct 2026). Written at M9 T0 with the recommended defaults of the M9 plan's founder decisions 4 and 5; the founder may override them.
- Deciders: founder; integration lead (M9)
- Contracts: `@aio/schema` `identity.ts`; code: `apps/desktop/src/main/identity.ts` (T2), `@aio/journal` `sign.ts`

## Context

Today "Your name on issues" is free text in the renderer's `localStorage` (`stratlas.author`), defaulting to the OS account. It has no stable id and no initials, and anyone can type any name. M9 needs to know which person and which machine made each op, without accounts (M10 brings those) and without the network.

## Decision

1. **Actor.** A person is an actor: `a_` plus 128 random bits in base32, a display name, initials (first letters of the first and last words, up to 3 letters, any script, editable, unique within a team by a digit suffix) and an optional email, in userData `identity.json` (`aio.identity/1`). It is migrated once from the stored author, with the OS account as the fallback. The actor id never changes. Free-text author fields (`Issue.author`, `ChangeReview.by`, ...) keep receiving the display name, so old readers stay right.
2. **Device.** Each machine has an Ed25519 key pair made with `node:crypto` on first need. The private key lives only in the OS vault (Windows Credential Manager, macOS Keychain; account `device-signing`; tests use the isolated service); it never appears in a project, an exchange file, a log, a diagnostics bundle or the renderer. The device id is `d_` plus the base32 SHA-256 of the public key, so it cannot be claimed with another key. The public record (`aio.device/1`) goes into each project's `journal/devices/`, self-signed.
3. **Verification ladder** (decision 5), shown as a badge: `self` (self-asserted), `owner` (an owner's device signed a certificate, `aio.cert/1`), `server` (enrolled with a team server), `account` (M10, a `member.link` op with a certificate from the account issuer). **Recommended default: self-asserted names count**, with an "unverified" badge and owner certification optional. The team policy field `minVerification` (default `self`) can require more without changing any record.
4. **Identity cards** (`.aioid`, `aio.idcard/1`): name, initials, actor and device key, self-signed. A person joins a team in file mode by sending a card; an owner adds it with a role and may certify it.
5. **Roles** (`owner`, `reviewer`, `viewer`, `client`) are journal ops signed by an owner (`member.add|role|remove`), checked by one permission table shared by the desktop (UI gating and quarantine on import) and the server (403). `device.revoke` quarantines that device's ops after the revocation's clock reading; earlier ops stay valid. Roles describe what a person may do in a project; M10 plans describe what the installed app may do (`entitlements.ts`, always allowed in M9). Both checks apply and neither replaces the other.
6. **Profiles.** `--profile=<name>` keeps userData in `profiles/<name>` and the vault service as `<appId>.profile.<name>`, so one PC can act as two reviewers (tests, training).
7. **M10 seams.** One crypto stack (Ed25519 and JCS) for ops, certificates and, later, licence files. Accounts link to actors through `member.link` (`AccountLink`, reserved); a named seat maps to an actor, "up to two machines" to that actor's device records. The server's enrolment `IdentityProvider` takes invite codes in M9 and account tokens or OIDC later. No licence or seat logic runs on the team server.

## Consequences

- A lost machine is a lost device key, by design: revoke it and add a new device; history before the revocation stays valid.
- People sharing one Windows account on a site PC share one actor by default; profiles (Switch reviewer) are documented.
- In file mode, identities are self-asserted unless an owner certifies them; the badge says so. Teams that need more use owner certification or the server.
