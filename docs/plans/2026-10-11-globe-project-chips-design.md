# Project chips on the Globe: design

Date: 11 Oct 2026. Branch: `feat/globe-project-chips`.

## Why

The Globe's left panel does three jobs at once (the list of sites, the map settings, the colour
key) and covers a third of the smallest window. On the map a site is a glowing dot whose name only
shows under the pointer, so the list is the only place names can be read. The founder asked for the
panel to go, or to sit behind a dropdown, and picked the "project chips" direction from three
sketches.

## What the person sees

1. **Every site is a chip on the map**: a dot in its colour (mint with no open issues, amber with
   some), its name, and an amber badge with the count of open issues when there is one. A long name
   is cut with an ellipsis; the label under the pointer still says it in full, with its last
   capture or open issues.
2. **Chips that would overlap gather into one chip**, "4 sites", amber when any site in it has open
   issues. A click flies to its sites, where they part, however near they are. Sites that cannot
   part (the same place) are listed in **Find a site** instead, to be picked by name.
3. **A selected site's chip wears a mint outline and its card opens at the pin.** The card follows
   the pin as the Globe moves, stays inside the window (it slides along an edge, and goes above the
   pin when there is no room below) and hides while the pin is behind the Earth. Its content is
   today's: name, last capture, open issues, tilesets, Fly to, Open site here. An issue pin's card
   opens at the issue pin.
