# M12 Licensing and subscriptions (draft)

> Draft, 5 Oct 2026. The founder placed this milestone **last**, after M11 (moved from M10 to M11 on 7 Oct 2026, then to M12 on 7 Oct 2026 when surveying became M11). Nothing here is built before then. Pricing research: `docs/business/2026-10-05-competitors-and-pricing.md`.

**Goal:** sell Stratlas as a subscription from the Microsoft Store and from our own landing page, with one licence system, while the app keeps working offline.

## Principles

- **One app, one licence system for both channels.** The Store build is a free download; the person signs in or enters a key on first start. Microsoft lets non-game apps use their own commerce, so sales and seats live in one place.
- **Offline first.** Activation needs the internet once; after that the app checks a signed licence file locally. Renewal happens quietly when online (about every 30 days) with a grace period (about 14 days) before anything locks.
- **Air-gapped sites.** Offline activation by file: the app writes a request file, someone uploads it on the account portal from any connected PC and brings back a licence file.
- **Never lock people out of their data.** When a licence lapses, the app falls back to viewer mode: projects, reports and packages open read-only; editing, building, AI and exports are locked.
- **Package recipients pay nothing.** The free player opens `.aio` customer packages read-only.
- **Protect the value, not the binary.** Signed builds and the Electron asar integrity fuse make tampering visible; updates, pipeline packs, map packs and any hosted AI are delivered only to a valid licence. No heavy DRM.

## Plans (to be priced by the founder)

| Plan        | For                                    | Includes                                                                 |
| ----------- | -------------------------------------- | ------------------------------------------------------------------------ |
| Free player | Clients receiving `.aio` packages      | Opens customer packages, read-only                                       |
| Pro         | Reviewers and inspectors               | Review, annotation, issues, reports, exports, maps, AI agent (own key)   |
| Builder     | Survey and inspection teams            | Pro plus building projects from raw data, AI detection, calibration      |
| Team        | Organisations (after M9 team features) | Builder plus sync, multi-reviewer workflow, audit trail, seat management |

Seats: per named user (sign in, up to two machines each) or per machine; founder decision.

## Streams (outline)

| Stream                   | Scope                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 Licence core          | Licence file format (signed, Ed25519), local verification with the public key in the app, entitlements and plan flags read across the app      |
| L2 Activation            | Sign in or key entry, machine binding, renewal, grace period, offline activation by request and licence files, deactivate a machine            |
| L3 Viewer mode and gates | Feature gates per plan, calm upgrade prompts, viewer mode on lapse, free player for packages                                                   |
| L4 Service and portal    | Licence service (bought, for example Keygen, or our own), merchant-of-record checkout, account portal: invoices, seats, machines, offline file |
| L5 Store and landing     | Store listing as a free download with sign-in, landing page with pricing and download, trial                                                   |

## Founder decisions needed before M10 starts

1. Prices and plans (free player yes or no, trial length, annual discount).
2. Selling entity (Kuwait or another country) and payment provider that accepts it.
3. Buy a licence service or build our own.
4. Per user or per machine seats.

## Third-party licences before the first sale (added 10 Oct 2026)

A licence audit on 10 Oct 2026 looked at what we would owe others if the app were sold. The app is used internally only for now, so the founder parked all of it for this milestone: nothing below is built yet, and all of it is due before the first copy goes to a customer.

**Decided (founder, 10 Oct 2026):** the pipeline pack keeps its ready-made GPL engines (ADR 0008, amended) and ships with a source archive. The pipeline code is therefore open to anyone who receives the pack; the desktop app and the Team Server stay closed, because they only start the pack as a separate program.

### Work to do in this milestone

| Stream                      | Scope                                                                                                                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L6 Pack source archive      | A script builds a source archive with every pack release: our pipeline code, the pack build scripts and lock files, and the source of every GPL and LGPL component at the version shipped. Hosted beside the pack download under the same access, for as long as that pack version is offered                       |
| L7 Pack licence and notices | GPL-3.0 text and a "source is here" note in the pack and in Settings, About; `THIRD-PARTY-NOTICES.md` no longer points to the upstream projects for source; `python/pyproject.toml` says GPL-3.0 instead of MIT, so nobody can take the pipeline code into a closed product                                         |
| L8 Licence texts in the app | The installer carries the full licence text and copyright notice of every npm package it ships (Settings, About lists only name, version and licence id today); the Team Server image does the same for its Debian base layer                                                                                       |
| L9 Customer terms           | A EULA for the app that says the pipeline pack is under the GPL and is not restricted by the EULA; the privacy policy published; the licence service gates the download of pipeline packs and map packs, never what a customer does with them afterwards (GPL for the pack, ODbL for the OpenStreetMap street maps) |

### Founder decisions and checks needed before the first sale

1. **A lawyer confirms the wall between app and pack.** The app stays closed only if starting the pack as a separate program over JSON-RPC counts as two programs. Until then the rule holds: the app never shares code with the pack, and anything that must stay proprietary lives in the app.
2. **The public repository.** `Synapsekw/Stratlas_Ai` is public, has no licence file and names clients (EBSM, DAMAC, Masafi, HCl Tank, Al-Zour) in tracked files, with a real site coordinate in `tools/demo/check-no-client-data.mjs`, next to the competitor and pricing documents. Decide: private or public, and whether the history is cleaned.
3. **Name and trademark.** Clearance of "Quadrion AI" in classes 9 and 42 (`docs/release/FOUNDER-SETUP-GUIDE.md`); the nearest name found is General Atomics' "Quadratix".
4. **Video codec patents.** The macOS pack carries H.264 and H.265 encoders (OpenCV's FFmpeg build) and Electron carries decoders. Ask the lawyer whether patent pool fees apply at our volume.
5. **Propeller's terms.** The feature inventory in `docs/business/` was made while signed in to Propeller's demo sites; check that their terms allow it.
6. **Ownership of the kits.** The pipelines were ported from the Asset Inspection Kit and the Volumetric Survey Kit; confirm Synapse Solutions owns both outright, with no employer or client claim.
7. **The macOS COLMAP wheel.** The Windows `pycolmap` 4.2.1 wheel was scanned on 10 Oct 2026 and carries no AGPL (LSD) or non-commercial (SiftGPU) code; the macOS wheel was not checked.
