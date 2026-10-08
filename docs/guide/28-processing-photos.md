# Processing photos

{product} turns a folder of drone photos into the layers it already shows: an orthophoto and surfaces (DSM and DTM) on the map, a point cloud and a textured mesh in 3D. Processing runs on this computer, offline, on the CPU. Nothing is sent anywhere.

## What you need

- Pipeline pack 0.4.0 or later (Settings, **Pipelines**). The pack holds the photogrammetry tools.
- Windows x64 or a Mac with Apple silicon.
- Drone photos with GPS in their metadata, taken with enough overlap: about 80% along the flight line and 70% between lines for mapping flights.
- Memory: about 300 photos per run on a 16 GB computer is a comfortable size. {product} keeps the processing below a memory limit it works out from this computer's memory, and stops a stage cleanly rather than running the computer out of memory.

Your photos are only read, never changed or moved.

## Start a run

1. Open a project. On an empty project, click **Process photos** beside **Import files**. On a project that has photos, open **Jobs**, then **Photo processing**, then **Process photos**.
2. **Photos:** choose **A photos layer** of the project, or **Folders of photos** on this computer. The wizard counts the photos and lists the cameras it found, for example "SYN-20, 1600 × 1200 (58 photos)", with a warning for photos without GPS.
3. **Place and heights:** check the **Coordinate reference system**. When the photos are far from the project's system, the wizard names the UTM zone they are in. It also says where heights come from (the drone's altitude, or ground control).
4. **Quality and products:** choose **Fast**, **Standard** or **High**, and the products: point cloud, DSM, DTM, orthophoto and mesh. For a run that is already aligned, **Jobs**, **New job**, **Create products** has the same **Products** checklist.
5. **Estimate for this computer:** the wizard shows whether processing is available here, the CPU, memory and free disk, and a time range. Click **Start**.

The stages tick in turn: reading the photos, features, matching, alignment, georeferencing, then the products. You can **Pause** a run and **Resume** it later: finished stages are kept from before. **Cancel** stops the tools within a few seconds.

When the run is done, its outputs are **Added to the project as new layers**: the orthophoto, DSM and DTM on the map, and the point cloud and mesh in 3D. Layers you had before are not changed. Click **Show in 3D** to see them.

## Quality presets

- **Fast:** reduced image size, for a quick look and a preview surface. Weak on buildings and tall structures.
- **Standard:** the everyday choice for mapping flights.
- **High:** full image size where memory allows; slower.

The estimate is a range because the scene and the computer's temperature change the time. Processing on the CPU is slower than on GPU products.

## Runs and their files

Each run lives in the project in `photogrammetry/<run>/`: its settings, stages and timings, the alignment and accuracy reports, the camera model and the products. **Jobs** lists the runs; **Open run** shows one. A run's working files take the most space; **Delete work files** moves them to the recycle bin after asking, and shows the space freed. The outputs stay.

## Use refined poses

Alignment works out where each camera really was. For a photos layer (or, for a run from folders, a **Photos layer of the same flight**, matched by file name), **Refined poses** says how far the cameras would move, for example "58 cameras move by 1.2 m on average". Click **Use refined poses**, then **Move the cameras**, to put the photos where they were taken. The previous cameras are kept as a backup.
