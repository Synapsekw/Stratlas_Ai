# 3D Tiles

Large meshes and point clouds load faster as 3D Tiles: the site view and the Globe stream only the detail the view needs. A project's tilesets are listed in its `tilesets.json` and stored in `tiles/`.

## Make tiles from a mesh or a cloud

- **Create maps from photos** makes tiles of its 3D model when **3D Tiles** is ticked under **Options**, **What to create**.
- For any mesh or point cloud layer, open **Jobs**, choose **Mesh to 3D Tiles** or **Point cloud to 3D Tiles**, and give the layer. The tiles stream into the site view when the job is done.

Picking, measuring and cutaways work on tiles as on the original layer.

## Import 3D Tiles

Tilesets from other software (3D Tiles 1.0 or 1.1: a `tileset.json` with its files) can be imported into the open project. Press Ctrl+K, choose **Import 3D Tiles from another program**, and pick the root `tileset.json`. The card proposes a name from the folder; add the credit line the tileset's maker asks for and click **Import**. {product} copies the tileset into the project and lists it as imported.

- A tileset placed by its own georeference (Earth-centred coordinates, as most exports are) shows in the 3D view at once.
- A tileset in a local frame is kept hidden, because placing it on the map is not built yet.
- A tileset that refers to files outside its folder or online, or that is not 3D Tiles 1.0 or 1.1, is refused with the reason, and nothing is copied.

## On the Globe

A site's card on the Globe counts its tilesets.
