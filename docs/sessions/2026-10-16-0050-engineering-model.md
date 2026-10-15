---
type: session
date: 2026-10-16-0050
branch: feat/engineering-model
status: complete
related:
  - docs/plans/2026-10-15-engineering-model-design.md
  - docs/plans/2026-10-15-engineering-model.md
  - docs/guide/44-engineering-models.md
  - docs/KNOWN-LIMITS.md
---

# Create engineering model

## What changed

- Stage 1 landed (#143, `486a9e60`): `aio.procmodel/2` with a migrator, georef, evidence and engineer contracts, engineering geometry builders, a component GLB writer and validator, and an assembler for chimneys, flare stacks and telecom towers.
- Stages 2 to 5 landed (#147, `da0515c3`): georeferenced export and import across projects and UTM zones, the `.aio` round trip, component picking and panel, Place model for any GLB or OBJ, and re-centre for placed models.
- The `model.evidence` pipeline (pack 0.11.0) and the AI engineer step with capability routing, sharing flags `aiCloudPhotos` and `aiCloudScans`, a content-bound send preview and persisted budgets.
- The setup dialog, stages, review in Model Builder, agent corrections, and collaboration merge of model records. PDAL is installed in the CI e2e job so the flow runs there.

## Why

Reviewers needed a measured, editable engineering model of a tall asset from a cloud or photos, with every value labelled by where it came from and nothing sent to a cloud model without a preview.

## How to test

1. Open or create a project with a point cloud of a chimney, flare stack or tower (or add photos).
2. Right-click the cloud (or photos) layer and choose "Create engineering model...".
3. In the setup pick the sources, optionally "Pick in 3D" for a region, keep Standard, press Start.
4. Watch the stages. At the send preview check the images and cost, then "Send once" (or decline to stay local).
5. The draft appears over the source. Open "Review components" in Model Builder, check values say Measured, Observed or Inferred, and accept the components you agree with.
6. Ask the agent "there are four flues, not three" and approve: only the flues and deck change.
7. Press Accept: a model layer appears. Hover and click components in the scene, Focus, hide one.
8. Export the engineering model to a folder.
9. Open a second project with a different origin (or another UTM zone), Add data, import the exported GLB: it lands in the same place.
10. Import a plain GLB with no location, right-click, "Place model...", click a point, turn it, Done, reopen the project: it stays.

## Open threads

- Run `uv sync --frozen` in the main checkout's `python/` (its venv has pymeshlab, which is not in `pyproject`), then regenerate the notices with `AIO_NOTICES_PYTHON`.
- Live evaluation against the private chimney reference (local only) with `tools/agent/engineering-compare.mjs`; the founder runs it in the app, as agreed.
- Release note: a `/1` model saved by 0.16 or later becomes `/2`, and 0.15 or older cannot open it.

## Next session entry point

Build the installer when the founder asks, then act on the live evaluation results; limits are in `docs/KNOWN-LIMITS.md`.
