# The Globe

The Globe shows every project in your library as a site on the Earth, offline. It is for overview and navigation: measuring and editing stay in the site view.

## Open the Globe

Click **Globe** in the sidebar. The Earth shows Natural Earth II imagery, which ships with {product}, and a pin for each project with a location. **Sites on the globe** lists them. The footer credits the imagery and terrain shown, for example "Natural Earth II (public domain) · CesiumJS (Apache-2.0)"; **Imagery and terrain credits** lists them all.

The Globe makes no network requests. Sharper imagery and terrain come from packs you add in Settings (see the chapter on imagery and terrain packs).

## Imagery and terrain

- **Imagery:** **Best available** uses the sharpest installed pack for each place, or pick one pack.
- **Terrain:** **Best available** uses installed terrain packs for relief; **Off (smooth Earth)** turns relief off. On the Low graphics preset terrain is off: "Terrain is off on the Low graphics preset."

## Sites

Click a site pin or a row in the list. The Globe flies to it and shows a card with the last capture, the number of open issues and tilesets.

- **Fly to** moves the view to the site.
- **Open site here** opens the project in the site view, looking the same direction. Click **Globe** again to come back to the same view.

## Issues on the Globe

With a project open, tick **Show issues of the open project**. Issues show as pins in their severity colours. Click one to see its card, then **Open issue** to open it in the site view.

## Measure

Click **Measure on the ellipsoid** and click points on the ground. The Globe shows "Distance on the ellipsoid" along the points and the area they enclose. These are geodesic values on the WGS84 ellipsoid, for planning; survey measurements belong in the site view.

## Ask the agent

The AI agent can list your sites ("list my sites": name, place, survey dates, open issues and tilesets) and show one on the Globe ("show the demo on the Globe"). The agent panel closes when the Globe opens, because it belongs to the project view.
