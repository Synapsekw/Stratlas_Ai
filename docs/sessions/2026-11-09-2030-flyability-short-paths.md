---
type: session
date: 2026-11-09-2030
branch: fix/flyability-short-paths
status: complete
related: [2026-11-09-1826-flyability-mission-folder.md]
---

# Flyability import under short Windows paths

## What changed

- The library's re-drop note (`flyability-source.json`) now keeps one hash per folder, of its real path (links and junctions followed, 8.3 short names made long, case folded on Windows), and a re-drop is matched the same way (`sourceKeyHash` in `apps/desktop/src/main/library.ts`). Before, it kept the path as given and as resolved, so a folder reached by a short name was stored twice (6 hashes for a 3-folder mission on CI).
- The raw import and desktop builder tests that expected the export path as given now expect its real path: the job is handed each chamber by its real folder on purpose (a junction found no clouds), and CI's temp folder is an 8.3 short path.
- New tests: a mission folder dropped by its short and by its long name lands in one project with 3 hashes (skipped where the volume has no 8.3 names), and a `.zpc`, a Bentley AT export and a plain folder go the old route while Inspector exports are looked for.
- The Bentley e2e failure on this PR's run was traced: the files dropped there (`.zpc`, `.xml`) never reach the mission walk (it only looks at folders), the job params are unchanged, and the spec passes in all 8 local runs with an 8.3 short temp path. The likely cause is that `pointcloud.to_copc` and `bentley.import` both read, change and write `manifest.json` without the manifest lock, so one layer can be lost when they finish together. Not fixed here, because it needs a pipeline pack number.

## Why

The mission folder batch went red on CI because CI's temp folder is an 8.3 short path and the code resolves it to the long one.

## How to test

1. Open the Projects screen and drop a Flyability mission folder (several chamber exports) on the library. One project is made and the picker opens. (Corrected 9 Nov: a drop on the library did not work until `2026-11-09-2228-inspector-export-root.md`; before it, use Add project folder.)
2. Cancel the picker, then drop the same folder again, this time by another path (for example through a junction or a `subst` drive letter, or typed in another case). The same project opens, and no second project is made. (Corrected 9 Nov: a mapped network drive was named here but never tried.)
3. Drop one chamber folder of that mission on its own. It opens the same project.

## Open threads

- Pipeline: `pointcloud.to_copc` (register) and `bentley.import` (commit) should take `manifest_lock` around their manifest read and write, like `flyability.import` and `change` do. This needs a pack number from the coordinator.
- `globe.spec.ts:1012` failed on shard 1 of the same run. It is a known flaky spec.
- Locally, `flyability-import.spec.ts` fails when the temp folder is a short name for a deep folder: the long form of the job's paths then passes the 260-character Windows limit. It passes with a shallow short temp folder, as on CI. A data folder nested that deep would hit the same limit.

## Next session entry point

Hand this branch to the merge coordinator. If the Bentley spec fails again, take the manifest lock fix on a pipeline branch.
