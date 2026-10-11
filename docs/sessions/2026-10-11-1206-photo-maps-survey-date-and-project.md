---
type: session
date: 2026-10-11-1206
branch: feat/photo-maps-project-and-date
status: complete
related:
  - docs/plans/2026-10-11-photo-maps-project-and-date-design.md
  - docs/plans/2026-10-11-photo-maps-project-and-date.md
---

# Maps from photos land under the photos' survey date, and name the project

## What changed

- The **Create maps from photos** wizard works out the survey date from the photos: the date a photos layer already belongs to, else the day most photos were taken, else none. It shows the pick under the photo summary and keeps the list in **Options** for another choice.
- A day the project has no survey date for gets one, added just before the maps are built (new IPC channel `builder:ensureCapture`, `ensureCapture` in `@aio/project`), so a failed or cancelled run leaves no empty date.
- The estimate counts the days the photos were taken (`PhotoEstimate.photoDays`, optional); only real calendar days count, so an unset camera clock cannot break the summary.
- The wizard and the run panel name the project, and the results say which survey date the layers went under. The pick survives ground control first, cancel and resume, and **Create maps again**.
- Handed to the Orchestrator at `7485a771` plus this note: `pnpm check` green (5371 tests), 15 end to end tests in five photo specs passed the way CI runs them. The processing tools are unchanged.

## Why

The founder asked that processed maps be tied to the project and land in the datasets without any filing by hand. The project tie already held; the survey date did not (the wizard started on "None"), and nothing on the screens said which project a run was for. The Jobs screen itself is left to the session that is redesigning it.

## How to test

1. Open a project and click **Create maps from photos**. The top says "Project: <the project's name>".
2. Choose a folder of photos from one flight. Under the summary it says "Survey date: <the day of the flight>", with "(new)" when the project has no survey date for that day. The bottom says "The maps are added to <name>."
3. Open **Options**, **Survey date**: the list holds "None", the project's dates and "New: <day>". Leave it as it is.
4. Click **Create maps** and let the run finish. It says "Your maps are ready" and "Added to <name> under <day> as new layers:".
5. Open the Datasets list: the new layers sit in the folder of that survey date, and the date exists even though you never created it.
6. Optional: tick **I have ground control points** in a second run, mark the points, then **Create maps** in the run panel. The layers go under the same date.

## Open threads

- If the map-building step fails to start by itself, the run panel keeps saying "Working" with no button (older than this work; offered as a follow-up task).
- With ground control first, the pick is lost if the app is closed before the maps are built; keeping it needs a change to the pack's run file.
- A photo whose date sits only in the plain DateTime field, with no Exif block, counts as undated.

## Next session entry point

After the Orchestrator lands this branch, the Jobs redesign session cuts its branch from `main`; the follow-up for a failed map start can run beside it in `renderer/photogrammetry/`.
