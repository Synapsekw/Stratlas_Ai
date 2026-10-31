/**
 * English UI strings: the one tool registry (UI revision W8) and the Tools tab's list. Prefixes:
 * `toolReg`. Part of the `en` catalogue (see `../en.ts`). No em or en dashes.
 */
export const enToolReg = {
  // the Tools tab: the armed tool's card replaces the list, and this goes back to it
  'toolReg.back': 'Back to tools',
  'toolReg.list': 'Tools',
  // why a tool cannot start here, said where it is listed (the palette, the Tools tab, the island)
  'toolReg.reason.needsMap': 'Open the map first',
  'toolReg.reason.needsSelection': 'Select something first',
  'toolReg.reason.needsPointcloud': 'Needs a point cloud',
  'toolReg.reason.needsModel': 'Needs a 3D model or point cloud',
  'toolReg.reason.needsDates': 'Needs two survey dates',
  'toolReg.reason.needsVideo': 'Needs a video',
  'toolReg.reason.needsClip': 'Pick a video clip first',
  'toolReg.reason.needsKit': 'Needs a stockpile survey with two dates',
  'toolReg.reason.needsPiles': 'Needs a pile or a volume measurement',
  'toolReg.reason.needsRoad': 'Needs a road survey',
  'toolReg.reason.package': 'Not in a project package',
  'toolReg.reason.streetMap': 'No street map for this site',
  'toolReg.reason.comparing': 'Leave the comparison beside the island',
  // a Volumes tool: the full table, in Project > Volumes
  'toolReg.volumesTable': 'Table',
  'toolReg.volumesTableName': 'Open the volumes table',
} as const;
