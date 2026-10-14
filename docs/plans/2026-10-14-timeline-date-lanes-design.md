# Timeline date lanes: design

Date: 14 Oct 2026. Status: design approved by the founder in brainstorming; awaiting spec review.

## Problem

The bottom clip timeline (`packages/ui/src/timeline/Timeline.tsx`, wired by `WorkspaceTimeline` in `apps/desktop/src/renderer/workspace/WorkspaceScreen.tsx`) puts every video of every survey date on one absolute UTC axis. With several dates weeks apart:

- fit-to-range turns each day's flights into slivers separated by long empty gaps; clips fall under the 28 px threshold and collapse into flight bars;
- the ruler switches to bare `d/m` labels with no month or year context, and nothing says which date the playhead is on;
- the timeline ignores the focused survey date (`useTimeline.focus`), so it fights the DateBar above the Stage;
- overlapping clips draw over each other in one row;
- clicking a clip always starts playback;
- 360 walks are not on it at all.

The founder uses the timeline for three jobs at once: review one date, find a video fast, and compare dates.

## Chosen direction: date lanes (option A)

One lane per survey date on a shared time-of-day axis, so the same morning flight on different dates lines up vertically. Rejected: a two-tier date strip plus day track (B), a playlist filmstrip (C), and the current axis with gaps collapsed (D). The mockups are in the brainstorming session; option A was picked.

## Behaviour

### Where it shows

- Projects with video get the lane timeline in place of today's clip timeline, and the DateBar above the Stage is removed for them.
- Road projects keep the chainage ruler and the DateBar. Projects without video keep the DateBar and the collapsed `TimelineBar`.
- Hiding the timeline (`T`) collapses it to a one-line date row (`◀ 26 Sep 2026 ▶ 📅`) instead of removing it, so the date can still be changed.

### Header

Prev / next clip, play / pause, timecode, rate, the active clip tag, the focused date in full ("26 Sep 2026"), a calendar button (the DateBar calendar moved here), **Sync dates**, zoom − / fit / +, hide. Alt+← / Alt+→ still steps between dates.

### Axis

- A shared clock in site time, fitted to the earliest start and latest end across the visible lanes, plus 2% padding.
- Site time is the UTC offset derived from the project longitude (`round(lon / 15)` hours, the same rule the builder already uses for `utcOffsetMin`). The header says "site time ≈ UTC+3". With no position it falls back to UTC and says "UTC".
- A flight that crosses midnight stays in the lane of the date it started on; the axis widens past 24:00 as needed.

### Lanes

- One lane per survey date (capture). Visible: the focused date and up to two dates on each side. The rest fold into `+N earlier ▾` / `+N later ▾` rows that expand on click.
- Dates with no video still get a thin lane with their photo and issue marks, so every survey date stays reachable from the timeline.
- Overlapping clips within a lane stack into sub-rows.
- The focused lane is full brightness and taller: clip names, issue diamonds, photo ticks, keyframe diamonds. Other lanes are dimmed and thin, with clip bars only.

### Interaction

- Click a lane label to focus that date. This calls `focusSurvey`, so the sidebar tree and date-scoped layers follow as they do today.
- Click a clip to select it and seek to the click point. **No autoplay**: Space or ▶ plays.
- Drag in the focused lane to scrub. Dragging in another lane focuses that lane first.
- Ctrl+wheel zooms, wheel pans, and the view follows the playhead while playing (unchanged).

### Playhead

- The focused lane carries the real playhead.
- Every other visible lane shows a faint ghost line at the same time of day.
- When a clip ends, playback moves to the next clip on the same date and never jumps to another date.

### Sync dates

- Toggle on: the second date is the one picked from a ghost lane, else the latest other date that has video.
- The Stage switches to a split with two video panes: the focused date's clip and the other date's clip at the ghost time. The second pane follows the playhead (seek, play, pause, rate).
- Where the other date has no clip at that time of day, its pane shows "No video at 09:14 on 10 Oct" and resumes when one starts.
- Toggle off: back to the single video window.

### Walks

360 walks appear in their date's lane as clips in a distinct colour. Their start comes from `source.capturedAt` (camera local time, no conversion needed) and their length from `video.durationS`. Clicking one opens the walk player (`openWalk`).

## Model and components

