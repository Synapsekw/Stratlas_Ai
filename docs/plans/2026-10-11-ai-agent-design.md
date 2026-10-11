# The agent can show you things (design)

Date: 11 Oct 2026. Branch: `feat/ai-agent`.

## What the founder asked for

1. "We need to have a very useful AI agent in the app that is capable of doing a variety of different things."
2. "When a user says, 'Take me to the most severe point on this asset,' it should be able to fly there."
3. "When it says, 'Open up images with the highest level of severity,' it should be able to go and open up that window and show and filter those images."
4. "Let's explore a little bit more: what could the other useful things be for this agent that lives in all of the individual projects?"

Asked afterwards, the founder said: the agent that is already in the app was tried, and it fell short. Requests 2 and 3 are the ones that failed: one "did not do anything", the other "did the wrong thing". Of four families of new abilities offered, the founder picked one for this build, **Show me**. The other three are the roadmap at the end of this document.

## What is wrong today

The app has an agent (`packages/ai`, built in M2 and extended in M8 and M9): a chat panel at the bottom of the right panel on **Scene**, about 27 tools, cloud or local models, approvals, undo, saved conversations and a cost meter. On the founder's machine it runs on Claude Sonnet 5.5 with cloud AI on, so the model is not the weak part. The gaps are in what the app gives it:

| Gap                                                                                                                                                                                              | What the person sees                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| No tool opens a screen or sets a filter. The Media filter and the Issues filters are local to their screens, so nothing outside them can set them. Media has no filter by severity level at all. | "Open the images with the highest severity" gets a sentence back and nothing happens            |
| The conversation lives inside the panel, and the panel exists only on Scene. Any step that leaves Scene ends the conversation.                                                                   | The agent cannot take you to another screen and keep talking                                    |
| A finding has no link to an asset. The issue list tool cannot sort, cannot filter by asset or area, and returns no position and no photos.                                                       | "The most severe point on this asset" becomes a guess by distance, or the whole project's worst |
| Severity reaches the model as bare numbers. The project's own level names (Minor, Moderate, Severe, or Low, Medium, High) are not in the context.                                                | "Severe", "high", "the worst" are matched by guesswork                                          |
| The agent's way of locating a finding is its own code, separate from what a click on the finding does in the app.                                                                                | The camera can end up somewhere other than where the app itself would take you                  |
| Every agent test runs a scripted stand-in for the model. Nothing checks what a real model does with a plain request.                                                                             | Requests that fail for a person pass every check                                                |

## The decision

- Extend the agent that exists. No new engine, no new provider work, no change to how keys, cloud AI switches, approvals or the send preview behave.
- The agent gets the missing abilities as tools that call the same code a click calls. What the agent does on screen is always something the person could have done by hand, and can see and undo.
- A request is checked against a real model before the branch is handed over, by a test the team can run again whenever the prompt or the tools change.

Two alternatives were set aside. A generic "click on the screen" tool would cover everything at once, but it is slow, breaks when a screen changes and cannot be undone. Offering the command palette's commands as one tool is cheap, but those commands take no arguments, so "filtered to the highest severity" stays out of reach.

## Scope

In this branch:

- The agent keeps its conversation on every screen of an open project, and is reachable on **Issues**, **Media**, **Detections** and **Reports** as well as **Scene**.
- The agent can open those screens, and can open **Media** and **Issues** with a filter already set.
- **Media** gets a filter by severity level, for people as well as for the agent.
- The agent knows which findings sit on which tagged asset and in which area, and can answer and act on "on this asset", "on tank T-101", "in the bund".
- **Show a finding** in one step: select it, fly to it, open its photo beside the 3D view.
- The agent is told the project's severity levels by name, which screen is showing and which filters are on.
- Suggested requests in the empty panel.
- An opt-in check of about 20 plain requests against a real model.
- The guide chapter and the end to end specs follow.

Not in this branch (see the roadmap):

- Guided tours, bulk changes, report drafting from the panel, comparing dates and measuring by name.
- Any change to the cloud AI switches, the providers, the routes or the send preview.
- Voice input.
- A stored link from a finding to an asset in the project files. The link is worked out when needed (see "Findings and assets").

## Behaviour

### The two requests

