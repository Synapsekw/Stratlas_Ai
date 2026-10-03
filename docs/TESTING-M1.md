# Testing Stratlas M1

## Install

- Installer: `E:\Dev\AIO Software\apps\desktop\dist\Stratlas-0.1.0-win-x64-setup.exe` (per-user, choose a folder).
- Or no install: `E:\Dev\AIO Software\apps\desktop\dist\Stratlas-0.1.0-win-x64-portable.exe`.
- The build is **unsigned**, so Windows SmartScreen shows "Windows protected your PC": choose **More info**, then **Run anyway**. Signed builds come once the certificates exist.

The app reads projects and map packs from `E:\Stratlas Data` (change it in Settings, Data folder). Everything runs offline; the title bar shows **Offline**.

## Projects available

| Project                     | Status | Contents                                                                                                                                                             |
| --------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HCl Tank 710-D-130335 (KOC) | Ready  | Tank model with 54 tagged components, 10 LiDAR flights (1.4 M points), 76 video clips in 10 flights, 257 posed photos, 11 issues F01 to F11, PDF report              |
| KIPIC Al-Zour LNG terminal  | Ready  | Plant model with 404 tagged assets in 12 areas, drone ortho (8 cm), 10.1 M point cloud, 25 clips in 5 flights with flight paths, 12 photos, 12 panoramas, street map |

## Things to try (HCl)

1. **Projects:** open HCl Tank.
2. **3D:** orbit (left drag), pan (right drag), zoom (wheel). Toolbar: Top / North / Iso views, measure, section cut, labels (L: Off, Key, All).
3. **Play video:** click a clip bar in the timeline or a clip in the sidebar under Video. The video window shows the live frame with altitude, speed, gimbal and heading. Inside the tank, the tank cuts open toward the drone so you can see the video projected on the wall. Press **C** for the inside view behind the drone. **Space** plays and pauses; **J K L** and arrow keys in the video window step and shuttle.
4. **Map / Split:** the offline street map of Kuwait with the issue markers; Split shows 3D and map together.
5. **Issues:** the Issues tab (right panel or the Issues screen). Select F05: the camera flies to it.
6. **Annotate:** press **A** for Annotate mode. In the video window choose Box, draw on the frame, pick a class and severity: a new issue appears with a pin on the tank (back-projected from the drone pose). Mesh tools: Pin, Line, Area on the model; Cloud point and Cloud box on the LiDAR.
7. **Photos:** Media screen, or click a photo camera in 3D (visible with a section or the cut-away).
8. **Command palette:** **Ctrl+K** searches projects, layers, issues and actions. **Ctrl+B** collapses the sidebar.
9. **AI agent:** Settings, AI providers: switch on Allow cloud AI and add your own key (Anthropic, OpenAI or Google). Then ask the agent panel, for example "Which clips show F05?" or "Fly to the roof nozzles". Keys are stored in Windows Credential Manager, never in files.

## Things to try (Al-Zour)

1. Open **Al-Zour LNG Import Terminal**: the plant sits on the drone ortho at the shoreline.
2. Click a clip (sidebar Video or timeline): the drone flies its path and its live frame is draped onto the tanks and ground from the drone pose. Try **DJI_0665** (Flight 1, clip 3) over the LNG tanks.
3. Point cloud: Maps and rasters and Point clouds in the sidebar toggle layers; the toolbar sets point size and colour.
4. Click a tank or building to select it (asset tag and area), Labels (L) to see area callouts.
5. Map and Split: the plant on the offline street map with flight paths and the live footprint.
6. Annotate (A): pin an issue on a tank or draw on a video frame; it is saved to the project.

## Known limits in M1

- Position of the HCl tank on the map is approximate (the source has no survey position); flight start times are nominal, relative timing is exact.
- Point clouds hide while a clip plays inside the tank (the cut-away view).
- Al-Zour plot plans are misplaced (hidden by default; fix in progress) and panoramas have no viewer yet (in progress).
- Al-Zour clip field of view is estimated (79 to 83 degrees), so projected video can look slightly doubled on tank rims.
- No light theme yet; Arabic UI not yet.
- Unsigned build; no auto-update.

Report anything odd with a screenshot and the time shown on the timeline.
