# Install and first start

{product} runs on one workstation and needs no network. Projects, maps and models stay on your disk.

## Install on Windows

1. Close {product} if it is running. The installer stops while it runs: "{product} is running. Close it and click Retry."
2. Run `{executable}-<version>-win-x64-setup.exe`. Choose the folder, or keep the default.
3. If Windows shows "Windows protected your PC", choose **More info**, then **Run anyway**. Only unsigned test builds show this.

No install rights? Use `{executable}-<version>-win-x64-portable.exe` instead. It runs from any folder.

To update, run the newer installer over the old version. Your projects, settings and keys stay. See [About and updates](12-settings.md#about-and-updates). The processing tools are a separate file: after an update, install the one that came with it (see [Install the processing tools](#install-the-processing-tools)).

## Install on macOS

1. Open `{executable}-<version>-mac-<arch>.dmg`.
2. Drag {product} into **Applications**.

## Install the processing tools

The tools that build maps and models from your data come as one more file beside the installer: `pipeline-pack-<version>-<platform>.tar.gz` (the pipeline pack). Viewing, measuring and reports work without it.

1. Start {product} and open **Settings**, **Processing tools**.
2. Click **Choose file** under **Install or update from file** and pick that file. If the file is in Downloads or beside the app, {product} offers it: click **Install version ... found in Downloads**.
3. When it says the tools are installed, **Jobs** shows "Processing tools" and the version.

Do this again with the new file after each update of {product}. See [Processing tools](12-settings.md#processing-tools).

## First start

Each time it starts, {product} shows its launch screen for a moment: the logo, "Welcome back," and your name (the name in **Settings**, **Identity and team**, the one written on your issues), and an **Enter** button. Press **Enter** on the keyboard, or click the button, to go to your projects; the app is already loaded underneath, so there is no wait. **Esc** (or **Skip intro**) skips the short animation. With no name of your own yet it says "Welcome" and where to set your name. To go straight to your projects every time, switch off **Show launch screen** in **Settings**, **Appearance**. With **Reduce motion** on (in **Settings** or in Windows) the screen stays still.

{product} opens on **Projects**. On a first start the library holds only the three demo projects that come with the app, and a welcome offers **Open the demo project**: a fictional tank farm with a 3D model, a drone video on the model, a map, a point cloud, issues with photos and two stockpiles surveyed twice. **Demo access road** opens the road demo. **Demo change site (2 dates)** is a small fictional site surveyed twice, for comparing dates and building models (see [Changes between two dates](14-changes.md)). All three are synthetic data; your changes to them stay on this computer.

Under **This workstation** the welcome says what is there and what is missing, and what each piece is for:

- **Data folder** where your own projects and offline map packs live. Click **Choose folder** to pick another one.
- **Offline maps**: without a map pack, maps show each project's own orthomosaics and plans. Import a pack or download a region in **Settings**, **Offline maps**.
- **Pipeline pack**: needed to build projects from raw data, for survey jobs and for **Suggest boundaries**. **Processing tools** opens the page where it installs from its file.
- **Network**: not needed.

![The Projects screen on first start, with the demo projects](images/first-start.png)

To add your own project, copy its folder into `projects` in the data folder, or click **Add project folder**.

> The data folder is `Documents\{product} Data` unless you pick another. It holds `projects`, `packs` (offline maps) and `runtime` (the pipeline pack for building projects, installed in **Settings**, **Processing tools**).

## Online or offline only

{product} works with no network. The title bar shows the mode this workstation is in, and the cloud AI chip next to it shows what that leaves of cloud AI.

- **Online** (the default): nothing goes online on its own. The app uses the network only for what you turn on or start:
  - a map region download ([Maps and offline packs](06-maps.md)),
  - an online update check (off by default),
  - cloud AI, when you switch it on ([AI agent](07-ai-agent.md)),
  - online satellite imagery, when you switch it on ([Maps and offline packs](06-maps.md#online-satellite)),
  - a team server connection ([Team server](26-team-server.md)).
- **Offline only**: the workstation makes no network connections. All five are off, and the cloud AI chip reads **Cloud AI off** or **Cloud AI blocked**, never **Cloud AI**. A local model on this computer still works.

To change the mode:

1. Click **Online** or **Offline only** in the title bar. **Connection** opens.
2. Click the switch between **Offline only** and **Online**. The change is saved at once and kept when you start {product} again.

In **Connection**, **Download maps** opens **Settings**, **Offline maps** (it reads "Go online first" in **Offline only**), and **Cloud AI** shows **On**, **Off** or **Blocked** and opens **Settings**, **Privacy and cloud**. With **Online** chosen and no network on the computer, it says "This computer has no network connection right now."

The same switch is **Offline-only workstation** in **Settings**, **Privacy and cloud**. **Ctrl K**, **Go online** or **Work offline only** does the same.

The chip shows the mode you chose, not the cable: it stays **Online** when the Wi-Fi is off.

## Get help

- Press **F1**, or click **?** in the title bar, to open this guide. Type in **Search the guide** to find a topic.
- A **?** beside a setting or a tool opens the matching section.
- **Ctrl K** opens the command palette. Type "guide" to find **User guide (F1)**.

![The user guide in the app, searched for "compare dates"](images/help.png)