On the tank farm demo (six findings, each marked on the 3D model and on a photo; severity levels Minor, Moderate, Severe; 44 tagged assets in six areas):

| The person types                                                    | What happens                                                                                                                                                                                                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Take me to the most severe point on this asset" (nothing selected) | The worst finding of the project is selected, the 3D view flies to it and its photo opens beside the 3D view. The agent answers with its code, title, severity by name and the asset it sits on.                                 |
| The same, with an asset or an area selected                         | The same, among the findings on that asset or in that area. If it has none, the agent says so and offers the project's worst instead.                                                                                            |
| "Open up images with the highest level of severity"                 | **Media** opens showing only the photos that carry a finding of the highest level present in the project, worst first. A chip above the photos reads `Severe` and clears the filter when closed. The agent says how many photos. |

Ties: several findings share the worst level. The agent shows the first by code, says how many share the level and names them, so the person can ask for the next.

### The agent on every screen

- One conversation per open project, kept while the person moves between screens. It ends, as today, when another project opens or **New conversation** is pressed.
- On **Scene** the panel stays where it is. On **Issues**, **Media**, **Detections** and **Reports** it is a column on the right edge with the same panel in it. A button in the title bar and the shortcut that folds the right panel on Scene (**Ctrl Alt B**) fold it away. It starts folded on those screens, so nothing moves for people who do not use the agent, and opens by itself when the agent brings the person there; folded or not is then remembered on this machine. In the smallest window the app supports (1100 x 700) the open column leaves the screen usable: it takes at most a third of the width.
- The chip at the top of the panel names what the agent is looking at, as today: on other screens it reads the screen (`Photos`, `Issues`, `Report`).
- A step that needs the 3D view (flying, orbiting, a standard view) opens **Scene** first when another screen is showing.
- A reply under way carries on across a screen change. **Esc** and **Stop** work on any screen.
- With cloud AI off, blocked by a package, or offline-only, the column shows the same messages the panel shows today.

### Opening a screen with a filter

New things the agent can do. All are view changes: no approval, each with **Undo** on its step.

| Step           | What it does                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Show a finding | Selects it, opens **Scene**, flies to it and opens its photo (or video frame) beside the 3D view. A finding on a map only pans the map to it.                      |
| Show photos    | Opens **Media** with any of: a severity level (or "the highest present"), only photos with findings, an asset, an area, one finding, a class; ordered worst first. |
| Show findings  | Opens **Issues** with any of: severity, class, status, an asset or an area, text; sorted as asked (worst first by default).                                        |
| Open a screen  | **Scene**, **Issues**, **Media**, **Detections**, **Reports**.                                                                                                     |
| List assets    | Per tagged asset and per area: how many findings, how many open, the worst level. Answers "which tank is in the worst shape".                                      |

Each returns what it showed (a count and the first few), so the agent's answer states numbers the screen confirms.

What the person sees of a filter the agent set:

- **Media**: the **Severity** select shows the level. A filter that has no control of its own (an asset, an area, one finding) shows as a chip above the photos, for example `On Tank T-101`, with an x that clears it.
- **Issues**: the register's own controls show the severity, class, status and sort. An asset or area shows as the same kind of chip.
- An empty result is shown as the screen's normal empty state with the chip still on, and the agent says that nothing matched.

### Media: filter by severity

Next to **Only with findings** and the order, a **Severity** select: `Any`, then the project's levels worst first (and **Uncertain** when the model has it). Choosing a level shows the photos whose findings include that level. It works without the agent and is remembered while the app runs, like the two controls beside it.

### Findings and assets

A finding is linked to an asset when needed, from where it is:

- A finding with a 3D location belongs to the smallest tagged asset whose bounds contain it (with half a metre of slack). If none contains it, to the nearest one within five metres. Otherwise it has no asset.
- Its area is the asset's area (the component group).
- A finding marked only on a photo has no 3D point. **Show a finding** then puts the camera where that photo was taken, looking the way the photo looks, opens the photo, and the agent says the finding is on a photo only.
- A finding marked only on a photo or only on a map has no asset. The agent says so when it matters ("3 findings are marked on photos only and are not counted per asset").

"This asset" in a request means the selected asset or area. With nothing selected it means the whole project, since a project is often one asset.

