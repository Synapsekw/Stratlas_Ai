# Maps and offline packs

Street maps come from offline map packs on your disk. One pack serves every project in its area. Orthos and plot plans of a project always show, with or without a pack.

## The map view

1. On **Scene**, click **Map** (or press **2**).
2. Drag to pan, wheel to zoom. Issues show as markers; click one for its card.

Street maps are dark, also in the light theme. With no pack installed, the map says "No map packs installed. Add a pack in Settings, Maps."

### Choose the map type

The chip under the zoom buttons names the map type in use. Click it to choose:

- **Streets:** the street map alone.
- **Satellite:** imagery with the streets and names over it.
- **Satellite only:** imagery alone, without streets and names.
- **Terrain shading:** relief shading from a terrain pack, with any map type.

When several imagery packs cover the site, **Imagery** picks one of them, or **Best available** to draw them all, detailed over coarse.

Switching keeps the map where it is. The choice is remembered on this computer and is the same as the ticks under **Imagery and terrain** in Settings, **Offline maps**. From the keyboard, the arrow keys move between the map types and **Esc** closes the list. The command palette (**Ctrl K**) has the same choices: type "map type".

Imagery and terrain come from packs on your disk, never from the internet. A map type with no pack for the site is greyed out, and the list says which pack is missing. Click **Offline maps** there to open Settings where packs are imported. See [Imagery and terrain packs](31-imagery-and-terrain-packs.md).

### The ground in 3D

In 3D, **Layers and issue pins** has the ground around the site:

- **Street map under the site** lays the street map on the ground around the site. It is on by default for stockpile projects. It is greyed out when no installed pack covers the site.
- **Imagery around the site** and **Terrain around the site** drape the imagery packs and the relief on the land around the site. They need Medium graphics or higher and a pack that covers the site.

## Offline map packs

Open **Settings**, **Offline maps**. **Installed packs** lists each pack with its **Region**, **Size**, **Max zoom**, **Built** date and **Bounds**.

![Offline maps in Settings](images/settings-maps.png)

### Import a pack file

Use this on a workstation with no network.

1. Click **Import pack file**.
2. Pick a `.pmtiles` file (for example from a USB drive).

The pack appears under **Installed packs**.

### Download a region

{product} downloads map data only when you start it, from build.protomaps.com. The workstation must be **Online**: click the mode in the title bar, switch to **Online**, then **Download maps** (see [Online or offline only](01-install.md#online-or-offline-only)). In **Offline only**, **Download** is greyed and the page says to import a pack file instead.

1. Click **Add a region**.
2. Pick the area: **Country** (choose from the list) or **Draw a box** (drag on the map).
3. Give it a **Region name**.
4. Pick the **Detail**, from **Zoom 6: country overview** to **Zoom 15: full detail**. The size estimate updates.
5. Click **Download**. The button shows the size, for example "Download about 120 MB".

**Downloads** shows the progress. If the download stops (network, or you quit {product}), it shows **Interrupted**: click **Resume** to continue from where it stopped. The finished pack is checked tile by tile.

If the workstation is set to offline-only, downloads are off: "This workstation is offline-only. Import a pack file, or turn off offline-only in Privacy and cloud."

### Remove a pack

Click **Remove** on the pack's row, then confirm. Maps lose that area until the pack is added again. A pack that came with an open package shows **In open package** and cannot be removed.

## Maps inside packages

A package can carry the map region around its site, so the customer sees street maps with no pack installed. See [Packages](11-packages.md#include-the-map-region).
