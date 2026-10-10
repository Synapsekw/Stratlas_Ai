# Imagery and terrain packs

Imagery packs put aerial or satellite imagery under the street map, on the Globe and around the site in 3D. Terrain packs add relief. Packs live in your data folder, work offline and are separate from projects.

## Import imagery

1. Open Settings, **Offline maps**, **Imagery and terrain**, then **Import imagery**.
2. Choose the **File**: a GeoTIFF or Cloud Optimized GeoTIFF in any coordinate system.
3. Give the **Pack name**, the **Licence** (for example CC-BY-4.0, public-domain, or the words of your licence) and the **Attribution**: the credit line the provider asks for.
4. If the imagery is licensed to you or your customer and must not be passed on, tick **Customer licence, not for redistribution (left out of packages)**.
5. Click **Build the pack**. The pack builds as a job in the pipeline pack; **Jobs** shows its progress.

The list shows each pack with its zoom levels, size, date, licence and attribution, and a **Customer licence** tag where it applies. **Remove** deletes a pack after asking.

## Import terrain

**Import terrain** works the same way for an elevation model (DEM GeoTIFF). Also set **Heights measured from**: the vertical datum of the file, for example EGM2008 for Copernicus terrain. **Customer licence, not for redistribution** is offered for terrain too, ticked to start with, and the list shows the datum and the tag.

## Where packs show

- **Satellite: imagery packs under the streets on the map:** the project map shows the imagery under the street lines, with its attribution. Untick it for streets only.
- **Relief shading from terrain packs on the map.**
- **Terrain around the site in 3D** and **Imagery around the site in 3D:** the landscape around the site in the 3D view, on the Medium graphics preset and up.
- The Globe uses every installed pack (see the chapter on the Globe).

The same choices are on the map itself: the map type chip under the zoom buttons (**Streets**, **Satellite**, **Satellite only**, **Terrain shading**), and **Layers and issue pins** in 3D. See [Maps and offline packs](06-maps.md#choose-the-map-type).

**Online satellite (Sentinel-2)** in the same list, and **Online satellite** in the map type chip, is not a pack: it streams imagery from 2016 for the areas you look at, when you switch it on, and your packs draw over it. See [Online satellite](06-maps.md#online-satellite).

## Licences

Every pack carries its licence, attribution and data source, and the attribution shows wherever the imagery shows. {product} ships only Natural Earth II (public domain). Imagery you buy from a commercial provider is imported by you under your licence and is never redistributed: a pack with **Customer licence** stays out of packages.
