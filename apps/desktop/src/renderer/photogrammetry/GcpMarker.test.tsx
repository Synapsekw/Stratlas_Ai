// @vitest-environment jsdom
/**
 * The marker inside the ground control panel, with main slow to answer: what the keyboard flow of
 * `e2e/gcp-marking.spec.ts` met on the CI runners (run 38060640179, 10 Oct 2026). The panel showed
 * a mark before main had saved it, so the count changed at the key press, but the marker moved to
 * the next photo only when the save came back. For that long the count was ahead of the photo:
 * the spec read the photo's name before the move and its ring after it (238 px apart: two photos
 * 25 m apart at 60 m), and its next Enter, 43 ms later, confirmed the photo just marked again.
 */
import { ProjectManifest, type GcpFile, type PhotoRun } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Reply {
  ok: true;
  value: { ok: true } | { ok: false; error: string };
}
const { call, writes } = vi.hoisted(() => ({
  call: vi.fn(),
  /** The `photo:writeGcp` calls main has not answered yet, oldest first. */
  writes: [] as { gcp: GcpFile; answer: (r: Reply) => void }[],
}));
vi.mock('../shell', () => ({
  bridge: { call },
  useJobs: (selector: (s: { jobs: never[] }) => unknown) => selector({ jobs: [] }),
}));
vi.mock('@aio/maps', () => ({ LocationPicker: () => null }));
vi.mock('./actions', () => ({ startGeoref: () => Promise.resolve(null) }));

import { GcpPanel } from './GcpTable';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RUN = '20261010-1200';
const NADIR = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
/** Four nadir photos 15 m apart along one flight line, 60 m above the point: all four see it. */
const PHOTOS = [-22.5, -7.5, 7.5, 22.5].map((z, i) => ({
  id: `img-${String(i + 1)}`,
  name: `IMG_000${String(i + 1)}.JPG`,
  pos: [0, 60, z],
}));
const manifest = ProjectManifest.parse({
  schema: 'aio.project/1',
  id: 'gcp-site',
  name: 'GCP site',
  customer: 'Test',
  site: 'Synthetic site',
  crs: { epsg: 32639 },
  origin: [500000, 3200000, 0],
  captures: [{ id: 'c1', label: 'Survey', date: '2026-10-01' }],
  layers: [
    {
      kind: 'photos',
      id: 'photos',
      name: 'Synthetic flight',
      items: PHOTOS.map((p) => ({
        id: p.id,
        src: { path: `photos/${p.name}` },
        pos: p.pos,
        q: NADIR,
        lens: { model: 'pinhole', hfovDeg: 70, aspect: 4 / 3 },
      })),
    },
  ],
  severityModels: [],
  classCatalogues: [],
});
const run = {
  id: RUN,
  photos: { source: { layer: 'photos' }, count: PHOTOS.length },
  cameras: [{ id: 'cam1', widthPx: 800, heightPx: 600, photos: PHOTOS.length }],
} as unknown as PhotoRun;
const onDisk: GcpFile = {
  schema: 'aio.gcp/1',
  crs: { epsg: 32639 },
  points: ['GCP1', 'GCP2', 'GCP3'].map((id, i) => ({
    id,
    role: 'control',
    xyz: [500000 + 4 * i, 3200000, 0],
    accuracy: { horizontalM: 0.02, verticalM: 0.03 },
    marks: [],
  })),
};
const OK: Reply = { ok: true, value: { ok: true } };

let host: HTMLDivElement;
let root: Root | undefined;
let watch: MutationObserver | undefined;
/** What the marker showed after every change of the page: count, photo named, ring drawn. */
let seen: { count: string; photo: string; ring: string | null }[] = [];

const q = (id: string) =>
  host.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? expect.fail(`no ${id}`);
const count = () => /\d of \d/.exec(q('marker-count').textContent)?.[0] ?? '';
const shown = () =>
  host.querySelector('.ph-mk-list button[aria-current="true"] .mono')?.textContent ?? '';
const ringAt = () =>
  host.querySelector('[data-testid="prediction-ring"]')?.getAttribute('data-px') ?? null;
const states = () =>
  Object.fromEntries(
    [...host.querySelectorAll('.ph-mk-list button')].map((b) => [
      b.querySelector('.mono')?.textContent ?? '',
      b.querySelector('.ph-mk-st')?.textContent ?? '',
    ]),
  );
const confirmed = () =>
  Object.entries(states())
    .filter(([, s]) => s === 'confirmed')
    .map(([name]) => name)
    .sort();
