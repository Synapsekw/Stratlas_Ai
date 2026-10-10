import type { Issue, Layer, ProjectManifest, Sighting } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { captureIndex, scopedStore } from './captures';
import {
  captureOnScreen,
  issueCapture,
  issueOnScreen,
  issuesByCapture,
  issuesOnScreen,
  sameItems,
  scopeOnScreen,
} from './dateVisibility';
import { createWorkspace } from './index';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const mesh = (id: string, capture?: string): Layer => ({
  kind: 'mesh',
  id,
  name: id,
  visible: true,
  src: { path: `models/${id}.glb` },
  transform: I,
  ...(capture ? { capture } : {}),
});
const photos = (id: string, capture?: string): Layer => ({
  kind: 'photos',
  id,
  name: id,
  visible: true,
  items: [],
  ...(capture ? { capture } : {}),
});

/** Two surveys with a model and a photo set each, one model common to every date. */
const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'two-dates',
  name: 'Two dates',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [
    { id: 'sep', label: 'September', date: '2024-09-04' },
    { id: 'oct', label: 'October', date: '2024-10-02' },
    { id: 'empty', label: 'No data yet', date: '2024-11-06' },
  ],
  layers: [
    mesh('model-sep', 'sep'),
    photos('photos-sep', 'sep'),
    mesh('model-oct', 'oct'),
    photos('photos-oct', 'oct'),
    mesh('design'),
  ],
  severityModels: [],
  classCatalogues: [],
};
const index = captureIndex(manifest);

const onMesh = (layer: string): Sighting => ({
  on: 'mesh',
  layer,
  geom: { type: 'spoint', p: [0, 0, 0], n: [0, 1, 0] },
});
const onPhoto = (layer: string): Sighting => ({
  on: 'image',
  layer,
  photo: 'p1',
  geom: { type: 'box', x: 0, y: 0, w: 10, h: 10 },
});

let n = 0;
const issue = (sightings: Sighting[], capture?: string): Issue => {
  n += 1;
  return {
    id: `i${String(n)}`,
    code: `F${String(n).padStart(2, '0')}`,
    classId: 'crack',
    severityModelId: 'sev',
    severity: 2,
    status: 'reviewed',
    title: 'Crack',
    note: '',
    author: 'Reviewer',
    createdAt: '2024-10-03T08:00:00Z',
    updatedAt: '2024-10-03T08:00:00Z',
    sightings,
    source: 'human',
    ...(capture ? { capture } : {}),
  };
};

const off = (...ids: string[]): Record<string, true> =>
  Object.fromEntries(ids.map((id) => [id, true as const]));

describe('issueCapture', () => {
  it('takes the date of the layers the issue is marked on', () => {
    expect(issueCapture(issue([onMesh('model-sep'), onPhoto('photos-sep')]), index)).toBe('sep');
    expect(issueCapture(issue([onPhoto('photos-oct')]), index)).toBe('oct');
  });

  it('lets the issue name its own date, when the project has that date', () => {
    expect(issueCapture(issue([onMesh('design')], 'oct'), index)).toBe('oct');
    expect(issueCapture(issue([onMesh('model-sep')], 'oct'), index)).toBe('oct');
    expect(issueCapture(issue([onMesh('model-sep')], 'gone'), index)).toBe('sep');
  });

  it('takes the date of most sightings, the first on a tie', () => {
    const most = issue([onMesh('model-sep'), onPhoto('photos-oct'), onMesh('model-oct')]);
    expect(issueCapture(most, index)).toBe('oct');
    expect(issueCapture(issue([onMesh('model-sep'), onPhoto('photos-oct')]), index)).toBe('sep');
  });

  it('has no date on layers common to every date, whenever it was written', () => {
    expect(issueCapture(issue([onMesh('design')]), index)).toBeUndefined();
    expect(issueCapture(issue([onMesh('not-a-layer')]), index)).toBeUndefined();
  });
});

