# Exports to Civil 3D, TBC and 12d

**Site data**, **Export survey data** writes surveys, designs, measurements, contours and sections for Autodesk Civil 3D, Trimble Business Center (TBC), 12d Model and GIS programs. You choose where the file goes first; nothing is added to the project.

## What you can export

| Export       | Formats                                                   |
| ------------ | --------------------------------------------------------- |
| Surface      | LandXML, DXF, 12da, GeoTIFF, CSV, GeoJSON, KMZ, shapefile |
| Orthomosaic  | GeoTIFF                                                   |
| Point cloud  | LAZ                                                       |
| Contours     | DXF, shapefile, GeoJSON, KMZ                              |
| Measurements | DXF, CSV, KMZ, LandXML, 12da, GeoJSON, shapefile          |
| Sections     | CSV, DXF                                                  |

- **From** picks the survey, design, design layer or overlay. For measurements and sections, pick the selected ones, all of them or a folder; tick **One file per measurement** to write one file each into a folder.
- **Coordinates**: **Site grid** (calibrated when the site has a calibration), **WGS 84 (longitude, latitude)**, or an EPSG code.
- **Units**: metres, feet or US survey feet.
- **Level of detail** thins a surface or cloud: **High (every post)**, **Medium** or **Low**.

Every file states its coordinate system, vertical datum, geoid, calibration and units: inside the file where the format allows it, in the GeoTIFF tags, and in a `.txt` beside CSV, shapefile and LAZ files. The offered file name says the same in short, for example `_site-grid_usft`. KMZ is always WGS 84 in metres; DXF, LandXML and 12da are always grid coordinates.

## Which format for which program

- **Civil 3D**: LandXML for surfaces and alignments (stations and station equations included), DXF for 3D faces, contours and outlines.
- **Trimble Business Center**: LandXML for surfaces and alignments, DXF for linework. Load the controller's JobXML in TBC to check a calibrated export against the site calibration.
- **12d Model**: 12da for surfaces and strings, or LandXML.
- **GIS** (QGIS and others): GeoTIFF, shapefile, GeoJSON; **Google Earth**: KMZ.

## Machine control through TBC

{product} does not write Trimble machine-control files (TTM, VCL, DSZ, SVD, SVL): they have no public specification. The supported path is:

1. Export the design surface (and its alignment) from {product} as LandXML in the site grid, with the site calibration applied.
2. Import the LandXML into Trimble Business Center, with the same site calibration.
3. Write the machine-control files from TBC as usual.

Trimble Earthworks and Siteworks also read full-TIN LandXML surfaces directly.

## Designs coming back

Designs exported from Civil 3D, TBC or 12d as LandXML, DXF or 12da import into {product} in place; see [Designs, alignments and compliance](38-designs-alignments-and-compliance.md). DWG is not read: save DWG drawings as ASCII DXF first.