### Pure model (`packages/ui/src/timeline/lanes.ts`)

`buildLaneModel(model, index, focus, offsetMin)` runs over the existing `buildTimelineModel` output and returns:

- `lanes: Lane[]`, where `Lane = { captureId, date, clips, rows, issues, photos, walks }`. A clip's lane comes from `index.of[layerId]`, and overlaps get sub-row numbers.
- `folds: { earlier: number; later: number }` for the focused date plus or minus two.
- `range: [todStartMs, todEndMs]`: time of day in site time, in ms after local midnight.

Helpers:

- `todOf(utcMs, offsetMin)` and its inverse per lane date.
- `ghostAt(lane, todMs)` returns the lane's clip and media time at that time of day, or nothing.
- `clipAt` and `neighbourClip`, scoped to one lane.

### Desktop (`apps/desktop/src/renderer/workspace/`)

- `LaneTimeline.tsx` replaces `WorkspaceTimeline` for video projects. It reuses the ruler, ticks, clip bar styling and zoom / pan from `Timeline.tsx`. Shared pieces are extracted into `packages/ui/src/timeline/` rather than copied.
- `DateRow.tsx` is the compact one-line form shown when the timeline is hidden.
- The DateBar's popover shell (outside click and focus trap) is extracted into `@aio/ui` and used by the lane header, `DateRow` and `DateBar`. The `Calendar` component is reused as is.
- `WorkspaceScreen.tsx` renders `DateBar` only when there is no lane timeline.
- State is unchanged: focus stays `useTimeline.focus` (a capture id), and time and play stay in `useWorkspace`. The clip click drops the `play()` call.
- The site offset comes from a small helper that reprojects `manifest.origin` from `manifest.crs` to longitude, reusing the builder's rule.

### Sync dates (contract change)

- A new `video` `PaneKind` in `splitModel.ts`: a pane showing a capture's clip at a time of day.
- `compareWith` gets `kind: 'video'` and plans two video panes.
- The second pane reads the playhead from `useWorkspace` and maps it through `ghostAt`.
- `FloatingVideo` stays the single floating window; the split panes are separate players.
- A row goes in `docs/architecture/contract-changes.md` (pane kind and compare kind).

## Phases

Each phase is its own branch and merge.

1. **L1 lanes**: lane model, `LaneTimeline`, folds, ghost lines, the DateBar merge and `DateRow`, site time, no autoplay, sub-rows. The main fix; useful alone.
2. **L2 Sync dates**: the `video` pane kind, `compareWith({ kind: 'video' })`, the second pane following the playhead, the empty-pane message.
3. **L3 walks in lanes**: walk clips in lanes, click to `openWalk`.

## Testing

### Unit (Vitest)

- `lanes.test.ts` covers:
  - grouping by capture; sub-rows for overlaps;
  - folds at the edges (first date, last date, fewer than five dates);
  - time of day with positive, negative and zero offsets; a flight crossing midnight;
  - `ghostAt` inside a clip, in a gap and past the end;
  - next-clip stepping that stays within a lane;
  - dates with no video produce a thin lane.
- A site offset helper test: longitude to hours, and no position gives UTC.
- Existing `model.test.ts`, `ticks.test.ts`, `timeline.test.ts` and `DateBar.test.tsx` stay green. `DateBar` keeps its tests for road and no-video projects.

### End to end (Playwright, run the CI way: 1100 x 720, scale 1, WARP)

- New `timeline-lanes.spec.ts` on a fixture with three dates and two or three videos each:
  - lanes render with dates;
  - clicking a lane label focuses the date and the sidebar follows;
  - clicking a clip selects it without playing;
  - ghost lines show on the other lanes;
  - `+N earlier` expands;
  - `T` collapses the timeline to the date row and Alt+← still steps.
- L2: Sync dates opens two video panes, the second follows a seek, and a gap shows the empty-pane message.
- L3: a walk clip in its lane opens the walk player.
- Update `timeline.spec.ts`, `video-first.spec.ts` and `stage-display.spec.ts` where they rely on the DateBar or clip autoplay in video projects.

## Open points

- A project spread over many time zones (it doesn't happen today) would still use one offset.
- Lanes for dates far outside the visible five load lazily if performance needs it; not planned for L1.