describe('captureOnScreen', () => {
  it('is on screen while one of its layers is shown', () => {
    expect(captureOnScreen(index, 'sep', {})).toBe(true);
    expect(captureOnScreen(index, 'sep', off('model-sep'))).toBe(true);
    expect(captureOnScreen(index, 'sep', off('model-sep', 'photos-sep'))).toBe(false);
    expect(captureOnScreen(index, 'oct', off('model-sep', 'photos-sep'))).toBe(true);
  });

  it('counts a layer the view shows whatever the switches say', () => {
    const hidden = off('model-sep', 'photos-sep');
    expect(captureOnScreen(index, 'sep', hidden, ['photos-sep'])).toBe(true);
    expect(captureOnScreen(index, 'sep', hidden, ['photos-oct'])).toBe(false);
  });

  it('keeps a date without layers on screen: nothing hides it', () => {
    expect(captureOnScreen(index, 'empty', off('model-sep', 'model-oct'))).toBe(true);
    expect(captureOnScreen(index, 'unknown', {})).toBe(true);
  });
});

describe('scopeOnScreen', () => {
  const sepHidden = off('model-sep', 'photos-sep');

  it('keeps site-wide items, and items without dates, on screen', () => {
    expect(scopeOnScreen({ kind: 'site' }, index, sepHidden)).toBe(true);
    expect(scopeOnScreen({ kind: 'survey', capture: 'sep' }, null, sepHidden)).toBe(true);
    expect(scopeOnScreen({ kind: 'survey', capture: 'gone' }, index, sepHidden)).toBe(true);
  });

  it('follows the survey an item is scoped to', () => {
    expect(scopeOnScreen({ kind: 'survey', capture: 'sep' }, index, {})).toBe(true);
    expect(scopeOnScreen({ kind: 'survey', capture: 'sep' }, index, off('model-sep'))).toBe(true);
    expect(scopeOnScreen({ kind: 'survey', capture: 'sep' }, index, sepHidden)).toBe(false);
    expect(scopeOnScreen({ kind: 'survey', capture: 'oct' }, index, sepHidden)).toBe(true);
  });
});

describe('issueOnScreen', () => {
  const sepHidden = off('model-sep', 'photos-sep');

  it('hides the issues of a date whose layers are all hidden, and shows them again', () => {
    const i = issue([onMesh('model-sep'), onPhoto('photos-sep')]);
    expect(issueOnScreen(i, index, {})).toBe(true);
    expect(issueOnScreen(i, index, sepHidden)).toBe(false);
    expect(issueOnScreen(i, index, {})).toBe(true);
  });

  it('leaves the other dates and the undated issues alone', () => {
    expect(issueOnScreen(issue([onMesh('model-oct')]), index, sepHidden)).toBe(true);
    expect(issueOnScreen(issue([onMesh('design')]), index, sepHidden)).toBe(true);
    // a hidden layer common to every date hides nothing, as before
    expect(issueOnScreen(issue([onMesh('design')]), index, off('design'))).toBe(true);
  });

  it('follows the layers the issue is marked on', () => {
    const both = issue([onMesh('model-sep'), onPhoto('photos-sep')]);
    const model = issue([onMesh('model-sep')]);
    // one of its layers hidden: still on screen through the other
    expect(issueOnScreen(both, index, off('model-sep'))).toBe(true);
    // its only layer hidden: gone, though the date still shows its photos
    expect(issueOnScreen(model, index, off('model-sep'))).toBe(false);
    // mixed state: one layer of a hidden date shown again brings back what is marked on it
    expect(issueOnScreen(both, index, off('photos-sep'))).toBe(true);
    expect(issueOnScreen(issue([onPhoto('photos-sep')]), index, off('photos-sep'))).toBe(false);
  });

  it('follows the whole date when only the capture field names it', () => {
    const i = issue([onMesh('design')], 'sep');
    expect(issueOnScreen(i, index, off('model-sep'))).toBe(true);
    expect(issueOnScreen(i, index, sepHidden)).toBe(false);
    // hiding the common layer it is marked on changes nothing
    expect(issueOnScreen(i, index, off('design'))).toBe(true);
  });

  it('stays on a date that has no layers', () => {
    expect(issueOnScreen(issue([onMesh('design')], 'empty'), index, sepHidden)).toBe(true);
  });

  it('shows in a view of its own layer whatever the switches say', () => {
    const i = issue([onPhoto('photos-sep')]);
    expect(issueOnScreen(i, index, sepHidden, ['photos-sep'])).toBe(true);
    // an issue of the same date marked only in 3D shows in that photo too
    expect(issueOnScreen(issue([onMesh('model-sep')]), index, sepHidden, ['photos-sep'])).toBe(
      true,
    );
    expect(issueOnScreen(issue([onMesh('design')], 'sep'), index, sepHidden, ['photos-sep'])).toBe(
      true,
    );
    // what is marked on the viewed layer shows, whatever date the issue names
    expect(
      issueOnScreen(issue([onPhoto('photos-sep')], 'oct'), index, off('model-oct', 'photos-oct'), [
        'photos-sep',
      ]),
    ).toBe(true);
    // another hidden date stays out of it
    const octHidden = off('model-oct', 'photos-oct');
    expect(issueOnScreen(issue([onMesh('model-oct')]), index, octHidden, ['photos-sep'])).toBe(
      false,
    );
  });
});

