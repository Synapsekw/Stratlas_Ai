/**
 * English UI strings: road. Prefixes: `road`, `roadBench`.
 * Part of the `en` catalogue (see `../en.ts`). No em or en dashes.
 */
export const enRoad = {
  // Road workspace before the road builder has run
  'road.setup.title': 'Road setup',
  'road.setup.text':
    'This road survey has no road model yet. Draw the centreline on the map over the orthomosaic, or import one, then run the road builder.',
  'road.setup.draw': 'Draw centreline',
  'road.setup.drawing':
    'Click along the road from its start (km 0). Double click or Finish to end, Backspace removes the last point.',
  'road.setup.mapOnly': 'Switch the stage to the map to draw.',
  'road.setup.finish': 'Finish',
  'road.setup.clear': 'Clear',
  'road.setup.cancel': 'Cancel',
  'road.setup.points_one': '{count} point',
  'road.setup.points_other': '{count} points, {length}',
  'road.setup.saved': 'Centreline saved as {path}.',
  'road.setup.run': 'Run the road builder',
  'road.setup.runHelp':
    'Opens a new road survey job for this project, with the drawn centreline filled in.',
  'road.unitsAlong': '{count} · {length} m along the road',
  'roadBench.overlay': 'Overlay',
  'roadBench.closeup': 'Close-up',
  'roadBench.layers': 'Layers',
  'roadBench.measure': 'Measure',
  'roadBench.closeupButton': 'Close-up of the selected defect',
  'roadBench.closeupHint': 'Pick a defect to see its photo with the outline beside the map.',
  'roadBench.measureButton': 'Measure on the map',
  'roadBench.measureHint': 'Click points on the map for a distance or an area.',
  'road.measure.distance': 'Distance',
  'road.measure.area': 'Area',
  'road.measure.save': 'Save',
  'road.measure.savedFlat':
    'Saved to Measure at one height (the survey surface under it), so its length is the horizontal length shown here. Its card reads the terrain length from the survey surface.',
  'roadBench.mapOnly': 'Works on the map',
} as const satisfies Record<string, string>;
