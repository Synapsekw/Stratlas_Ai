# Right sidebar: "In this project" list

Design, 24 Oct 2026. Brainstormed with the founder on real-screen mock-ups; the founder picked
layout **C1 (one panel)**. Screenshots in `docs/design/right-sidebar/`:

- `today-measure-bench.png`: today, the antenna inventory is the last section of the Measure bench.
- `today-antenna-card.png`: today, editing happens on the floating antenna card over the stage.
- `chosen-c1-one-panel.png`: the chosen layout.

## Why

The founder could not find an antenna inventory where wrong antennas can be deleted and azimuths
fixed. They expected an "Antennas" tab. Recon found why:

- The inventory is the last section of the Measure bench, under eight folded tool sections, and is
  reached by opening the notch, clicking Measure and scrolling to the bottom.
- Its rows (`P2 120.0° 2.0° Draft`) only show, hide, select and flag. Azimuth is edited halfway
  down the floating `AntennaCard` on the stage.
- A wrongly _detected_ antenna cannot be deleted, only Rejected (Delete exists only for
  `origin === 'flagged'`), and Rejected units drop out of the default filter, so it looks like
  nothing happened.
- Selecting an antenna in 3D does not bring its list forward. The right-click action registry has
  no antenna target.

The root cause: the sidebar is organised by tool family, while the founder thinks in project
contents ("my antennas"). Antennas ended up under Measure because the detector is a measuring tool.

## The decision in one line

The project's **contents** get their own "In this project" list, in the same folding-section style
as the Measure bench, at the top of the first tab. **Tools stay exactly where and how they are found
today**, directly below it.

## Goals

1. A user finds antennas (and later the other contents) by name, one click from anywhere.
2. Delete a wrong antenna, detected or flagged, and change its azimuth and downtilt right in its
   row.
3. Picking an antenna in 3D opens its group and scrolls to its row; right-click on it (3D or row)
   gives the same actions.
4. The project category decides which groups appear in "In this project" and in what order.

## Non-goals

- No change to how tools are found: same sections, order, contents, search, favourites. No "quick
  tools" row, no "+" or "More tools" menu.
- No change to the left sidebar (layer tree), the stage notch groups, or the Volumes, Changes,
  Coverage, Thermal, Model review and other panel tabs, beyond the wiring named below.
- No new tool behaviour (detection, RF planning, flagging stay as they are).

## Anti-goals (a failure even if it works)

- Tools moved behind an extra click, a menu or a hover. The founder rejected this explicitly:
  "they need to be easily accessible without too many clicks hidden in menus".
- A second place to edit the same antenna that can disagree with the first.
- A new visual style. It must look like today's Measure bench sections (founder: C was picked
  because "it stays on design same as other measurement options").

## The layout (C1)

Right panel, first tab. The tab today labelled **Measure** is renamed **Project** and stays a pinned,
always-present tab. Selection and Issues tabs are unchanged. Top to bottom:

1. **IN THIS PROJECT** caption.
2. One folding section per content group, each with its name, count and chevron, in the order the
   category gives. A group with nothing in it still shows with count 0, so users learn where things
   will appear, except groups that do not apply to the project at all (see the category table).
3. **TOOLS** caption, then today's Measure bench unchanged: autosave row, search box, Favourites and
   recent, Point, Line, Polygon, Telecom, Markup, Section plane, Site data, Drawing aids, Templates.
   The old "Antenna inventory" section is removed from the tools, since it now lives in the
   Antennas group.

A long group must not push the tools out of reach. Founder accepted the recommendation:
an expanded group shows at most about 8 rows and scrolls inside itself beyond that, and the
whole content area folds away with one click on its caption (remembered per computer, like the
bench folds today).

The notch's Measure group and its "All tools" tile open this tab scrolled so the TOOLS caption
is at the top, so reaching a tool costs no more than it does today.

## The Antennas group

The replacement for today's `AntennaSection` / floating `AntennaCard` editing:

- Filter chips: To review / Accepted / Rejected / All, with counts, as today. Group eye, Hide all /
  Show all and Flag antenna stay, in the group header.