describe('issuesOnScreen', () => {
  const sep = issue([onMesh('model-sep')]);
  const oct = issue([onMesh('model-oct')]);
  const common = issue([onMesh('design')]);
  const all = [sep, oct, common];

  it('leaves out the issues of hidden dates only', () => {
    expect(issuesOnScreen(all, index, off('model-sep', 'photos-sep'))).toEqual([oct, common]);
    expect(issuesOnScreen(all, index, off('model-oct', 'photos-oct'))).toEqual([sep, common]);
  });

  it('returns the same array when nothing is left out', () => {
    expect(issuesOnScreen(all, index, {})).toBe(all);
    expect(issuesOnScreen(all, index, off('design'))).toBe(all);
    expect(issuesOnScreen(all, null, off('model-sep'))).toBe(all);
    expect(issuesOnScreen(all, captureIndex({ ...manifest, captures: [] }), off('model-sep'))).toBe(
      all,
    );
  });

  it('never changes the issues', () => {
    const before = JSON.stringify(all);
    issuesOnScreen(all, index, off('model-sep', 'photos-sep'));
    expect(JSON.stringify(all)).toBe(before);
  });

  it('reads one date per view through a scoped store (comparing two dates)', () => {
    const ws = createWorkspace();
    ws.getState().openProject({ id: 'p', root: '/p', manifest }, all);
    ws.getState().setDates(index);
    // the workspace shows October; September is off
    ws.getState().setLayersVisible(['model-sep', 'photos-sep'], false);
    const left = scopedStore(ws, { capture: 'sep', index, mode: 'hide', camera: true });
    const right = scopedStore(ws, { capture: 'oct', index, mode: 'hide', camera: true });
    const shown = (s: {
      issues: Issue[];
      dates: typeof index | null;
      hidden: Record<string, true>;
    }) => issuesOnScreen(s.issues, s.dates, s.hidden).map((i) => i.id);
    expect(shown(ws.getState())).toEqual([oct.id, common.id]);
    expect(shown(left.getState())).toEqual([sep.id, common.id]);
    expect(shown(right.getState())).toEqual([oct.id, common.id]);
  });
});

describe('issuesByCapture', () => {
  it('groups the issues by date and keeps the undated apart', () => {
    const a = issue([onMesh('model-sep')]);
    const b = issue([onMesh('design')], 'sep');
    const c = issue([onMesh('model-oct')]);
    const d = issue([onMesh('design')]);
    expect(issuesByCapture([a, b, c, d], index)).toEqual({
      dated: { sep: [a, b], oct: [c] },
      undated: [d],
    });
  });
});

describe('sameItems', () => {
  it('compares by identity and order', () => {
    const a = { id: 1 };
    const b = { id: 2 };
    expect(sameItems([a, b], [a, b])).toBe(true);
    expect(sameItems([a, b], [b, a])).toBe(false);
    expect(sameItems([a], [a, b])).toBe(false);
    expect(sameItems([], [])).toBe(true);
  });
});

describe('the workspace store', () => {
  it('holds the capture index until another project opens', () => {
    const ws = createWorkspace();
    ws.getState().openProject({ id: 'p', root: '/p', manifest });
    expect(ws.getState().dates).toBeNull();
    ws.getState().setDates(index);
    expect(ws.getState().dates).toBe(index);
    const seen = ws.getState();
    ws.getState().setDates(index);
    expect(ws.getState()).toBe(seen);
    ws.getState().openProject({ id: 'q', root: '/q', manifest });
    expect(ws.getState().dates).toBeNull();
  });
});
