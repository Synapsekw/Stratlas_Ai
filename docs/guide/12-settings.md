# Settings

Click **Settings** at the bottom of the sidebar. The pages are grouped:

- **Intelligence**: **AI providers**, **Usage and cost**, **Privacy and cloud** (see [AI agent](07-ai-agent.md)).
- **Data**: **Data folder**, **Offline maps** (see [Maps](06-maps.md)), **Severity models**, **Report branding** (see [Reports](10-reports-and-exports.md#report-branding)).
- **App**: **Graphics quality**, **Appearance**, **About and updates**.

The **?** at the top right of each page opens its section of this guide.

## Data folder

The data folder holds `projects`, `packs` (offline maps) and `runtime` (the pipeline pack).

1. **Settings**, **Data folder**.
2. Click **Change folder** and pick the folder. The library reloads.

On the same page:

- **Your name on issues**: the name recorded on the issues you create.
- **Pipeline pack**: the version {product} found in `runtime`, or what is missing.

![The Data folder page](images/settings-data.png)

## Graphics quality

{product} picks a preset for the graphics card when it starts. To choose another on this workstation:

1. **Settings**, **Graphics quality**.
2. Click **Low**, **Medium**, **High** or **Ultra**. **Auto** goes back to the detected preset.

| Preset | Points | Eye-dome lighting | Shadow map | Water    | Pixel ratio |
| ------ | ------ | ----------------- | ---------- | -------- | ----------- |
| Low    | 2 M    | off               | 1024       | still    | 1x          |
| Medium | 4 M    | on                | 2048       | animated | 1x          |
| High   | 8 M    | on                | 4096       | animated | 1.5x        |
| Ultra  | 16 M   | on                | 4096       | animated | 2x          |

Integrated graphics get **Low**; laptop graphics one step lower than the desktop card. **Graphics card** shows what the system reports. Changes in the point cloud panel after picking a preset are kept.

![Graphics quality](images/settings-graphics.png)

## Appearance

- **Theme**: **Dark** (the working theme), **Light** (bright rooms, printouts) or **System**.
- **Layout direction**: **Left to right** or **Right to left**. Right to left mirrors the panels; maps, timelines and the 3D view keep their orientation.
- **Language**: English.

## About and updates

- The version and the build line ("Build" with the date and commit). Quote it when you report a problem.
- **Folders**: **Open** the data folder, the app settings or the logs. **Export logs** saves them as one text file.
- **Install update from file**: click **Choose installer**, pick a newer installer; {product} checks it, then **Install and restart**. Works with no network.
- **Check for updates online**: off by default. Switch it on to check an update address you were given.
- **Third-party licences** used by {product}.

## Keyboard shortcuts

### Everywhere

| Keys       | Does                            |
| ---------- | ------------------------------- |
| F1         | Open or close this guide        |
| Ctrl K     | Command palette: find anything  |
| Ctrl B     | Fold or unfold the sidebar      |
| Ctrl Alt B | Fold or unfold the right panel  |
| Space      | Play or pause (Scene)           |
| Esc        | Close a dialog, popover or tool |

### Scene

| Keys         | Does                             |
| ------------ | -------------------------------- |
| 1            | 3D view                          |
| 2            | Map                              |
| 3            | Split                            |
| H            | Whole site                       |
| F            | Fly to the selection             |
| M            | Measure a distance               |
| X            | Section plane                    |
| L            | Labels: off, key, all            |
| A            | Annotation tools                 |
| I            | Issue pins off or on             |
| P            | Flight paths                     |
| D            | Drone telemetry                  |
| T            | Timeline                         |
| W            | Video window                     |
| C            | View from inside the active clip |
| Ctrl Shift F | Frame rate and memory overlay    |

### Video window

| Keys       | Does                       |
| ---------- | -------------------------- |
| K or Space | Pause                      |
| L          | Play; again for faster     |
| J          | Slower, or back one second |
| , and .    | One frame back or forward  |

### Detections

| Keys           | Does                        |
| -------------- | --------------------------- |
| J and K        | Next and previous detection |
| A or Enter     | Accept                      |
| L              | Link to an issue            |
| X              | Reject                      |
| U              | Uncertain                   |
| 1 to 9         | Severity                    |
| C              | Class                       |
| N              | Note                        |
| Ctrl Z, Ctrl Y | Undo, redo                  |

### Photo viewer and full-size photos

| Keys        | Does                             |
| ----------- | -------------------------------- |
| Left, Right | Previous and next photo          |
| F           | Fit                              |
| Plus, Minus | Zoom                             |
| M           | Markings off and on              |
| B, R, P, O  | Box, rotated box, polygon, point |
