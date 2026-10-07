# 3D Tiles

Large meshes and point clouds load faster as 3D Tiles: the site view and the Globe stream only the detail the view needs. A project's tilesets are listed in its `tilesets.json` and stored in `tiles/`.

## Make tiles from a mesh or a cloud

- **Photo processing** makes tiles of its mesh when **Tiles** is among the products.
- For any mesh or point cloud layer, open **Jobs**, choose **Mesh to 3D Tiles** or **Point cloud to 3D Tiles**, and give the layer. The tiles stream into the site view when the job is done.

Picking, measuring and cutaways work on tiles as on the original layer.

## Import 3D Tiles

Tilesets from other software (3D Tiles 1.0 or 1.1, a `tileset.json` with its files) can be imported into a project: choose **Import 3D Tiles** and the root `tileset.json`. {product} copies the tileset into the project and lists it as imported. Only files inside the tileset's own folder are copied; a tileset that refers to files elsewhere or online is refused.

## On the Globe

A site's card on the Globe counts its tilesets.
