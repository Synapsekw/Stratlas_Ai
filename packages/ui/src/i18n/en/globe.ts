/**
 * English UI strings: globe. Prefixes: `globe`.
 * Part of the `en` catalogue (see `../en.ts`). No em or en dashes.
 */
export const enGlobe = {
  // M10 G6: the Globe
  'globe.nav': 'Globe',
  'globe.sites': 'Sites on the globe',
  'globe.noSites':
    'No project can be placed on the globe yet. Projects need a coordinate system {product} knows.',
  'globe.noCapture': 'No capture',
  'globe.openIssues_one': '{count} open issue',
  'globe.openIssues_other': '{count} open issues',
  'globe.tilesets_one': '{count} tileset',
  'globe.tilesets_other': '{count} tilesets',
  'globe.terrain': 'Terrain',
  'globe.terrainAuto': 'Best available',
  'globe.terrainOff': 'Off (smooth Earth)',
  'globe.lowTier': 'Terrain is off on the Low graphics preset.',
  'globe.issueMeta': 'Severity {severity} · {status}',
  'globe.openIssue': 'Open issue',
  'globe.flyTo': 'Fly to',
  'globe.openSite': 'Open site here',
  'globe.credits': 'Imagery and terrain credits',
  'globe.measure': 'Measure on the ellipsoid',
  'globe.measureHint': 'Click points on the ground. Measuring and editing are in the site view.',
  'globe.measureName': 'On the ellipsoid',
  'globe.measureLength': 'Length',
  'globe.area': 'area: {value}',
  // the street map Globe (10 Oct 2026): looks, map controls, the pins' key and labels
  'globe.siteCount_one': '{count} site',
  'globe.siteCount_other': '{count} sites',
  'globe.noStreetPacks':
    'No street map pack is installed, so the Globe shows land and borders only. Add packs in Settings, Offline maps.',
  'globe.zoomIn': 'Zoom in',
  'globe.zoomOut': 'Zoom out',
  'globe.allSites': 'Show all sites',
  'globe.controls': 'Globe view',
  'globe.key': 'Site pins',
  'globe.keyClear': 'No open issues',
  'globe.keyAttention': 'Open issues',
  'globe.closeCard': 'Close',
  // project chips on the Globe (11 Oct 2026): the field that finds a site, the Map dialog
  'globe.find': 'Find a site',
  'globe.findNone': 'No site with that name',
  // processed outputs of the sites in focus (12 Oct 2026): the site card's switches
  'globe.outputs.title': 'On the Globe',
  'globe.outputs.ortho': 'Orthophoto {date}',
  'globe.outputs.orthoUndated': 'Orthophoto',
  'globe.outputs.dsm': 'Shaded surface {date}',
  'globe.outputs.imageryChange': 'Imagery change',
  'globe.outputs.surfaceChange': 'Surface change',
  'globe.outputs.unreadable': 'This map could not be read.',
  'globe.outputs.withName': '{label} ({name})',
} as const satisfies Record<string, string>;