The link is not written to the project files, so nothing changes for existing projects, packages or the Team Server.

Known limit: bounds are boxes. On a crowded pipe rack a finding can fall inside two boxes; the smallest wins, which is right more often than not. The agent names the asset it used, so a wrong pick is visible.

### What the agent is told

Added to the context sent with each message (text only, as today, and covered by the same send preview):

- The screen that is showing.
- The severity levels of the project's models: value, name and criteria.
- The filters that are on in Media and Issues.
- For a selected asset or area: how many findings it has and the worst level.

The instructions gain: what "this asset" means; that "highest severity" means the highest level present among the findings in question, not the top of the scale; that a request to see something is answered by doing it and then saying what was done in one or two sentences; that severity is spoken by name.

### Suggested requests

An empty conversation shows up to four requests as buttons, picked for the screen and the project: for example **Take me to the most severe finding**, **Show the photos with the highest severity**, **Which asset has the most findings?**, **What is on screen?** A click sends it. They disappear once the conversation has a message. Requests that cannot work in the project are left out (no photo request in a project without photos).

## Known limits

- The agent is as good as the model behind it. A small local model with the compact tool list gets **Show a finding**, **Show photos** and **Show findings** but not **List assets**.
- Detections that have not been accepted are counted on photos in Media (as today) but are not findings, so "the most severe finding" does not include them. The agent says so when asked about photos.
- The agent column is not shown on the Globe, Settings, the project list or the Review screen.

## How it is built

- `packages/ai`
  - `AgentPanel` takes the session as a prop; without one it makes its own, as today (the tests keep working).
  - `AppHooks` gains `screen()`, `openScreen(screen)`, `showPhotos(filter)`, `showIssues(filter)`, `showEvidence(issueId)`, `viewFilters()`. Every hook stays optional and a tool that needs a missing one fails with a fixed message, as today.
  - `asset-index.ts`: `assetOfIssue` and `assetSummary`, pure functions over the place index (asset and area bounds) and the issues.
  - Tools `show_issue`, `show_photos`, `show_issues`, `open_screen`, `list_assets` in a new `show-tool-specs.ts` and `show-tools.ts`; `list_issues` gains `sort`, `asset`, `area` and returns asset, area, severity name, position and photo count per row; `summarize_issues` rows gain the same. `show_issue` and the camera tools locate a finding through one shared function.
  - `context.ts` and `prompt.ts` as described above; `suggestions.ts` picks the suggested requests.
- `packages/annotate`: the register's filters move from local state to a small store (`issueView`), reset when the project changes. The register reads and writes it; the hooks set it. A scope (a set of issue ids with a label) is the chip.
- `apps/desktop` renderer
  - `agent/session.ts`: the one session of the app. `agent/AgentDock.tsx`: the column on the other screens. `WorkspaceScreen` passes the same session to its panel.
  - `screens/mediaView.ts`: the Media filter as a store (only with findings, order, severity level, scope chip); `Media.tsx` reads it. `mediaFindings.ts` gains the level filter.
  - `bootstrap.ts` registers the new hooks.
- `packages/ui`: the new strings in `i18n/en.ts`.
- `docs/guide/07-ai-agent.md` and the guide chapter that describes the Media filters follow.

The agent loop, the providers, the IPC channels and the main process do not change.

## Contract changes

None expected. The tool catalogue, `AppHooks` and the stores live outside `@aio/schema`; `WindowKind` already has `photo`, `issues` and `report`. If the build finds it needs one, it gets a row in `docs/architecture/contract-changes.md` and a line in the hand-off.

## Edge cases

- No project open: the column is not shown; the tools answer "No project is open."
- A project without photos: **Show photos** answers that the project has none and does not open Media.
- A severity name that is not a level of the project ("critical" in a Minor, Moderate, Severe project): the agent maps it to the highest level present and says which level it used.
- Mixed severity models in one project: levels are compared by value, as the app does everywhere; the answer names the level by its own model's name.
- A finding without any location and without a photo: it is selected and its card opens; the agent says it has nothing to fly to.
- The 3D model is still loading: asset bounds are not known yet. The asset tools answer "the model is still loading" instead of "no findings on this asset".
- A read-only package: every new step is a view change, so all of them work.
- The person changes a filter by hand after the agent set it: the person's change stands; the chip goes when they clear it.
- **Undo** on a step that changed screen puts the screen, the filter, the selection, the camera and the split back as they were.
- Offline-only switched on mid reply: the reply stops before its next step, as today, wherever the person is.

