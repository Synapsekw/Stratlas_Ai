# Testing Stratlas M5: your M4 feedback, fixed

Build: `E:\Dev\AIO Software\apps\desktop\dist\Stratlas-0.1.0-win-x64-setup.exe`. Close Stratlas first: the installer now says "Stratlas is running. Close it and click Retry." if it is open. Unsigned: SmartScreen, **More info**, **Run anyway**.

**Check the build first:** Settings, About shows "Build <date>, <time> (<commit>)", and the Projects screen shows "built <date> <time>" at the bottom of the right panel. It must match the time I gave you.

Everything in `TESTING-M3.md` and `TESTING-M4.md` still applies. Below is what changed after your feedback. Tick each line or note what you saw.

## Masafi

- [ ] Toolbar: **Photo | Elevation | Cut / fill** switch, always visible. Elevation colours the terrain with its legend.
- [ ] **Section** tool: click the first point, move the mouse: the camera stays still. Click the second point: the profile appears.
- [ ] Pile register: an **eye** per pile hides its volume, toe line and m³ label in 3D; the eye in the header hides or shows every pile; the footer counts hidden piles. A selected pile always shows.
- [ ] Your boundary edit on P08 (31 Dec) is still there.

## DAMAC

- [ ] Issue labels and count badges show only on the faces you can see, not through the building. Badges count only visible issues.
- [ ] No timeline: a thin **Timeline** bar at the bottom ("No video in this project"); click it or press **T** to show it; remembered per project.
- [ ] Toolbar **pin** button (or **I**) turns issue tags off and back on; the severity heat map stays. The Layers popover agrees.

## HCl (and every project with video)

- [ ] Each flight is **one continuous clip** (Flight 101 is 6:26), 1920×1080, sharper. Flight 102 is now the right way up (the old pieces had it upside down for the first 5 minutes).
- [ ] A click on a clip bar plays from the clicked point.
- [ ] Video window: drag it by the title bar; resize from edges and corners (keeps 16:9); double-click the title to reset; remembered per project.
- [ ] Layers: an **eye at the top** (Datasets) shows or hides everything; one eye per group (Models, Point clouds, Maps, Video). Half-filled eye = some hidden.
- [ ] The tank is **not cut automatically** when the drone goes inside. Toolbar tool **Inside the asset**: Off / **Cut** / **Transparent** with an opacity slider. Point clouds hide while a mode is on. Remembered per project.
- [ ] **Split**: each side has a selector (3D, Map, Video, Photos, Ortho and plans, Report: only what the project has). Try Video on the right, Photos on the left. The 3D view only exists once.

## Al-Zour

- [ ] Videos are 1920 px (same lengths as before: they were already full length).
- [ ] Full-resolution point cloud, **Elevation**: ground blue to green, tanks yellow to red; legend about 90 to 166 m. In the point cloud popover, **Elevation range** sliders stretch the ramp; **Auto** resets.
- [ ] Opens under a **sky** with **animated water** that stays off the land, and sun shadows on the plant, the ortho and the water.
- [ ] Toolbar **sun** button (right end): **time of day** slider (morning sun from the east, evening from the west, moonlight at night), date, "Capture time" (13:22, 21 Feb 2023) and "Now", water on/off and sea level, Sky / Studio, reset. Remembered per project.
- [ ] HCl opens in **Studio** (the dark look as before); you can switch it to Sky.
- [ ] Settings, Graphics quality: water and shadow softness per tier.

## Reports and Media

- [ ] Settings, **Report branding**: company name, logo (PNG, JPG, SVG), accent colour, cover preview.
- [ ] Without branding set, a generated issue register (Issues, Export, PDF) has no logo and says "Made with Stratlas"; with it set, your logo and name. The delivered EBSM and DAMAC PDFs are unchanged (the e& in them is the client's own document).
- [ ] EBSM, **Media**: opens immediately and scrolls smoothly (thumbnails instead of 2560 px originals).

## AI

- [ ] If your Anthropic key is an organisation key: Settings, AI providers, Anthropic, enter the **Workspace ID** (starts with `wrkspc_`, from the Claude Console), or use a key created inside a workspace.
- [ ] **Test connection** next to each provider: shows the exact answer or error.
- [ ] Agent errors now show the provider's own message (never the key).

## Known limits

- Issue labels hidden behind the building can lag the camera by about a tenth of a second while orbiting.
- Report branding is one setting for all projects (no per-project override yet).
- At night the point cloud keeps its daylight colours and takes no shadows.
- A few light surf patches near the west breakwater read as land and show as flat patches on the water. The model's sea level (93.56 m) is marked indicative; adjust it in the sun popover if the waterline looks high.
- With the right panel open on a 1440 px screen, the Labels and layers buttons move into the "More" menu.
- Old video files are kept in `projects\hcl\video.before-1080` and `projects\alzour\video.before-1080` (about 0.6 GB): delete them once you are happy.
