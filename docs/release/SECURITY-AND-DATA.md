# Security and data handling (Quadrion AI 1.0)

A short note for procurement and IT security reviews. Draft of 7 Oct 2026, to be checked against the final build before release (1.0 checklist). Questions: [security contact address].

## In one paragraph

Quadrion AI is a desktop application for Windows and macOS. Projects stay on the customer's own drives, network shares or Team Server. Quadrion AI needs no account and sends nothing to Synapse Solutions: no telemetry, no analytics, no crash upload. It connects to a network only after a person's action, and only to the service that action names. Sharing between team members uses the customer's own shared folder, USB transfer files or a Team Server the customer runs on its premises. Every change is recorded in a tamper-evident history signed with a key that never leaves the computer's credential store.

## Where data lives

| Data                                                      | Where                                                                                         |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Projects (imagery, models, point clouds, issues, reports) | Folders the customer chooses (local disk or network share), or read-only `.aio` packages      |
| Change history (journal), team membership                 | Inside the project folder (`journal/`, `team.json`)                                           |
| Settings, library, AI conversations, demo copies          | The user's profile on that computer                                                           |
| API keys, device signing keys, server enrolment           | The operating system's credential store only (Windows Credential Manager, macOS Keychain)     |
| Shared team data                                          | The customer's shared folder (hub), transfer files (`.aiosync`) or the customer's Team Server |

Synapse Solutions hosts no customer data in 1.0. A hosted service is not offered; if one is offered later, government customers stay on premises and other customers get in-country hosting after legal review (decision 3).

## What leaves the computer, and when

| Connection          | When                                                                                      | To                                                     | What is sent                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud AI            | Off by default. Only after a person turns it on and adds their own API key                | The provider of that key (Anthropic, OpenAI or Google) | The text and images the person sends in an AI conversation, shown before the first send in a project                                                                         |
| Map download        | When a person adds a map region                                                           | The map data server shown in Settings                  | The area asked for, no project data                                                                                                                                          |
| Online satellite    | Off by default. Only after a person turns it on, and never on an offline-only workstation | EOX IT Services GmbH, `tiles.maps.eox.at` over HTTPS   | Requests for the imagery tiles of the areas in view (so the areas viewed and the computer's network address are visible to that service), no project data, no key, no cookie |
| Update check        | Off by default. Only when turned on, or "Check now"                                       | The update address set in Settings                     | A request for the update feed file                                                                                                                                           |
| Team Server sync    | Only for a project in server mode, on a click or the auto-sync the person turned on       | The customer's own Team Server                         | That project's changes and files, in signed requests                                                                                                                         |
| Shared folder (hub) | Only for a project in hub mode                                                            | The customer's network share                           | That project's changes and files                                                                                                                                             |

An administrator can turn every online action off for a workstation (**offline-only** setting). That includes cloud AI: while it is on, no request goes to an AI provider, whatever the cloud AI switch says, and a model on the same computer keeps working. It includes online satellite imagery too: nothing is requested, and only tiles already kept on the computer (up to 300 MB in the app's settings folder, cleared from Settings) are drawn. The test suite runs every end-to-end test behind a network guard that fails the test on any unexpected request.

Transfer files (`.aiosync`), identity cards (`.aioid`) and packages (`.aio`) leave the computer only when a person saves them and carries or sends them.

## Cryptography

| Use                         | Method                                                                                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| History integrity           | SHA-256 over JSON canonicalised by RFC 8785 (JCS); each change names the hash of the one before it                                                                                                    |
| Who made a change           | Ed25519 signatures by a per-device key (Node.js `crypto`, no third-party crypto library), with a separate signing domain per record type so a signature cannot be reused for another purpose          |
| Team Server requests        | Signed per device (HTTP Message Signatures, RFC 9421, Ed25519); the server's key fingerprint is pinned at enrolment; receipts are countersigned by the server; no bearer tokens in the user interface |
| Transfer files (`.aiosync`) | Optional AES-256 with a passphrase (on by default for full bundles); encryption to recipients' public keys (X25519) is planned after 1.0                                                              |
| Packages (`.aio`)           | Optional WinZip AES-256 (AE-2) per member. The key is derived as that format prescribes (PBKDF2-HMAC-SHA1, 1,000 rounds), so a long passphrase matters                                                |
| Installers                  | Windows: Authenticode, OV certificate held in a cloud HSM, timestamped. macOS: Developer ID, notarised. Team Server image: signed with cosign, with an SBOM                                           |

Verify (in the app) checks the whole history and names exactly what is wrong: an edited, removed, reordered or truncated change, a missing device segment, or a copied folder that forked the history. The app keeps working while it reports.

## People, devices and roles

- Each person has a name and initials; each computer has its own signing key. A name is self-asserted and shown as "unverified" until the project owner certifies it (decision 5).
- Roles: owner, reviewer, viewer and client. On a Team Server the server enforces them. In a shared folder or with transfer files, roles are recorded and tamper-evident but cannot be enforced against someone who edits files by hand; the history shows such edits as "changed outside Quadrion AI".
- Approvals are always a person's: the built-in AI assistant can comment and list work but can never approve.
- A lost or retired computer's key is revoked by the owner; later changes signed by it are refused.

## Application hardening

- Electron with context isolation, the renderer sandbox and Node integration off; a Content Security Policy on every page; Electron fuses set (no `RunAsNode`, no Node options or inspector from the command line, app code only from the app archive, whose integrity is checked).
- Every message between the interface and the main process is checked against a schema.
- Logs and the diagnostics bundle never contain keys, tokens, invite codes or comment text; the bundle stays on the computer until a person attaches it to a support request.
- Third-party components: the app and the server image use permissive licences; the pipeline pack contains GPL components (COLMAP's CHOLMOD and SPQR, MeshLab, OpenCV's FFmpeg build on macOS) and is distributed under the GNU GPL version 3 (founder decision of 8 Oct 2026). CI reports the licences of everything that ships and never blocks on them. Inventory with every licence: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Team Server (preview in 1.0)

- Runs as a Docker image on the customer's premises, operated by the customer's IT; Synapse sells installation and an optional managed-on-premises contract.
- PostgreSQL for the history (append-only by database grants), files on the server's disk or a customer-provided S3-compatible store. No MinIO, no PostGIS.
- Stays a preview until an external penetration test has passed (decision 14). Customers who need a non-preview product in 1.0 use shared folders or transfer files.

## Known limits

- Roles are not enforced in shared-folder and transfer-file modes (above).
- Packages use the WinZip AES key derivation, which is weaker than modern password hashing: use long passphrases, and send the passphrase by a different channel than the package.
- No real-time co-editing and no email notifications in 1.0.
