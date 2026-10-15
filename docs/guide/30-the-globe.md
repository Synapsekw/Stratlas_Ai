# The Globe

The Globe shows every project in your library as a site on the Earth, offline. It is for overview and navigation: measuring and editing stay in the site view.

## Open the Globe

Click **Globe** in the sidebar. The Earth is drawn as the dark street map the Map view uses, from the street map packs you have installed: countries and cities from far out, streets where a detailed pack covers the place. Each project with a location is a chip on the map with its name. The footer credits what is shown, for example "Natural Earth (public domain)", "© OpenStreetMap contributors" and "CesiumJS (Apache-2.0)"; **Imagery and terrain credits** lists them all.

The Globe opens on the whole Earth, looking straight down over the open project's site. When you come back to it in the same session, it is where you left it.

The Globe fills the whole screen. **Find a site** is at the top, **Map** at the top right, and **Measure on the ellipsoid**, **Zoom in**, **Zoom out** and **Show all sites** are at the lower right.

The Globe makes no network requests of its own. Everything it draws ships with {product} or comes from packs you add in Settings (see the chapters on map packs and on imagery and terrain packs). The one exception is online maps (Sentinel-2, Esri and Mapbox), which show only after you have switched them on, and never on an offline-only workstation except for Sentinel-2 tiles already kept on this computer.

Left alone with the whole Earth in view, the Globe turns slowly for a while and then rests. Any click, drag or scroll stops it. It does not turn when Reduce motion is on or on the Low graphics preset.

If no project can be placed, the Globe says so at the top: "No project can be placed on the globe yet. Projects need a coordinate system {product} knows."

## Sites

A site's chip has a dot, the project's name and, when the project has open issues, their number. The dot is mint with no open issues and amber with some. A long name is cut short on the chip; rest the pointer on the chip to read it in full, with the last capture or the open issues.

Chips that would overlap gather into one that says how many it holds, for example "3 sites". It is amber when any of them has open issues. Click it and the Globe flies to its sites, where each has its own chip again, even when they are only a short walk apart. Projects at the same place stay one chip at any zoom: a click on it lists them in **Find a site**, where you pick one by name.

**Show all sites** brings every site into view, each chip whole and clear of the field and the buttons.

Click a chip to select the site. Its card opens beside it, with the last capture, the number of open issues and tilesets. The card stays by the site as the Globe moves.

- **Fly to** moves the view to the site.
- **Open site here** opens the project in the site view, looking the same direction. Click **Globe** again to come back to the same view.
- **Close** closes the card. So does Esc, with the focus in the card or in **Find a site** (there the first Esc closes the list when it is open). After Esc, or Enter on **Close**, the keyboard is back in **Find a site**.

## Find a site

Click **Find a site** to list every site with its last capture and open issues. Type part of a name to shorten the list; "No site with that name" means nothing matches. Rest the pointer on a row, or move to it with the Up and Down keys, to light its chip on the Globe. Click a row, or press Enter, and the Globe flies to the site and opens its card. Esc closes the list; Esc again closes the card.

When the list opens after a click on a chip of projects at the same place, it shows only those. Type, or close it, and it lists every site again.

With the keyboard, Tab goes from **Find a site** to **Map**, then to the open card and to the buttons at the lower right.

## Map

**Map** opens the same Map menu as the Map view and the 3D scene (see [The Map menu](06-maps.md#the-map-menu)). It stays open while you try a choice; Esc or a click on the Globe closes it.

The maps:

- **Offline**: **Streets**, the street map packs over the land and borders that ship with {product}, and **Natural Earth**, the painted Natural Earth II picture of the Earth (street map packs are not drawn on it). Without any street map pack the menu says "No street map pack is installed, so the Globe shows land and borders only. Add packs in Settings, Offline maps."
- **Online satellite** and **Mapbox styles**: once online maps are switched on in **Settings**, **Map sources**, the whole Earth shows the map you pick, credited in the footer of the menu. See [Online maps](06-maps.md#online-maps).

**On top** has **Imagery packs and orthos** (your imagery packs over the map, **Best available** or one pack), **Terrain** (see [Terrain](#terrain)) and **Issues of the open project**.

Street names and other labels are part of the map, so they lie on the ground: they turn with the Earth and lean when you tilt the view.

**Site pins**, at the bottom of the menu, shows the chips' colours: **No open issues** and **Open issues**.

## Processed maps on the Globe

The processed maps of a site lie on the Earth where the site is, above the street map, imagery packs and online satellite, in every look. The Globe draws them for the open project and the site you pick, two sites at most.

Click a site's chip and look for **On the Globe** in its card. It lists the site's orthophotos by survey date, its shaded surfaces and any change heat maps, each with its own switch. The orthophoto of the latest survey date is on to start with. Switch an older date on to see that day, or a heat map to see what changed (red where material was added, blue where it was removed, with its legend in the card). Orthophotos lie at the bottom, then shaded surfaces, then other maps, and change heat maps on top. If a map cannot be read, the card says "This map could not be read."

The switches last until you close the app. They are not saved.

## Terrain

**Terrain**, under **On top** in the Map menu: **Best available** uses installed terrain packs for relief; **Off (smooth Earth)** turns relief off. On the Low graphics preset terrain is off: "Terrain is off on the Low graphics preset."

## Issues on the Globe

With a project open, **Issues of the open project** in the Map menu is on to start with. Issues show as pins in their severity colours. Click one to see its card, then **Open issue** to open it in the site view.

## Measure

Click **Measure on the ellipsoid**, the first button at the lower right, and click points on the ground. The read-out takes the place of **Find a site** and shows "Distance on the ellipsoid" along the points and the area they enclose. These are geodesic values on the WGS84 ellipsoid, for planning; survey measurements belong in the site view. Click the button again to stop.

## Ask the agent

The AI agent can list your sites ("list my sites": name, place, survey dates, open issues and tilesets) and show one on the Globe ("show the demo on the Globe"). The agent panel closes when the Globe opens, because it belongs to the project view.