4. **The panel is gone.** Its jobs move:
   - the list is a **Find a site** field at the top centre. Focus or a click lists every site (the
     same order as today's list); typing filters by name; Up, Down and Enter pick; Esc closes. A
     row under the pointer or the keyboard lights its chip on the map. Picking flies there and
     opens the card.
   - the map settings are a **Map** button at the top right that opens a small dialog: the look
     (Street map, Satellite, Natural Earth), imagery, terrain, "Show issues of the open project",
     the notes those controls show today (no street pack, where to switch online satellite on, the
     Low preset), and the colour key.
   - **Measure** is a button in the bottom-right stack, above the zoom buttons. While measuring,
     the read-out takes the place of the search field.
5. **No sites, or the library could not be read**: a small notice in the middle of the top edge,
   under where the search field would be, with today's words.

No shortcut is added. No words change except the new ones; the Globe keeps saying "site".

## How it is built

### `@aio/globe` (no CesiumJS in the pure part)

- `chips.ts` (new, pure): `fitLabel(text, maxWidth, measure)` cuts a name to a width with an
  ellipsis; `chipMetrics(nameWidth, badgeText | null)` gives a chip's size and where its dot, name
  and badge sit; `placeCard(pin, card, view, insets)` gives the card's top-left corner and whether
  it sits below or above the pin.
- `view/pins.ts`: `siteChip(...)` and `clusterChip(...)` draw the chips on small canvases as
  `sitePin` and `clusterPin` do today (cached per text, tone, state and pixel ratio). `sitePin` and
  `clusterPin` go.
- `view/controller.ts`: sites are billboards of `siteChip`, anchored at the dot (left origin and a
  pixel offset), so `pinPosition` and every click and hover test keep pointing at the site.
  Gathering is the package's own pass (`groupChips` in `chips.ts`, run when the view changes):
  CesiumJS's clustering only asks whether a neighbour's anchor point lies in a chip's box, which
  misses overlaps once the camera is not north up. The gathered chip's words come from a
  `clusterLabel(count)` option. A third tag slot, `card`, is placed with `placeCard` at the pick
  given to `setCard(pick | null)`: a site's pin or an issue's pin.
- The views frame chips, not points. `padBounds` (`camera.ts`, pure) grows a box of sites by
  what the screen's insets and a chip's size around its dot are worth on the ground. The opening
  view and **Show all sites** start from the sites' box with its margin and grow it only at the
  edges where a chip would lack its room (and fall back to that box when a library is too wide
  for the room to be had). A click on a gathered chip flies to its members' own box, a few tens
  of metres at the least, with the camera as much higher as the ground they stand on.
- With terrain, a site stands on the ground and one position says where: the controller sets it
  from `Globe.getHeight`, and the chip, the card, the rings, the label, the gathering and the
  flight to a site all read it.
- A click on a gathered chip whose sites still stand as one chip when the flight has ended (the
  same place) tells the screen through `onGroup(projectIds)`.
- `view/GlobeView.tsx`: a `card` prop (a React node) rendered in the `card` slot, outside the
  `aria-hidden` labels and with pointer events; a `cardInsets` prop (the room the screen's own
  controls take at each edge); a `clusterLabel` prop; an `onGroup` prop. The selected slot keeps
  its three rings and loses its name label (the card and the chip say it). `describe` is asked
  for sites and issues, not for clusters.

### The Globe screen (`apps/desktop/src/renderer/globe/`)

- `GlobeSearch.tsx` (new): the combobox. `role="combobox"` on the input, a `role="listbox"` with
  `data-testid="globe-sites"` and one `role="option"` per site.
- `GlobeMapMenu.tsx` (new): the Map button and its dialog, built as the title bar's connection
  menu is (`useFocusTrap`, a click away closes, focus returns to the button). The look buttons keep
  their `globe-look-*` test ids.
- `GlobeScreen.tsx`: composes the two, hands the card to `GlobeView`, moves Measure into the
  bottom-right stack, shows the notice for no sites or an error. Sites the Globe says cannot part
  are listed in the field (its list narrowed to them until the person types, picks or closes it).
  `globe.css` loses the panel and gains the three pieces.
- `@aio/ui` strings: `globe.find`, `globe.findNone`, `globe.mapMenu` and `globe.mapMenuTitle` are
  new; a gathered chip says `globe.siteCount` ("{count} sites"), which was there already;
  `globe.cluster_*` and the other unused ones are removed.

### Keyboard

Tab order: Find a site, Map, the card when one is open, Measure, the zoom buttons. Everything the
panel did is reachable without a mouse: sites through the field, settings through the Map dialog,
Measure through its button.

Esc closes the nearest thing: the field's list, the Map dialog, the card when the focus is in it,
and from the field with its list shut the open card as well (a pick with the keyboard leaves the
focus in the field). A card closed with the keyboard in it (Esc, or Enter or Space on Close) gives
the focus back to the field, its list shut. A click of the mouse on Close leaves the focus where it
was: the button does not take it on the press, or the app's `keepFocusAlive` would hand it to the
field when the card goes. The field opens its list when the focus comes into it from inside the
page, not when the window is activated again with the focus resting there.

### The smallest window

At 1100 px (848 px of Globe) the field is 260 px wide at the top centre and the Map button sits at
the top right; nothing is at the left any more. Checked at the CI window (1100 wide, about 724
high, device scale 1): no control is folded away or overlaps another, and none reaches the title
bar.

## Trade-offs taken

- Chips are drawn on the Globe's canvas, not as HTML: clicks and terrain stay CesiumJS's, at the
  cost of chips not being focusable. The field is the keyboard's way to a site.
- A card at the pin covers some ground beside the selected site. It closes with its button or Esc,
  and "Show all sites" clears it.

## Tests

- Unit: `chips.test.ts` (label cutting, chip metrics, card placement at each edge and above the
  pin); `GlobeSearch.test.tsx` (lists all, filters, arrows and Enter pick, Esc closes, lighting);
  `GlobeMapMenu.test.tsx` (opens, the look is pressed, Esc returns focus).
- End to end: `globe.spec.ts` picks sites through the field and switches looks through the Map
  dialog; a new test checks the top edge at the smallest window and that the card stays in the
  window. `basemap-picker.spec.ts` and `project-maps.spec.ts` are run, since they open the Globe.
- No contract change.
