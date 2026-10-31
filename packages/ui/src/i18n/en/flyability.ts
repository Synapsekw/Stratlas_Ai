/**
 * English UI strings: the Flyability Inspector import (picker, spaces, Move point, location check).
 * Prefixes: `fly`. Part of the `en` catalogue (see `../en.ts`). No em or en dashes.
 * `wb.section.flightlines` lives in `workbench.ts` (the `wb` prefix belongs to that module).
 */
export const enFlyability = {
  'fly.picker.title': 'Import a Flyability Inspector export',
  'fly.picker.description':
    'This folder holds a confined-space drone inspection. Choose what to bring in.',
  'fly.picker.flights': 'Flights',
  'fly.picker.merged': 'Merged model',
  'fly.picker.noMerged': 'No merged model in this export',
  'fly.picker.findings_one': '{count} finding',
  'fly.picker.findings_other': '{count} findings',
  'fly.picker.imported': 'Already imported, will merge',
  'fly.picker.aligned.relocalised': 'Aligned by re-localisation',
  'fly.picker.aligned.transform': 'Aligned by a stored transform',
  'fly.picker.aligned.reference': 'Reference flight',
  'fly.picker.import': 'Import',
  'fly.picker.cancel': 'Cancel',
  'fly.picker.scanning': 'Reading the export...',
  'fly.picker.scanFailed': 'Could not read this export.',
  'fly.picker.none': 'No Flyability Inspector export found in this folder.',
  'fly.queued_one': '{count} export is waiting to be chosen.',
  'fly.queued_other': '{count} exports are waiting to be chosen.',
  'fly.addData': 'Flyability Inspector export...',
  'fly.library.tip': 'Add a project folder, or a Flyability Inspector export to import.',
  'fly.space.all': 'All spaces',
  'fly.map.local': 'No map: this space has its own frame',
  'fly.move.action': 'Move point',
  'fly.move.prompt': 'Click the point cloud where the finding is. Esc cancels.',
  'fly.move.done': 'Finding moved.',
  'fly.move.undo': 'Undo',
  'fly.move.noHit': 'No point cloud under the cursor. Click on the cloud.',
  'fly.check.wall': 'Checked against the wall: {wall} (hit {hit})',
  'fly.check.disagrees': 'The recorded location does not match the point cloud here.',
  'fly.check.noHit': 'No point cloud was found at the recorded location.',
  'fly.check.unchecked': 'Location not checked yet.',
  'fly.check.moved': 'Moved by hand. The recorded location is no longer checked.',
} as const satisfies Record<string, string>;
