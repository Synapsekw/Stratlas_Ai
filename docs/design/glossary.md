# UI glossary

| | |
|---|---|
| Status | **Decided** 2026-11-09 (UI revision W20), from the October UI review |
| Evidence | `docs/design/ui-review-2026-10/critique.md` (heuristic 2 and the persona notes), `code-audit.md` (naming) |
| Enforced by | `packages/ui/src/i18n/glossary.test.ts`: no string in the English catalogue uses a retired term |

The app speaks the user's language: surveying words (UTM, toe, chainage, PCI) and plain English. The October review found two problems. The AI had five names, and "cloud" meant both a point cloud and the network. It also found words the app made up and never explained: "Every date", "bench", "island", "File them / Not now", "EDL" and "Triangulated toe". This page sets one word for each thing. New copy uses these words, and the test fails when a retired one comes back into `packages/ui/src/i18n/en/`.

## Words to use

| Thing | Say | Notes |
|---|---|---|
| The AI, everywhere it is named (chat dock, photo questions, settings) | **Ask AI** | The only name for the feature. Its chat panel is "Ask AI chat" to screen readers. |
| The AI status chip | **AI ready**, **AI off**, **Offline AI** | Offline AI is a local model on this computer or network. Never "Cloud AI" in the status. The switch that sends every task to it is "Use Offline AI for everything". |
| AI that runs at an online provider | **cloud AI** | Always the two words together, never "cloud" alone. It pairs with Offline AI: "Allow cloud AI", "cloud AI off", "a cloud AI provider". |
| A point set from a scanner or photogrammetry | **point cloud** | Always both words: "point clouds hidden", "Box on the point cloud". A label too narrow for both words (a 72 px stage tools tile) says "3D" instead, "3D point" and "3D box", and its tooltip keeps the full words: a short label reads better than a clipped one. Never "cloud" alone. |
| The network | **online**, **offline**, **Offline only** | "Go online", "online maps". Never "in the cloud" for the network. |
| Datasets that belong to no survey date (they show with every date) | **No date** | The tree group and the move target. A prompt says "datasets with no date". |
| The prompt that files undated datasets under their survey days | **File by date**, **Leave for now** | Buttons say what they do. "Not now" stays fine as a plain dismiss on an offer. |
| The right panel's parts | **panel**, **tab**, **section** | The right panel holds tabs; the groups inside a tab are sections. |
| The tools of one line of work that are part of a project or not (founder, 18 Nov 2026) | **tool set**; the four are **Earthworks**, **Road**, **Telecom**, **Thermal** | The switches are "Tool sets" in Project settings. A set "is part of the project" or is not: never "hidden", "advanced" or "more tools". A locked switch says "On: this project holds ...". |
| The bar at the top centre of the stage (modes, view and tools) | **stage tools** | Matches its accessible name, "Stage tools". |
| The point shading that brings out the shape of a point cloud | **depth shading** | The renderer calls it eye-dome lighting; the UI does not. |
| The volume base fitted through the pile's toe | **Toe surface** | The standard base. "Toe" is a surveying word and stays. |
| Cut and fill between two surfaces | **Cut & fill**, **cut and fill** | "Cut & fill" on every label, title, button and tab. "cut and fill" inside a sentence or a longer phrase: "Find cut and fill regions", "Cut and fill together" (the row that adds the two). |
| One heap of material | **pile** | "Pile 2 of 19", "No piles yet", "Detect piles". |
| The folder and group that hold the piles | **Stockpiles** | The left sidebar group. Never the name of one heap in the volumetrics screens. |
| The right panel section with the inventory, Cut & fill and Materials | **Volumes** | The section name. |
| The figure, and the Measure tool that draws it | **volume** | "Draw volume", "Volume above base". |
| The customer report on the piles | **Volumetric report** | On the button and as the report's default title. |
| The list of materials and their densities | **Materials** | The only name for that screen, wherever it is opened from. |
| The strip under the stage with a marker per survey | **Dates strip** | Never "timeline": that is the video footage timeline and the Timeline feature. |
| One date a site was surveyed on | **Survey date** | "Add survey date", "Play through the survey dates". |
| Any chart of a volume through time | **Volume over time** | The same title on the measurement card, the pile's History and the report. |
| The button that opens a chart in the larger chart window | **Open larger** | The same label on every card. |
| The list of detected antennas, its group and its export (telecom finalization, 22 Nov 2026) | **Antennas** | "Project > Antennas", "Export antennas (CSV)", "in the Antennas list" inside a sentence. Never "antenna inventory" or "the inventory". |
| One detected thing of any kind, inside a sentence | **unit** | "Every unit on the tower". The feature names keep **antenna**: "Detect antennas", "Flag antenna". |
| The direction an antenna or a sector faces | **Azimuth** | "Group by azimuth", "no azimuth". Never "bearing" in telecom or Coverage text; a sun or a line still has a bearing. |
| The measured tilt of a unit below horizontal | **Downtilt** | "Downtilt °" in the column, "Downtilt" in the details and in Coverage. Coverage writes **Electrical tilt** in full for the radio value. |
| The two hand tools that measure a direction and a lean | **Antenna azimuth**, **Physical tilt** | The menu and the saved rows carry the same names. Physical tilt is an unsigned lean from vertical, not a downtilt. The third tool is **Clearance**. |
| The height of a unit's centre in the project's vertical datum | **Centre altitude** | "Alt m" in the column, "alt" in the 3D label. **Height above ground** stays Coverage's own value. |
| Where a dish points above or below horizontal | **Elevation angle** | Never "Elevation" alone for a dish: elevation is a height elsewhere in the app. |
| The review status of a unit, its filter and Coverage's counts | **Draft**, **Accepted**, **Rejected** | The filter tab is "Draft" too. Never "to review", "unreviewed" or "not reviewed" for a unit. |
| A value a person typed | **Entered by you** | "entered by you" in a lower-case tag. Never "typed" or "set by you". |
| A value that is missing | **Not measured**, **Not set** | Not measured: the app could not measure it. Not set: a person can type it and has not. |
| The coverage tool, its tab, its section and its layer | **Coverage** | **RF settings** for one antenna's radio values; **Open in Coverage** on every link into it; **Auto-plan** for the proposal and **Auto-plan and run** for both at once (the review's button is "Apply and run"). |