- **One row per unit**: checkbox, colour swatch, ID, kind, **Azimuth** and **Downtilt** as editable
  number fields (same saving rule as `AntennaTypedValues` today: typed value, saved on blur/Enter,
  Esc reverts), height, status chip (the app's outlined chip with a dot), a **trash icon**.
- **Selected unit details open inline under its row** (not docked, not floating): Azimuth, Downtilt,
  Plumb, Altitude, W x H x D, point count, the "Your values" and "Model, weight, frequencies"
  folds from today's card, and Accept (A) / Reject (R) / Redraw outline / Delete.
- **Ticking rows** shows a bulk bar: "N selected · Accept · Reject · Delete · ✕".
- The floating `AntennaCard` on the stage is retired; everything it does moves inline. The 3D
  measurement labels on the selected unit stay.
- Prev/next (today's "1 / 4" arrows) move the inline selection up and down the list.

### Delete

- Delete works for every unit, detected or flagged, from the row trash, the inline details, the
  bulk bar, the right-click menu and the Delete key while a unit is selected.
- It asks once for confirmation (this was already an open follow-up of antenna flagging), naming
  how many units go.
- Deleting removes the unit and its orphan crop (another open follow-up).
- Reject stays as the soft option ("this is wrong, keep a record").
- If the unit belongs to an RF sector (`rf/sectors.json`), Delete also takes its id out of that
  sector, and the confirmation names the sector ("P2 is in sector Alpha; it will be removed from
  it"). Reuse `packages/rf`'s orphan helpers rather than writing new sector code. (My call.)
- **A deleted detection stays gone (founder, 24 Oct).** Today the re-run merge
  (`python/src/aio_pipelines/telecom/merge.py`) keeps Rejected units so a later run cannot re-add
  them, but drops unmatched drafts and adds new finds as fresh drafts, so a plain delete would
  come back. Delete therefore leaves a hidden "not an antenna here" record (position and outline
  enough for the merge to match) that the UI never lists and the merge treats like a rejection:
  a later find matching it is dropped. A flagged unit that is deleted needs no record (detection
  never made it). This changes `telecom/antennas.json` (additive; older builds must ignore the
  record, so check how they read unknown entries), needs a row in
  `docs/architecture/contract-changes.md`, Python merge work and tests, and likely a pipeline
  pack bump. The record format is left to the builder.

### Selection and right-click

- Picking a unit in 3D brings the Project tab forward, unless a live tool tab (Coverage, Thermal,
  a running job, an issue being edited, which D14 already protects) is in front: then the pick
  only updates the list in the background and the inline details, so the tool is never taken
  away mid-use (my call). Otherwise it expands Antennas, switches the filter to All if the unit is hidden by it, and scrolls
  its row into view with details open.
- New action-registry target `antenna` (in `packages/ui/src/actions/registry.ts`, actions under
  `renderer/shell/actions/`): Edit azimuth (focuses the field), Edit downtilt, Accept, Reject,
  Redraw outline, Fly to, Delete. Available on the 3D unit and on the row.

## Other groups (first cut)

Each group is a folding section with the same row grammar (name, key values, status, row actions,
details inline under the selected row). The first build must ship **Antennas, Sectors,
Measurements and Issues**; the rest follow the same pattern later and are listed so the structure
allows them.

| Group                | Rows                                                                                                | Row actions                      | Notes                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Antennas             | as above                                                                                            | as above                         |                                                                                                                                                                 |
| Sectors              | each saved RF sector: name, azimuth (worked out from its antennas, as Coverage does), antenna count | rename, Fly to, open in Coverage | saved sectors only; before a plan is saved it shows 0 and "Plan sectors in Coverage" (my call)                                                                  |
| Coverage plan        | one row: state ("not planned", last run)                                                            | open Coverage tab                |                                                                                                                                                                 |
| Measurements         | each saved measurement: name, kind, value                                                           | the existing `measure.*` actions | same list as the left tree's measurements group; both stay, reading one store with one shared selection, so an edit or pick in one shows in the other (my call) |
| Issues               | each issue: title, severity, status                                                                 | open, the existing issue actions | Issues tab stays too                                                                                                                                            |
| Stockpiles / Volumes | piles and totals                                                                                    | open in Volumes tab              | later                                                                                                                                                           |
| Changes              | change areas between dates                                                                          | open in Changes tab              | later                                                                                                                                                           |
| Photos               | photo sets                                                                                          | the existing `photos.*` actions  | later                                                                                                                                                           |

## Project category

The project already stores a `purpose` from the new-project wizard (`packages/schema/src/builder.ts`
`ProjectPurpose`: survey, construction, vertical-asset, confined-space, data-fusion, road;
`manifest.ts` keeps it as a plain string, "Only labels and the starter list read it, never
behaviour"). This design makes it decide **which groups show and their order, nothing else**
(founder: "That's ok" to that and only that role).

- Add a **`telecom`** purpose ("Telecom towers") to the wizard. It is additive: the manifest field is
  a plain string, so older builds still open such projects. `ProjectPurpose` and `PURPOSE_TYPE`
  change, so it needs a row in `docs/architecture/contract-changes.md`.
- Older projects with no purpose: pick from contents. Antennas or an RF plan → telecom order; a
  stockpile kit or volume measurement → survey order; otherwise the default order.

Group order per category, kept as data so a later change is one edit (my call; founder to glance
at the rows):

| Category                                     | Groups, top first                                      |
| -------------------------------------------- | ------------------------------------------------------ |
| Telecom towers                               | Antennas, Sectors, Coverage plan, Measurements, Issues |
| Volumetric survey (`survey`)                 | Stockpiles, Measurements, Issues                       |
| Construction progress (`construction`)       | Changes, Measurements, Issues, Photos                  |
| Vertical asset inspection (`vertical-asset`) | Issues, Measurements, Photos, Antennas (only if any)   |
| Default (others, unknown)                    | Measurements, Issues, then any group with items        |

A group outside its category's list still appears, at the end, as soon as it has items, so nothing
the project holds is ever hidden.

## Constraints

- Code rules in `CONTRIBUTING.md`; strings through i18n (`packages/ui/src/i18n/en.ts`).
- Must look right at the CI size (1100 x 720) as well as large screens; the panel keeps today's
  width.
- E2E specs that use the Measure tab, the antenna section or `AntennaCard` will change
  (`antenna*` specs, `bench-scroll.spec.ts`, panels specs); they must be updated, not deleted.
- Existing per-computer state (bench folds, pinned tabs) keeps working; a renamed tab id must
  migrate.

## Left to the builder

- Component structure, store shape, how groups register (a small registry like `TAB_IDS` is
  expected), and whether "Project" keeps the internal id `measure`.
- Exact row heights, the inner-scroll threshold (about 8 rows), keyboard navigation in the list.
- Whether Sectors rows edit anything in the first cut beyond rename.
- Phasing (a sensible split: Antennas group with delete and inline details first, then the other
  groups and the category order).
