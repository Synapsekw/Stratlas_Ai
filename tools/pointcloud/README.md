# Point cloud tools

Offline conversion of survey clouds to COPC (Cloud Optimized Point Cloud) for the `copc` layer
format of `@aio/pointcloud`. A COPC layer's points are in the project CRS: the viewer maps them to
the local frame with the manifest `origin` (`x = E - origin[0]`, `y = H - origin[2]`,
`z = origin[1] - N`).

PDAL (BSD) does the conversion. untwine is GPL: do not use it.

## PDAL

Installed outside the repository from conda-forge with micromamba (no admin rights needed):

```powershell
mkdir E:\Dev\tools\micromamba
curl.exe -L -o E:\Dev\tools\micromamba\micromamba.exe https://github.com/mamba-org/micromamba-releases/releases/latest/download/micromamba-win-64
$env:MAMBA_ROOT_PREFIX = 'E:\Dev\tools\micromamba\root'
E:\Dev\tools\micromamba\micromamba.exe create -y -p E:\Dev\tools\pdal -c conda-forge pdal
E:\Dev\tools\pdal\Library\bin\pdal.exe --version   # pdal 2.10.2
```

## A small cloud: one command

```powershell
pdal translate in.laz out.copc.laz -w writers.copc `
  --writers.copc.threads=20 --writers.copc.a_srs=EPSG:32639 `
  --writers.copc.scale_x=0.001 --writers.copc.scale_y=0.001 --writers.copc.scale_z=0.001 `
  --writers.copc.offset_x=auto --writers.copc.offset_y=auto --writers.copc.offset_z=auto
```

Set `threads` (the default is far slower) and the offsets (PDAL fails silently without them on
text input). writers.copc holds every point in memory, about 115 bytes a point: 42 M points took
75 s and 4.8 GB on the reference workstation (RTX 5070 Ti, 64 GB, 24 threads). Above roughly
400 M points on 64 GB, convert by octree cells and merge (next section).

## Al-Zour full resolution (842 M points)

Source: `\\DanNas\Work Data\Asset Inspections\Oil and Gas\LNG Terminal\Point_Cloud\Production_2-Final.laz`
(3.67 GB, 841,703,158 points, point format 2, UTM 39N, Metashape heights), copied to
`E:\Stratlas Data\sources\alzour-fullres\`. It is the only LAS, LAZ, E57 or PLY file under the
LNG Terminal folder.

```powershell
node tools/pointcloud/frame-check.mjs E:/Dev/tools/pdal/Library/bin/pdal.exe "E:/Stratlas Data/sources/alzour-fullres/work"
node tools/pointcloud/alzour-copc.mjs `
  --src "E:/Stratlas Data/sources/alzour-fullres/Production_2-Final.laz" `
  --out "E:/Stratlas Data/sources/alzour-fullres/work/alzour.copc.laz" `
  --work "E:/Stratlas Data/sources/alzour-fullres/work" `
  --pdal E:/Dev/tools/pdal/Library/bin/pdal.exe --jobs 6
copy "E:\Stratlas Data\sources\alzour-fullres\work\alzour.copc.laz" "E:\Stratlas Data\projects\alzour\clouds\"
```

What `alzour-copc.mjs` does:

1. **Frame** (`alzour-frame.mjs`, PDAL `filters.ferry` + `filters.assign`): the png-packed review
   cloud was shifted -1/-2 m along the plant grid E/N and levelled with a quadratic surface over
   the plant grid, with the plant coordinates clamped to the plant area. The constants were
   recovered by matching the 10.1 M review points (a 1.2 % thinning of the same file) to a 1/200
   sample of the LAZ by position and colour: 153 k matches, the shift is
   (-1.569, -1.593) m in UTM, and the median height residual is within 3 cm in every 200 m cell.
   Heights become plant elevations (EL, grade 100), the manifest's vertical datum.
   `frame-check.mjs` checks the PDAL expressions against the JavaScript reference (5e-7 m).
2. **Cells**: a 2200 m cube from E 244770, N 3178785, EL 70; each 550 m cell (octree depth 2) is
   cropped in a streaming pipeline (low memory, 6 at a time).
3. **Top levels**: a 1/50 sample in a COPC whose cube is the whole octree.
4. **Dense cells split**: `writers.copc` slows down sharply above about 100 M points (one
   330 M point cell ran over an hour on one core and paged), so cells above `--split`
   (default 100 M) are cropped once more into four 275 m cells (depth 3); the sample then also
   brings depth 2 over them.
5. **Cell COPCs**: `writers.copc` per cell, two at a time, with two class 7 (low noise) anchor points at the
   cell's minimum corner and minimum + (550, 0, 0), because PDAL makes the cube
   `[min, min + max extent]` of the data. They sit 30 m below grade at cell corners.
6. **Merge** (`merge-copc.mjs`): the top levels from the sample, everything below from the cells,
   the LAZ chunks copied byte for byte (same point format, scale 1 mm and offset), one hierarchy
   page. The LAZ chunk table is empty: COPC readers (copc.js, PDAL readers.copc) find chunks
   through the hierarchy.

Result (2026-10-04, reference workstation): `alzour.copc.laz`, 5.84 GiB, 34,950 nodes,
841,904,083 points: all 841,703,158 source points plus 200,925 sample points of the top levels
and the anchors. Bounds E 244772.154 to 246908.609, N 3178788.329 to 3179941.359, EL 82.828 to
175.753 (anchors at EL 70). `pdal info --stats` decodes all 841,904,083 points. Time: about
10 min of streaming crops (6 at a time), 8 min for the sample, 40 min of cell COPCs (the
largest, 180 M points, 31 min) and 1 min to merge.

## Test fixture

`packages/pointcloud/test-data/synthetic.copc.laz` (16 000 points, 5 nodes, no client data):

```powershell
node tools/pointcloud/synthetic-cloud.mjs synth.csv 16000
pdal translate synth.csv packages/pointcloud/test-data/synthetic.copc.laz -w writers.copc `
  --writers.copc.a_srs=EPSG:32639 --writers.copc.scale_x=0.001 --writers.copc.scale_y=0.001 `
  --writers.copc.scale_z=0.001 --writers.copc.offset_x=auto --writers.copc.offset_y=auto `
  --writers.copc.offset_z=auto
```