## Tests

- Unit: `assetOfIssue` (inside, nearest, none, photo only, two boxes); each new tool with a stub host (input checks, results, undo); the level filter in `mediaFindings`; the `issueView` and `mediaView` stores; the context (screen, levels, filters); the suggestions; the session surviving a panel unmount.
- End to end, scripted model, in CI: `agent-show.spec.ts` on the demo project. A scripted "show the worst finding" selects it, flies and opens the evidence; a scripted "show photos, highest severity" lands on Media with the level set, the right photo count and the conversation still there; the column folds and unfolds; Undo puts Scene back. The existing `agent.spec.ts`, `agent-camera.spec.ts`, `agent-local.spec.ts` and `offline-cloud-ai.spec.ts` keep passing unchanged, and `network.spec.ts` still proves zero requests with cloud AI off.
- Real model, opt-in, never in CI: `agent-eval.spec.ts` runs about 20 plain requests (the founder's two, their rewordings, asset and area questions, a project without photos, an unknown severity name) and checks the tool calls and the state of the app after each. It runs only when a provider key is in the environment, and prints a pass table and the token cost. The build does not run it and takes no key from anywhere: the first run is the founder's. Until then the two requests are verified on the scripted model only, and the hand-off says so.

## The roadmap: what else the agent could do

Ranked by how much they would be used against how much they cost to build. None of these is in this branch.

| Family              | Examples                                                                                                                             | Builds on                                                            | Size   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ------ |
| Walk me through     | "Walk me through the five worst findings", then next and back; one line per stop; good for client reviews and handovers              | This branch's show a finding; a small tour state in the panel        | Small  |
| Compare and measure | "What changed on this tank since the last survey" with the split compare set up; survey dates by name; "how tall is tank T-101"      | The change tools and the timeline that exist; measure by name        | Medium |
| Do the paperwork    | "Mark the minor findings in the bund as reviewed", "raise F05 to severe", "draft the summary", "export a PDF of the severe findings" | The register's bulk actions, Draft with AI, the exporters; approvals | Medium |
| Ask the guide       | "How do I export a report?" answered from the user guide, with a button that opens the right screen                                  | The guide shipped with the app; open a screen from this branch       | Small  |
| Look at this        | "What do you see in this photo?", "is this corrosion or staining?", a second opinion on a detection                                  | The vision route and frame capture that exist                        | Medium |
| Run the processing  | "Make the maps from the new photos", "how far is the processing?"                                                                    | The Processing drawer and its runs                                   | Medium |
| Briefing on open    | Opening a project: three lines on what is new since the last visit and what waits for review                                         | The change sets, the journal, the team approvals                     | Medium |
| Voice               | Hold a key and speak the request, for reviews on a wall screen                                                                       | A local speech model; nothing exists yet                             | Large  |

Suggested order: Walk me through first (it reuses nearly everything from this branch and is the most visible in front of a client), then Ask the guide, then Compare and measure.

## Merge order

The branch touches files other branches in flight also touch: the tool catalogue in `packages/ai/src/tools.ts` (the branch that removes the original review edits one tool there), `Media.tsx`, `WorkspaceScreen.tsx` and `App.tsx`. The Orchestrator has set the order: this branch lands last, after `feat/remove-original-review` (which removes the `open_original_review` tool and the Review screen, so the column is not added to Review), `fix/split-view-parity`, `feat/project-types` and `feat/street-map-3d`, rebasing as each reaches `main`.

## Decisions

The founder passed the design decisions to the Orchestrator session, which decided on 11 Oct 2026: extend the existing agent; the agent stays where it is on Scene and gets a folding column on the other project screens, one conversation; a photo-only finding flies to the photo's camera; the real-model check ships opt-in and is first run by the founder; this branch lands last. Conditions: every filter the agent sets is visible and can be cleared, no new step edits project data, and the column works in the small window.
