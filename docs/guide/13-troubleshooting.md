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
- **An online map shows nothing, or only blurred imagery**: the provider cannot be reached, the workstation is offline-only, or a Mapbox map has no key. When the chosen map cannot be drawn, the Map chip says **Offline map** and the offline street map shows instead. Sentinel-2 still draws the areas you viewed before. Check the key with **Test** in **Settings**, **Map sources**, then move the map to ask again. See [Online maps](06-maps.md#online-maps).
- To make sure nothing goes out, click **Online** in the title bar and switch to **Offline only** (the same switch as **Offline-only workstation** in **Settings**, **Privacy and cloud**). Cloud AI, map downloads, online maps, online update checks and team server connections are then off. A local model on this computer still works.

## A project does not open

The Projects screen shows "The project did not open." with the reason:

- "No manifest.json in ...": pick the folder that holds `manifest.json`.
- "... is not valid JSON": a project file is damaged. Restore it from a backup.
- "Folder not found": the folder moved, or the data folder changed. Check **Settings**, **Data folder**.
- An encrypted package asks for its passphrase: ask the sender.

## Processing does not start

- "Processing cannot run yet: the processing tools are missing or need an update" (in the **Processing** drawer), the processing tools are not installed. The reason shows in **Settings**, **Processing tools**, under **Status**, for example "No pipeline pack in ...". Click **Update processing tools** (or open **Settings**, **Processing tools**), click **Choose file** under **Install or update from file** and pick the pipeline pack file that came with the installer. The page then shows the version, and processing uses it from then on.
- "There is no pipeline called ...", or "The processing tools need an update": the pack is older than the app, which happens after an update of {product}. Install the pack that came with this version the same way; {product} uses the newest pack it has.
- "These processing tools are for ..., and this computer is ...": the file is for another kind of computer. Pick the one for this computer.
- "This file is damaged" or "This file is incomplete": the file did not copy whole. Copy or download it again.
- See [Processing tools](12-settings.md#processing-tools).
- A job that was running when {product} closed shows **Interrupted** in the **Processing** drawer: click it, then **Resume**.

## Slow or jerky 3D (graphics tiers)

{product} picks a graphics preset for the card when it starts: **Low** for integrated graphics, higher for stronger cards.

1. In the 3D view, press **Ctrl Shift F** for the frame rate and memory overlay. Press it again to close.
2. If frames are slow, open **Settings**, **Graphics quality** and pick a lower preset.
3. In the point cloud panel, lower the **Point budget** or switch off **Eye-dome lighting**.
4. Hide layers you do not need in **Datasets**.

On **Low**, **Compare dates** shows a swipe or two maps instead of two 3D views. If the picture looks coarse on a strong card, pick **High** or **Ultra**.

On a computer without a graphics card, the 3D picture can hold still for a moment when 3D Tiles first appear or when **Section** or the cutaway is switched on or off. The rest of the window keeps working, and the picture catches up by itself.

## Video does not line up with the model

Use **Calibrate video** (see [Calibrate video](08-building-projects.md#calibrate-video)). Drone heights are often relative to the take-off point: fix the take-off height or the datum offset when importing (see [Camera heights](08-building-projects.md#camera-heights)).

## Report a problem

1. Note what you did, what you saw and what you expected, and the time on the timeline or the issue code.
2. Take a screenshot.
3. **Settings**, **About and updates**, **Export logs**. The file is saved in Downloads; attach it to your report.
4. Add the build line from **About and updates**.

API keys never go into the logs.
