# Testing Stratlas M3: all six projects

Build: `E:\Dev\AIO Software\apps\desktop\dist\Stratlas-0.1.0-win-x64-setup.exe` (or the portable `...-portable.exe` beside it). Unsigned, so SmartScreen shows "Windows protected your PC": choose **More info**, then **Run anyway**. Install over the previous version.

Projects and map packs load from `E:\Stratlas Data`. Everything runs offline; the title bar shows **Offline**.

## What is new since your last test

| Area            | Change                                                                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projects        | Four more projects: **EBSM flare stack**, **DAMAC Hills tower**, **Masafi stockpiles**, **1st Ring Road** (six in total, 5.3 GB)                                                                    |
| Original review | Each imported project can open its **original review** (the HTML report it was delivered with) inside Stratlas, offline, with all its features: sidebar **Original review** or Ctrl+K               |
| Flight paths    | Toolbar **Flight paths** tool or **P**: All / Active clip / Off. The eye on a sidebar flight row hides that flight's path only                                                                      |
| Point cloud     | Toolbar **Point cloud** button (cloud icon): colour by RGB / **Elevation** / Intensity / Flight, size, budget, EDL; elevation legend in metres. Also from the gear on sidebar cloud rows and Ctrl+K |
| Al-Zour photos  | Mavic Cine photos show as **pins** over the plant; click one to open the photo                                                                                                                      |
| Drone-eye       | No more flicker on Al-Zour                                                                                                                                                                          |
| Panoramas       | Click a panorama marker to step inside; drag to look, scroll to zoom, Esc returns                                                                                                                   |
| Plot plans      | Al-Zour plot plans overlay the ortho as red line art                                                                                                                                                |

## Checklist

Tick each line or note what you saw (screenshot plus the time on the timeline).

### Library

- [ ] Projects shows 6 projects with thumbnails, sizes and layer counts; the map packs list GCC, Kuwait, World.

### KIPIC Al-Zour

- [ ] Plant on the ortho; play DJI_0665 (Flight 1): video drapes onto the tanks.
- [ ] **P** cycles flight paths All / Active / Off; drone and its frustum stay visible.
- [ ] Point cloud button: show the cloud, colour by Elevation, legend appears.
- [ ] Photo pins visible; clicking one opens the photo.
- [ ] Drone-eye view (camera button) while playing: steady, no flicker.
- [ ] Panorama marker: immersive view, Esc returns.
- [ ] Maps and rasters: switch on a plot plan; it lines up with roads and tanks.

### HCl Tank 710-D-130335

- [ ] Play a clip inside the tank: cut-away shows the projected video; **C** inside view.
- [ ] Point cloud colour by Elevation (RGB is disabled: this LiDAR has intensity only).
- [ ] Your 2 issues from the last test are still there (13 issues).

### EBSM flare stack (EQUATE)

- [ ] Stack model with issue pins; 299 photos; Issues lists F01 to F78 and 53 uncertain areas (U codes).
- [ ] Open a photo from an issue: corrosion mask overlay with opacity slider.
- [ ] Original review opens and works (findings map, photo masks, downloads save through a Windows dialog).

### DAMAC Hills tower

- [ ] Tower with photo cameras around it; Issues: 656 defects (D codes) + 45 uncertain; RGB and thermal photo layers.
- [ ] Open a thermal photo with its overlay.
- [ ] Known: too many pin labels on the tower (being fixed now, see below).

### Masafi stockpiles

- [ ] Two terrains (31 Dec 2020, 10 Jan 2021) with pile callouts showing volumes (P03 10,237 m³); click a pile.
- [ ] Original review: volumes, base surfaces, sections, boundary editor; edit a toe line and save, reopen: the edit is kept.

### 1st Ring Road

- [ ] Map: 2,115 defects along the ring road on the offline Kuwait map (Arabic labels).
- [ ] Issues: open one; its close-up photo shows the outline.
- [ ] Original review: PCI grid, filters, measure.

### Everywhere

- [ ] Ctrl+K finds projects, layers, issues and actions; Ctrl+B collapses the sidebar.
- [ ] Settings: AI providers (your key is stored in Windows Credential Manager), Cloud AI switch, map packs.
- [ ] Annotate (**A**): draw a box on a photo or video frame, pick class and severity; the issue appears with a pin.

## Known limits in M3

- DAMAC and Ring Road show too many issue labels and markers; clustering is being built (stream N8).
- Masafi volumes and the road PCI grid are full-featured in the original review; native workspaces are being built (N1, N2).
- Ring Road ortho on the map shows at reduced detail until N2 lands.
- In-app PDF viewer, exports (CSV, GeoJSON, COCO, masks), customer packages, light theme and the map pack manager are in progress (N3, N4, N6).
- Al-Zour clip field of view is estimated; calibration against the model is being built (B2).
- HCl map position and DAMAC origin height are approximate (the sources have no survey control).
- Unsigned build.

## What is being built now (next phase, 10 parallel streams)

N1 native volumetric workspace, N2 native road workspace, N3 reports and exports, N4 customer packages and read-only player, N5 AI history, preview and cost, N6 map pack manager, light theme, offline updates, Store package, N7 full-resolution point clouds (COPC) and performance presets, N8 issues at scale, B1 Python pipeline runtime (Release B), B2 new-project wizard, raw import and alignment.
