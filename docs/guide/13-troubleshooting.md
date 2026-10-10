# Troubleshooting

## Check which version runs

- **Settings**, **About and updates** shows "Build" with the date, time and commit.
- **Projects** shows "built" with the date at the bottom of the right panel.

If they do not match the build you installed, an older copy is still running: quit it and start {product} again.

## Offline

{product} is made to run with no network. The title bar shows the mode of the workstation, **Online** or **Offline only** (see [Online or offline only](01-install.md#online-or-offline-only)).

- **Maps are empty**: no map pack covers the site. Import a pack file or download a region in **Settings**, **Offline maps**. Orthos and plans of the project still show.
- **A map download stopped**: open **Settings**, **Offline maps** and click **Resume**. If the workstation is offline-only, import a pack file instead, or click **Offline only** in the title bar and switch to **Online**.
- **The agent says it is off**: switch on **Cloud AI** in **Settings**, **Privacy and cloud**, add a key in **AI providers**, then click **Check again**. With no network, use a local model (see [Set up a local model](20-local-model.md#if-it-does-not-answer)). If it says the workstation is offline-only, cloud AI stays off whatever the **Cloud AI** switch says: use a local model on this computer, or switch off **Offline-only workstation** in **Privacy and cloud**.
- **The title bar says Online and nothing downloads**: **Online** is the mode, not the network. Click it: with no network it says "This computer has no network connection right now."
- **"Workspace ID needed"**: see [Anthropic workspace ID](07-ai-agent.md#anthropic-workspace-id).
- To make sure nothing goes out, click **Online** in the title bar and switch to **Offline only** (the same switch as **Offline-only workstation** in **Settings**, **Privacy and cloud**). Cloud AI, map downloads, online update checks and team server connections are then off. A local model on this computer still works.

## A project does not open

The Projects screen shows "The project did not open." with the reason:

- "No manifest.json in ...": pick the folder that holds `manifest.json`.
- "... is not valid JSON": a project file is damaged. Restore it from a backup.
- "Folder not found": the folder moved, or the data folder changed. Check **Settings**, **Data folder**.
- An encrypted package asks for its passphrase: ask the sender.

## Jobs do not start

- "No pipeline pack in ...": the pipeline pack is missing from `runtime` in the data folder. Copy the pack folder there; **Jobs** then shows "Processing tools" and their version.
- "There is no pipeline called ...": the pack is older than the app. Copy the matching pack; {product} uses the newest pack in `runtime`.
- A job that was running when {product} closed shows **Interrupted**: click **Resume**.

## Slow or jerky 3D (graphics tiers)

{product} picks a graphics preset for the card when it starts: **Low** for integrated graphics, higher for stronger cards.

1. In the 3D view, press **Ctrl Shift F** for the frame rate and memory overlay. Press it again to close.
2. If frames are slow, open **Settings**, **Graphics quality** and pick a lower preset.
3. In the point cloud panel, lower the **Point budget** or switch off **Eye-dome lighting**.
4. Hide layers you do not need in **Datasets**.

On **Low**, **Compare dates** shows a swipe or two maps instead of two 3D views. If the picture looks coarse on a strong card, pick **High** or **Ultra**.

## Video does not line up with the model

Use **Calibrate video** (see [Calibrate video](08-building-projects.md#calibrate-video)). Drone heights are often relative to the take-off point: fix the take-off height or the datum offset when importing (see [Camera heights](08-building-projects.md#camera-heights)).

## Report a problem

1. Note what you did, what you saw and what you expected, and the time on the timeline or the issue code.
2. Take a screenshot.
3. **Settings**, **About and updates**, **Export logs**. The file is saved in Downloads; attach it to your report.
4. Add the build line from **About and updates**.

API keys never go into the logs.
