# Support policy (draft for 1.0)

Draft for founder sign-off (decision 12, recommended defaults of 7 Oct 2026). Brackets mark what the founder still fills in.

## What is supported

| Release         | Support                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1.0.x           | Security and bug-fix patches for **12 months** from the 1.0.0 release date ([date]).                                        |
| Each later 1.x  | Patches until 12 months after its release, or 6 months after the next minor release, whichever is later.                    |
| 0.x test builds | Not supported. Customers on a test build move to 1.0.                                                                       |
| Team Server     | Preview in 1.0: best-effort support, no response-time commitment, until it leaves preview after the external security test. |

Patches come as 1.0.x updates through the same channels as the release: the Microsoft Store, the update feed (stable channel) and the offline installer. A patch never changes file formats: a project saved by 1.0.3 opens in 1.0.0 (see [UPGRADE-POLICY.md](UPGRADE-POLICY.md)).

## How to reach us

- **Email:** [support address], answered in Kuwait business hours, Sunday to Thursday, 08:00 to 17:00 (UTC+3), except public holidays in Kuwait.
- **Portal:** [support portal URL], for tracking a case and downloading offline installers.
- The Team plan's onboarding day and the optional managed-on-premises contract have their own terms.

## Response times

The first answer from a person, counted in business hours.

| Severity    | Meaning                                                                   | First answer    | Target for a fix or workaround                            |
| ----------- | ------------------------------------------------------------------------- | --------------- | --------------------------------------------------------- |
| 1, critical | Data loss or corruption, the app does not start, or a security problem    | 4 hours         | Workaround in 1 business day; patch as soon as it is safe |
| 2, major    | A main feature does not work and there is no workaround                   | 1 business day  | Next patch release                                        |
| 3, minor    | A feature works with a workaround, or something is wrong but not blocking | 3 business days | A later release                                           |
| 4, question | How-to questions, requests and suggestions                                | 5 business days | Not applicable                                            |

## What to send

Stratlas sends nothing on its own: there is no crash upload in 1.0. To report a problem:

1. In Stratlas, open **Help, Report a problem**. It writes a diagnostics bundle on your computer: the app and system versions, recent logs, settings without keys, and (from 1.0) sync and journal status, the device id and the server version. It never holds API keys, device keys, invite codes or comment text.
2. Look through the bundle if you wish, then attach it to your email or portal case by hand.
3. Say what you did, what you expected and what happened. Do not send project files unless we ask; if we do, we agree with you how they are sent and deleted.

## Hotfix procedure (internal)

1. The 1.0.0 tag starts the branch `release/1.0`. Fixes land on `main` first and are cherry-picked to `release/1.0`, unless the fix only applies to 1.0.
2. Each patch raises the patch version (`1.0.1`), runs the full CI (Windows and macOS, Vitest, Playwright, pytest, the compatibility corpus) and the release checklist ([CHECKLIST.md](CHECKLIST.md)), is signed, and goes out on the stable feed and to the Store.
3. A patch never changes a file schema version or adds a required field.
4. Severity 1: the integration lead may ship the patch to the beta channel first for a day with the affected customer before stable.

## End of support

When a release leaves support, it keeps working: there is no licence check that switches it off in 1.0 (M10 brings licensing). We announce the end date 3 months ahead on the known-issues page and by email to Team customers.
