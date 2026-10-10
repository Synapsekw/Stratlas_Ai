# The Globe

The Globe shows every project in your library as a site on the Earth, offline. It is for overview and navigation: measuring and editing stay in the site view.

## Open the Globe

Click **Globe** in the sidebar. The Earth is drawn as the dark street map the Map view uses, from the street map packs you have installed: countries and cities from far out, streets where a detailed pack covers the place. Each project with a location is a pin, and **Sites on the globe** lists them. The footer credits what is shown, for example "Natural Earth (public domain)", "© OpenStreetMap contributors" and "CesiumJS (Apache-2.0)"; **Imagery and terrain credits** lists them all.

The Globe makes no network requests. Everything it draws ships with {product} or comes from packs you add in Settings (see the chapters on map packs and on imagery and terrain packs).

Left alone with the whole Earth in view, the Globe turns slowly for a while and then rests. Any click, drag or scroll stops it. It does not turn when Reduce motion is on or on the Low graphics preset.

## Map

**Map** chooses what the Earth is drawn from:

- **Street map:** the street map packs over the land and borders that ship with {product}. Without any street map pack the Globe says "No street map pack is installed, so the Globe shows land and borders only. Add packs in Settings, Map packs."
- **Satellite:** your imagery packs over the street map. **Imagery** then chooses between **Best available**, the sharpest installed pack for each place, and one pack. Without any imagery pack the Globe says "No imagery pack is installed, so the street map shows. Add imagery in Settings, Map packs."
- **Natural Earth:** the painted Natural Earth II picture of the Earth, with your imagery packs over it. Street map packs are not drawn in this look.

Street names and other labels are part of the map, so they lie on the ground: they turn with the Earth and lean when you tilt the view.

## Terrain

**Terrain:** **Best available** uses installed terrain packs for relief; **Off (smooth Earth)** turns relief off. On the Low graphics preset terrain is off: "Terrain is off on the Low graphics preset."

## Sites

A site pin is mint when the project has no open issues and amber when it has; **Site pins** under the list shows the two. Pins that crowd gather into one with their number; click it to zoom to them.

Rest the pointer on a pin, or on a row of the list, to see the site's name on the Globe. Click a pin or a row to select the site. The Globe flies to it from the list, and shows a card with the last capture, the number of open issues and tilesets.

- **Fly to** moves the view to the site.
- **Open site here** opens the project in the site view, looking the same direction. Click **Globe** again to come back to the same view.
- **Close** closes the card.

**Zoom in**, **Zoom out** and **Show all sites** are at the lower right.

## Issues on the Globe

With a project open, tick **Show issues of the open project**. Issues show as pins in their severity colours. Click one to see its card, then **Open issue** to open it in the site view.

## Measure

Click **Measure on the ellipsoid** and click points on the ground. The Globe shows "Distance on the ellipsoid" along the points and the area they enclose. These are geodesic values on the WGS84 ellipsoid, for planning; survey measurements belong in the site view.

## Ask the agent

The AI agent can list your sites ("list my sites": name, place, survey dates, open issues and tilesets) and show one on the Globe ("show the demo on the Globe"). The agent panel closes when the Globe opens, because it belongs to the project view.
