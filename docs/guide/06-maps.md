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

### Maps for your projects

**Maps for your projects**, at the top of the page, gets detailed street maps only for the places where you have projects, and nothing else. It says how many projects lack one, for example "3 of 7 projects have no detailed street map", and lists the areas that would fix it:

- **Site area**: a box of 12 km around each site at full detail (zoom 15). Sites close to each other share one box. Well under 1 MB each.
- **Overview** of each country that has a project (zoom 10, coarser for the largest countries). From about 0.2 MB for a small country to a few tens of MB for the largest.
- **World overview**: the whole world at zoom 6, about 33 MB, so the Globe shows a street map at every zoom.

Each area shows its **Estimated size**, and the last row the total. An area that an installed pack already covers is not listed.

1. Untick any area you do not want. **Show** draws it on the coverage map.
2. Click **Download**. The button shows the total, for example "Download about 36 MB".

The areas appear under **Downloads** and install like any other region, with the same **Resume** and the same check. The download comes from build.protomaps.com, which sees the areas asked for and nothing about your projects.

When everything is covered, the panel says "Nothing to download". A project that is not placed on the Earth (a local grid, or a coordinate system {product} does not know) gets no map.

**When you open a project** that has no detailed street map, a small notice at the bottom right names the same areas and their size. **Download** starts them, **Choose areas** opens this panel, and closing the notice is fine too: it does not come back for that project. Turn the notice off with **Tell me when an opened project has no detailed street map**.

**Download street maps for new projects automatically** is off by default. With it on, the first time you open a project that is placed on the Earth, its missing areas are queued in **Downloads** without asking; a notice says so, and you can cancel them there.

In **Offline only** nothing is downloaded, whatever these switches say. The panel still lists what is missing: switch to **Online** in the title bar (see [Online or offline only](01-install.md#online-or-offline-only)), or bring the packs in with **Import pack file**.

If a project leaves the library, the panel says, for example, "2 packs cover areas with no project any more". Click **Review**, then **Remove** on a pack and confirm. The world overview is never offered for removal.

### Import a pack file

Use this on a workstation with no network.

1. Click **Import pack file**.
2. Pick a `.pmtiles` file (for example from a USB drive).

The pack appears under **Installed packs**.

### Download a region

{product} downloads map data only when you start it (or have turned on **Download street maps for new projects automatically**, above), from build.protomaps.com. The workstation must be **Online**: click the mode in the title bar, switch to **Online**, then **Download maps** (see [Online or offline only](01-install.md#online-or-offline-only)). In **Offline only**, **Download** is greyed and the page says to import a pack file instead.

1. Click **Add a region**.
2. Pick the area: **Country** (choose from the list) or **Draw a box** (drag on the map).
3. Give it a **Region name**.
4. Pick the **Detail**, from **Zoom 6: country overview** to **Zoom 15: full detail**. The size estimate updates.
5. Click **Download**. The button shows the size, for example "Download about 120 MB".

**Downloads** shows the progress. If the download stops (network, or you quit {product}), it shows **Interrupted**: click **Resume** to continue from where it stopped. The finished pack is checked tile by tile.

If the workstation is set to offline-only, downloads are off: "This workstation is offline-only. Import a pack file, or turn off offline-only in Privacy and cloud."

### Remove a pack

Click **Remove** on the pack's row, then confirm. Maps lose that area until the pack is added again. A pack that came with an open package shows **In open package** and cannot be removed.

## Online satellite

Not every workstation has to work offline. **Online satellite (Sentinel-2)** draws satellite imagery of the whole world on the map without a pack. It is off until you switch it on.

1. Open **Settings**, **Offline maps**, **Imagery and terrain**.
2. Tick **Online satellite (Sentinel-2)**.
3. The first time, read the notice and click **Switch on**.

What you get:

- Sentinel-2 imagery from 2016, at about 10 m per pixel. It shows the lie of the land, roads and large structures, not site detail, and nothing built since 2016. Zoomed in past that detail the imagery is stretched, not sharper.
- It sits at the bottom of the map: your imagery packs and the project's orthos draw over it, and street lines and labels stay on top.
- The credit shows in the corner of the map while the imagery does: "Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016)". The imagery is licensed CC BY 4.0.

What is sent:

- {product} requests the imagery tiles for the areas you look at from the servers of EOX IT Services GmbH. That service can therefore see which areas you view, and the address your computer connects from. Nothing else is sent: no project data, no account, no key.
- Tiles you have viewed are kept on this computer (up to 300 MB; the ones used longest ago make room for new ones), so those areas draw again without a request. **Clear cached satellite tiles** in the same place deletes them and shows how much they take.
- The service is free and comes with no guarantee. When it cannot be reached, the map shows what it has and tries again later.

On an offline-only workstation the box is greyed: "This workstation is offline-only, so online satellite cannot be switched on." If it was on before the workstation was set to offline-only, nothing more is requested; areas you viewed before still draw from this computer, and you can untick the box to hide them.

For imagery that works with no network, or sharper imagery of your site, use an imagery pack. See [Imagery and terrain packs](31-imagery-and-terrain-packs.md).

## Maps inside packages

A package can carry the map region around its site, so the customer sees street maps with no pack installed. See [Packages](11-packages.md#include-the-map-region).