## Retired terms

The test reads this table. Each row is a term no UI string may use; the test holds the matching pattern.

| Retired | Use instead | Why |
|---|---|---|
| `agent` | Ask AI | One AI name (founder, 30 Oct 2026). "Agent", "Ask agent", "Offline agent" and "the cloud agent" all became Ask AI or Offline AI. |
| `cloud` | point cloud, cloud AI, online | Bare "cloud" meant both a point cloud and the network. |
| `Every date` | No date | App-invented; it read as "all dates" when it means "not tied to one". |
| `File them` | File by date | The button did not say where the datasets go. |
| `bench` | panel, tab, section | Internal name for right-panel content. |
| `island` | stage tools | Internal name for the stage's top bar. |
| `EDL` | depth shading | An unexplained acronym. |
| `Triangulated toe` | Toe surface | Jargon; the plain words say what the base is. |
| `Cut / fill` | Cut & fill, cut and fill | One spelling on labels, one in sentences (volumetrics finalization, 18 Nov 2026). "cut/fill" is retired with it. |
| `Cut + fill` | Cut & fill, cut and fill together | A third spelling of the same idea. |
| `Stockpile volume report` | Volumetric report | The button and the default title said two things. |
| `Site materials` | Materials | One name for the screen. |
| `Materials and density` | Materials | One name for the screen. |
| `Survey dates chart` | Dates strip | One name for the strip under the stage. |
| `Open in section view` | Open larger | Two labels opened the same chart window, and "section" already means other things. |
| `Volume and tonnes over time` | Volume over time | One title for every chart of a volume through time. |
| `Antenna inventory` | Antennas | The list had two names (telecom finalization, 22 Nov 2026). |
| `inventory` | Antennas, the Antennas list | Telecom and Coverage text only: a stockpile still has an inventory. |
| `Antenna tilt` | Physical tilt | The tilt tool had one name in the menu and another on its rows. |
| `Mechanical downtilt` | Downtilt | One of five spellings of the same value. |
| `mechanical` | Downtilt | Telecom and Coverage text only. |
| `bearing` | Azimuth | Telecom and Coverage text only: a sector faces an azimuth, as its antennas do. |
| `Centre elevation` | Centre altitude | The centre height had four names, and "elevation" is also a dish's angle. |
| `To review` | Draft | Telecom and Coverage text only: the status and its filter say the same word. Inspect keeps its own "To review" chip. |
| `not reviewed` | Draft | Telecom and Coverage text only. |
| `unreviewed` | Draft, uses drafts | Telecom and Coverage text only. |
| `set by you` | Entered by you | Telecom and Coverage text only. |
| `typed` | Entered by you | Telecom and Coverage text only, as a word for a value. "Type it" as an instruction stays. |
| `Open Coverage` | Open in Coverage | Two labels for the same link. |
| `coverage settings` | RF settings | One name for one antenna's radio values. |
| `& run` | and run | Telecom and Coverage text only: "Auto-plan & run" and "Apply & run coverage" became "Auto-plan and run" and "Apply and run". |

## Allowed exceptions

A retired word may appear where it means something else. The test keeps these in a commented allowlist, and each one needs a reason there:

- **"Privacy and cloud"**, the Settings page name: the page is about cloud AI and the network. About 30 hardcoded strings outside the catalogue and the user guide point to it by name, so it is renamed only when those move into the catalogue.

## Not covered yet

The test reads the English catalogue only. Some copy is still written inline in components and in the main process. Known leftovers: the task label "Agent chat" in Settings, AI providers (also "Provider for Agent chat"), the exported conversation title "Agent conversation", the annotation author "Agent", the annotate toolbar's own "Cloud point" and "Cloud box", and "Allow cloud AI" in Settings and package export (allowed wording, but inline). Those follow this glossary when they move into `packages/ui/src/i18n/en/`.

Telecom leftovers (telecom finalization, 22 Nov 2026): the main process's telecom and Coverage messages (`apps/desktop/src/main/telecom.ts`, `rf.ts`) are inline English; only their "coverage settings" becomes "RF settings" now. A few catalogue strings still say "Coverage panel" (the test of the RF texts names it); they say "Coverage" when that test moves with them.
