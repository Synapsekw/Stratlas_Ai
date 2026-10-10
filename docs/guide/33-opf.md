# OPF projects

OPF (Open Photogrammetry Format) is an open format for photogrammetry projects, published by Pix4D. {product} imports an OPF project's cameras, calibration, control points and products, and exports a processing run as OPF for other software.

## Import an OPF project

1. Open a project, then **Jobs**, **New job**, **Advanced: run a pipeline directly**, **OPF import**. You can also add a `project.opf` file in the builder's **Import files**.
2. Choose the `project.opf` file and start the job.

When it is done, the project has:

- a photos layer, "… photos (OPF)", with the photos on their camera positions;
- the orthophoto and DSM on the map, and the point cloud in 3D when the OPF project has them (the point cloud needs PDAL in the pipeline pack);
- a run in `photogrammetry/` with the cameras, calibration and control points, so the products can be made again in {product}.

The job log lists what was not imported. If the OPF project names its photos by full paths and the photos are not next to it, the job asks for the folder of photos.

## Export a run as OPF

Open **Jobs**, **New job**, **Advanced: run a pipeline directly**, **OPF export**. Give the run id and an empty folder. {product} writes `project.opf` with the cameras, calibration, control points and sparse cloud, and the orthophoto and DSM in `outputs/`. A folder that is not empty is refused, so nothing is overwritten.

## What OPF does not carry here

- Meshes are not imported.
- Photos without a calibration bring their positions only.
- Fisheye and spherical cameras are not supported.
- Heights in a vertical CRS are taken as they are.
- Export writes the sparse model, not the dense cloud.
