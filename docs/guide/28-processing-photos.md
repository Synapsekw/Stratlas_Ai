# Creating maps from photos

{product} turns a folder of drone photos into maps and a 3D model: a photo map (orthophoto) and surface models on the map, a point cloud and a 3D model in 3D. It runs on this computer, offline. Nothing is sent anywhere, and your photos are only read, never changed or moved.

## Create maps

1. Open a project, then click **Create maps from photos**. The button is at the top of **Jobs**, first under **New job**, and beside **Import files** on an empty project.
2. Choose the photos: drop a folder of photos on the window, or click **Choose a folder**. On a project that already has photos, **Photos in this project** is chosen for you. Folders inside the folder are read too.
3. Read the summary, for example "248 photos, 1 camera, GPS on all", and the time on this computer underneath.
4. Click **Create maps**.

That is all. Everything else is chosen for you: **Standard** quality, the photo map, the surface models (DSM and DTM), the point cloud and the 3D model, in the project's coordinate system.

### When {product} asks a question

A question only shows when your photos raise it:

- **Coordinate system:** the photos were taken in another UTM zone than the project uses. Choose which the maps should use.
- **No GPS:** some or all photos have no GPS position. Photos without one are placed by matching the others. With no GPS at all, the maps cannot sit in the right place until you add ground control points.
- **Disk space:** the data drive is too small for the run. Free some space, or switch to a quicker quality with the button beside the message.
- **Time:** the chosen quality would take a working day or more on this computer. The message gives the time of the next quicker quality and a button to switch to it.

### If maps cannot be made on this computer

{product} checks this the moment you click **Create maps from photos**, before you choose anything:

- **The processing tools are not installed**, or **The processing tools need an update**: click **Update processing tools**. Maps from photos need version 0.4.0 or later. **Jobs** shows "Processing tools" and their version at the top.
- **This computer cannot create maps from photos**: processing runs on Windows x64 and on Macs with Apple silicon. Other computers can open the results.

## Options

**Options**, on the same screen, holds every choice you can change. You do not need to open it.

- **Quality:** **Quick**, **Standard** or **High**.
  - **Quick:** photos at a quarter of their size, for a quick look and a preview surface. Weak on buildings and tall structures.
  - **Standard:** the everyday choice for mapping flights.
  - **High:** photos at full size, for close-range inspection and fine detail. Much slower.
- **What to create:** the photo map (orthomosaic), surface model (DSM), terrain model (DTM), point cloud, 3D model (textured mesh) and 3D Tiles.
- **Coordinate system:** the project's, the UTM zone the photos are in, or another you search for.
- **Camera positions (GNSS)** and **Heights:** how far the photos' positions are trusted, and where heights come from.
- **Survey date:** the date the new layers belong to.
- **I have ground control points:** the run stops after matching the photos, so you can mark the points before the maps are built.
- **This computer and the cameras:** the processor, memory and free disk, and the cameras found, for example "SYN-20, 1600 × 1200 (58 photos)".

Processing runs on the processor. Graphics card acceleration is not available yet.

## While it runs

One run, one list of steps: **Reading photos**, **Matching photos**, **Building the map**, **Building the 3D model**, **Adding to the project**. **Every step** shows the detailed stages underneath. You can **Pause** a run and **Resume** it later: finished steps are kept from before. **Cancel** stops the tools within a few seconds and keeps the work so far.

The time is a range, because the scene and how warm the computer runs change it. About 300 photos per run on a 16 GB computer is a comfortable size. {product} keeps the processing below a memory limit it works out from this computer's memory, and stops a step cleanly rather than running the computer out of memory.

For good results, fly with enough overlap: about 80% along the flight line and 70% between lines for mapping flights.

## Your maps are ready

When the run is done it says **Your maps are ready** and lists the new layers. Layers you had before are not changed.

- **Show on map** opens the photo map and the surface models on the map.
- **Show in 3D** opens the point cloud and the 3D model.
- **Improve accuracy with ground control points** is the optional next step for survey accuracy: import the points, mark them on the photos, then **Adjust**. See [Ground control and accuracy](29-ground-control-and-accuracy.md).

## Runs and their files

**Jobs** lists each run under **Maps from photos**. **Open run** shows one; **Create maps again** rebuilds its maps; **Export as OPF** writes it for other programs.

Each run lives in the project in `photogrammetry/<run>/`: its settings, steps and timings, the accuracy reports, the camera model and the outputs. A run's working files take the most space; **Delete work files** moves them to the recycle bin after asking, and shows the space freed. The outputs stay.

## Use refined poses

Matching works out where each camera really was. For a photos layer (or, for a run from folders, a **Photos layer of the same flight**, matched by file name), **Refined poses** says how far the cameras would move, for example "58 cameras move by 1.2 m on average". Click **Use refined poses**, then **Move the cameras**, to put the photos where they were taken. The previous cameras are kept as a backup.
