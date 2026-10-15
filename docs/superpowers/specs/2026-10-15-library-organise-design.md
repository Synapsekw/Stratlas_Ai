# Library: remove, delete, thumbnails and folders (design)

Approved by the founder on 15 Oct 2026. The plan is `docs/superpowers/plans/2026-10-15-library-organise.md`.

## Why

The Projects screen lists everything the app finds: projects in the data folder, demo projects, received `.aio` packages, kit exports and folders added from elsewhere. Today only an ordinary project folder in the data folder can be deleted, every other card is stuck in the list, there is no way to give a project a picture, and a long library has no grouping. This change makes every card removable, lets the person pick a cover, and adds one level of folders.

## Decisions

1. **Remove and Delete for every card.** Native projects, demo projects, received packages (plain, read-only or encrypted), kit exports (`aik`, `volumetric`, `road`, `twin`) and folders added from elsewhere all get two menu actions:
   - **Remove from library** hides the card. The files stay where they are. No confirm: nothing is lost, and the notice says how to bring it back.
   - **Delete** moves the folder or file to the recycle bin (`shell.trashItem`) after a confirm that names the path. Nothing is ever deleted for good.
2. **The only blocks on Delete**: the project is open (close it first) or a job runs in it. Remove has no block.
3. **Hidden list.** Data-folder projects are found by scanning, so hiding needs state: a `hidden` list per computer. **Add project folder** on a hidden path un-hides it; opening a removed package again (Open package) also un-hides it.
4. **Main re-checks every delete on disk.** The renderer names a library id, never a path. Main deletes only a path that is a library entry: a folder or package directly in `<data folder>/projects`, a path listed in `library.json`, or the userData working copy of a demo. It refuses links, a drive root, the data folder, userData, the home folder, the app folder and any folder that holds one of them.
5. **Thumbnails.** The wizard's Project step gets a cover picker: upload an image, or pick one of four built-in covers drawn in the colour of the project type. The menu gets **Change thumbnail**: upload, a built-in cover, or **Use current view** when that project is open. The picture is resized in the renderer to at most 640 px on the long side and written as JPEG.
6. **Where a cover is written.** A native project folder gets `thumbnail.jpg` in the folder (the file the library, the welcome and the house report already read). Packages, kit exports and demo projects are never written into: their cover goes in a per-computer `covers/` folder under userData, and the library prefers that cover over the package's own.
7. **Folders.** One level: a project is in one folder or loose. **New folder** on the library toolbar; folders show as a row of tiles above the cards with a count each; a click opens the folder, with a back link to all projects. A card moves by drag and drop onto a tile (HTML5 drag events, no new dependency) or by right-click, **Move to folder** (including **No folder**). Right-click on a tile: rename, delete. Deleting a folder makes its projects loose and touches no file. Search spans every folder.
8. **Per computer, not shared.** Hidden cards, folders and custom covers live in userData. Nothing of it travels with a project or a package.

## Where the state lives

`library.json` stays as it is (`aio.library/1`, `{ schema, paths }`). The founder's note asked for a schema bump; the design keeps `/1` instead and puts the new state in a new file, because:

- `newerThanThisBuild` makes 0.14 and older refuse an `aio.library/2` file and show an empty library (older builds would lose every added folder, not just the new state);
- the upgrade policy (`docs/release/UPGRADE-POLICY.md`, rule 2) puts new data in new files;
- an older build that adds a folder rewrites `library.json` with `schema` and `paths` only, which would silently drop any field added beside them.

The new file is userData `library-view.json`, family `aio.library-view/1`, registered in `SCHEMA_REGISTRY` (`since: '0.14'`) and read through `newerThanThisBuild` like `library.json`:

```json
{
  "schema": "aio.library-view/1",
  "hidden": ["e:\\data\\projects\\old-yard", "demo:survey-demo"],
  "folders": [{ "id": "f_k3j9x2m1qa", "name": "North yard" }],
  "placed": { "e:\\data\\projects\\yard": "f_k3j9x2m1qa" }
}
```

- Keys are library keys: the resolved path (lower case on Windows) for every card except demo projects, which use `demo:<folder name>`. A demo's library path flips between the bundled folder and its working copy (and the bundled folder moves with every install), so a path key would not stick.
- A file from a newer build is refused for writing with the update message, and read as empty (nothing hidden, no folders), as `library.json` does.
- A `placed` id with no folder reads as loose. Deleting a project drops its key from `hidden` and `placed`.

Older builds read `library.json` as before and ignore `library-view.json`: they show hidden cards and no folders, and lose nothing.

Covers live in userData `covers/<sha256 of the key>.jpg` and are served as `aio://cover/<hash>.jpg`. Thumbnail and cover URLs carry `?v=<mtime>` so a changed picture shows at once.

## Demo projects

`demo.ts` lists every bundled demo on every `library:list` (bundled folder, or the working copy in userData `demo/<id>/` once opened). Nothing re-seeds a working copy on start; a copy is made only when a demo is opened. So:

- **Remove** hides `demo:<id>`. The bundled demo keeps being found, and stays hidden, also after an update ships a new demo build.
- **Delete** moves the working copy to the recycle bin when there is one and hides `demo:<id>`. The bundled folder is part of the installed app and is never touched. The confirm names the working copy, or says there is nothing on disk to delete.
- With every demo hidden and no other project, the library shows the empty state, not the first-start welcome (which shows only when every listed card is a demo).
- A hidden demo comes back through **Add project folder** on its bundled folder or its working copy (the key matches). There is no "show removed demos" switch in this change.

## Contract

All additive, one row in `docs/architecture/contract-changes.md`:

- `LibraryEntry` gains `folderId?`, `purpose?` (the manifest's purpose, for cover colours) and `customCover?` (a per-computer cover overrides the project's own).
- New `LibraryFolder` `{ id, name }`.
- New channels: `library:remove`, `library:setThumbnail`, `library:folders`, `library:createFolder`, `library:renameFolder`, `library:deleteFolder`, `library:move`.
- `library:delete` keeps its shape; its rules loosen as above.
- New protocol host `aio://cover/<hash>.jpg`.
- New userData file `library-view.json` (`aio.library-view/1`) and folder `covers/`.

## Copy

No em or en dashes. Menu: "Remove from library", "Delete", "Change thumbnail", "Move to folder". Delete confirm titles stay "Delete {project}?"; the text says what moves to the recycle bin for this kind of card (a project folder, a package file, a kit export folder, a demo's working copy). Remove notice: "{project} was removed from the library. Its files stay in {path}. Add project folder brings it back." (packages: "Open package brings it back").

## Risks and open points

- **Use current view** captures the 3D stage (`captureSnapshot` in `renderer/exports/exports.ts`). If the stage is not mounted while the Projects screen shows, the option is greyed with "Open the 3D view first" rather than navigating away. If "map view" was meant as the 2D map, that is a separate capture (MapLibre canvas) and is out of this change.
- **Package covers**: a custom cover shadows the package's own `thumbnail.jpg` on this computer only. "Use the project's own picture" in the Change thumbnail dialog removes the custom cover. A received package re-exported later keeps its own picture; the custom cover stays keyed by the file path.
- **Wizard default**: the wizard pre-selects the first built-in cover of the chosen type, so every new project has a picture. "No cover" is one click away.
- **Deleting an added folder outside the data folder** is new power. The checks in decision 4 and the confirm that names the full path are what keep it safe; the main-side check has its own unit tests for each refusal.
- **Rename** keeps its current rules (data folder projects only). Not part of this change.
