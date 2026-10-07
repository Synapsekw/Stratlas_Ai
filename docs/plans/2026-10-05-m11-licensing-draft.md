# M11 Licensing and subscriptions (draft)

> Draft, 5 Oct 2026. The founder placed this milestone **last**, after M10 (moved from M10 to M11 on 7 Oct 2026). Nothing here is built before then. Pricing research: `docs/business/2026-10-05-competitors-and-pricing.md`.

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
