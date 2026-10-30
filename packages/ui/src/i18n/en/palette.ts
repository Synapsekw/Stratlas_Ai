/**
 * English UI strings: command palette. Prefixes: `palette`.
 * Part of the `en` catalogue (see `../en.ts`). No em or en dashes.
 */
export const enPalette = {
  'palette.mapBase': 'Map: {name}',
  'palette.addSurveyDate': 'Add survey date...',
  'palette.importFlightFolder': 'Import a flight folder...',
  'palette.basemap.current': 'Current',
  'palette.hillshade.on': 'Turn terrain shading on the map on',
  'palette.hillshade.off': 'Turn terrain shading on the map off',
  'palette.basemap.packs': 'Import imagery and terrain packs (Settings, Offline maps)',
  'palette.online.on': 'Turn online maps on',
  'palette.online.off': 'Turn online maps off',
  'palette.prevSurvey': 'Go to previous survey',
  'palette.nextSurvey': 'Go to next survey',
  'palette.surveyOn': 'Go to survey {date}',
} as const satisfies Record<string, string>;
