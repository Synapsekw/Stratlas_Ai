# Install and first start

{product} runs on one workstation and needs no network. Projects, maps and models stay on your disk.

## Install on Windows

1. Close {product} if it is running. The installer stops while it runs: "{product} is running. Close it and click Retry."
2. Run `{product}-<version>-win-x64-setup.exe`. Choose the folder, or keep the default.
3. If Windows shows "Windows protected your PC", choose **More info**, then **Run anyway**. Only unsigned test builds show this.

No install rights? Use `{product}-<version>-win-x64-portable.exe` instead. It runs from any folder.

To update, run the newer installer over the old version. Your projects, settings and keys stay. See [About and updates](12-settings.md#about-and-updates).

## Install on macOS

1. Open `{product}-<version>-mac-<arch>.dmg`.
2. Drag {product} into **Applications**.

## First start

{product} opens on **Projects**. With no projects yet, the screen says "No projects in the library yet" and lists three steps:

1. **Pick the data folder** where projects and offline map packs live. Click **Change data folder**.
2. **Add a project**: copy its folder into `projects`, or click **Add project folder**.
3. **Add maps**: in **Settings**, **Offline maps**, import a map pack file or download a region.

![The Projects screen on first start](images/first-start.png)

> The data folder is `Documents\{product} Data` unless you pick another. It holds `projects`, `packs` (offline maps) and `runtime` (the pipeline pack for building projects).

## Check that you are offline

The title bar always shows **Offline**: {product} works with no network. The app goes online only when you start one of these:

- a map region download ([Maps and offline packs](06-maps.md)),
- an online update check (off by default),
- cloud AI, when you switch it on ([AI agent](07-ai-agent.md)).

## Get help

- Press **F1**, or click **?** in the title bar, to open this guide. Type in **Search the guide** to find a topic.
- A **?** beside a setting or a tool opens the matching section.
- **Ctrl K** opens the command palette. Type "guide" to find **User guide (F1)**.

![The user guide in the app, searched for "compare dates"](images/help.png)