/** A key on the marker's viewer, as the keyboard sends it. */
const press = (key: string) => {
  act(() => {
    q('marker-viewer').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
};
/** Let the panel hand its next save to main (saves are queued, a microtask apart). */
const sent = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
/** Main answers the oldest write it has. */
const answer = async (r: Reply) => {
  await sent();
  const w = writes.shift() ?? expect.fail('no write is waiting');
  await act(async () => {
    w.answer(r);
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(async () => {
  writes.length = 0;
  call.mockReset();
  call.mockImplementation((channel: string, req: { gcp: GcpFile }) => {
    if (channel === 'photo:readGcp')
      return Promise.resolve({ ok: true, value: { ok: true, gcp: onDisk } });
    if (channel === 'photo:writeGcp')
      return new Promise<Reply>((reply) => {
        writes.push({ gcp: req.gcp, answer: reply });
      });
    throw new Error(`unexpected channel ${channel}`);
  });
  // no refined cameras yet: the marker goes by the poses of the photos layer
  vi.stubGlobal('fetch', () => Promise.resolve({ ok: false }));
  workspace.getState().openProject({ id: manifest.id, root: '/gcp-site', manifest });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<GcpPanel run={RUN} data={run} />);
    await Promise.resolve();
  });
  const mark =
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Mark GCP1') ??
    expect.fail('no Mark GCP1 button');
  await act(async () => {
    mark.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  seen = [];
  watch = new MutationObserver(() => {
    seen.push({ count: count(), photo: shown(), ring: ringAt() });
  });
  watch.observe(host, { subtree: true, childList: true, attributes: true, characterData: true });
});
afterEach(() => {
  watch?.disconnect();
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
  vi.unstubAllGlobals();
});

describe('marking with the keyboard while main saves', () => {
  it('changes the count, the photo and the ring together, when main has the mark', async () => {
    // the two photos nearest the point come first, their rings 7.5 m either side of the centre
    expect(Object.keys(states())).toHaveLength(4);
    const first = shown();
    const firstRing = ringAt();
    expect(count()).toBe('0 of 3');

    press('Enter');
    await sent();
    // main has the write and has not answered: nothing shows yet but "saving"
    expect(writes).toHaveLength(1);
    expect([count(), shown(), ringAt()]).toEqual(['0 of 3', first, firstRing]);
    expect(host.querySelector('.ph-mk-bar')?.textContent).toContain('saving');

    await answer(OK);
    expect(count()).toBe('1 of 3');
    expect(shown()).not.toBe(first);
    expect(confirmed()).toEqual([first]);
    // the ring drawn is the one of the photo named: on the other side of the image centre,
    // 7.5 m at 60 m (71 px) from it, where the first photo's ring was 71 px the other way
    const at = (s: string | null) => (s ?? '').split(',').map(Number);
    const [x = NaN, y = NaN] = at(ringAt());
    expect(x).toBeCloseTo(400, 0);
    expect(Math.abs(y - 300)).toBeCloseTo(71.4, 0);
    expect(y - 300).toBeCloseTo(300 - (at(firstRing)[1] ?? NaN), 0);

    // at no time was the count ahead of the photo, or the name one photo's and the ring another's
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      if (s.count === '0 of 3') expect([s.photo, s.ring]).toEqual([first, firstRing]);
      else expect([s.count, s.photo, s.ring]).toEqual(['1 of 3', shown(), ringAt()]);
    }
  });

  it('confirms three photos with three key presses, the photo shown never one already marked', async () => {
    const marked: string[] = [];
    for (const n of [1, 2, 3]) {
      marked.push(shown());
      press('Enter');
      await answer(OK);
      expect(count()).toBe(`${String(n)} of 3`);
      expect(states()[shown()]).not.toBe('confirmed');
    }
    expect(new Set(marked).size).toBe(3);
    expect(confirmed()).toEqual([...marked].sort());
    // whenever the count showed, the photo shown was not among the ones it counted
    const counted = (c: string) => marked.slice(0, Number(c[0]));
    for (const s of seen) expect(counted(s.count)).not.toContain(s.photo);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('ignores a mark key while a mark is being saved: one photo, one mark, one write', async () => {
    const first = shown();
    press('Enter');
    press('Enter');
    press('s');
    await sent();
    expect(writes).toHaveLength(1);
    await answer(OK);
    await sent();
    expect(writes).toHaveLength(0);
    expect(count()).toBe('1 of 3');
    expect(confirmed()).toEqual([first]);
    expect(Object.values(states()).filter((s) => s === 'skipped')).toEqual([]);
    // the next key is taken again
    const second = shown();
    press('Enter');
    await answer(OK);
    expect(confirmed()).toEqual([first, second].sort());
  });

  it('shows nothing of a mark main refuses, but the reason', async () => {
    const first = shown();
    press('Enter');
    await answer({ ok: true, value: { ok: false, error: 'gcp.json changed on disk.' } });
    expect(count()).toBe('0 of 3');
    expect(shown()).toBe(first);
    expect(confirmed()).toEqual([]);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('changed on disk');
    for (const s of seen) expect(s.count).toBe('0 of 3');
    // and the marker is not stuck
    press('Enter');
    await answer(OK);
    expect(count()).toBe('1 of 3');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('skips to the next photo, and N and P only look', async () => {
    const first = shown();
    press('s');
    await answer(OK);
    expect(states()[first]).toBe('skipped');
    expect(shown()).not.toBe(first);
    expect(count()).toBe('0 of 3');
    const here = shown();
    press('n');
    expect(shown()).not.toBe(here);
    press('p');
    expect(shown()).toBe(here);
    await sent();
    expect(writes).toHaveLength(0);
  });
});
