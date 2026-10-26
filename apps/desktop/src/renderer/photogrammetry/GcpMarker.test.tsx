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
const { call, writes, sentFiles } = vi.hoisted(() => ({
  call: vi.fn(),
  /** The `photo:writeGcp` calls main has not answered yet, oldest first. */
  writes: [] as { gcp: GcpFile; answer: (r: Reply) => void }[],
  /** Every file sent to `photo:writeGcp`, answered or not. */
  sentFiles: [] as GcpFile[],
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
  sentFiles.length = 0;
  localStorage.clear();
  call.mockReset();
  call.mockImplementation((channel: string, req: { gcp: GcpFile }) => {
    if (channel === 'photo:readGcp')
      return Promise.resolve({ ok: true, value: { ok: true, gcp: onDisk } });
    if (channel === 'photo:writeGcp')
      return new Promise<Reply>((reply) => {
        sentFiles.push(req.gcp);
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

describe('aiming with the cursor loupe and the arrow keys', () => {
  /** The photo is 800 x 600 original px, shown 400 x 300 CSS px at (100, 50): 1:2. */
  const IMG = { left: 100, top: 50, width: 400, height: 300 };
  /** The viewer, which the loupe is placed in. */
  const VIEW = { left: 0, top: 0, width: 600, height: 400 };
  const rect = (r: typeof IMG) =>
    ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height }) as DOMRect;

  const loupe = () => host.querySelector<HTMLElement>('[data-testid="marker-loupe"]');
  const xy = (s: string | null | undefined) => (s ?? '').split(',').map(Number);
  /** The mark main was last asked to save for the photo shown. */
  const lastMark = () => {
    const f = sentFiles.at(-1) ?? expect.fail('no write');
    const p = f.points.find((pp) => pp.id === 'GCP1');
    return p?.marks.at(-1);
  };
  const pointer = (type: string, x: number, y: number, o: MouseEventInit = {}) => {
    const el = host.querySelector('.ph-mk-img') ?? expect.fail('no photo');
    act(() => {
      el.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, ...o }));
    });
  };
  /** The photo has loaded (jsdom loads no images): the loupe can sample it. */
  const loaded = (natural = [800, 600]) => {
    const img = host.querySelector('.ph-mk-img img') ?? expect.fail('no img');
    Object.defineProperty(img, 'naturalWidth', { value: natural[0], configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: natural[1], configurable: true });
    act(() => {
      img.dispatchEvent(new Event('load'));
    });
  };

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains('ph-mk-img')) return rect(IMG);
      if (this.classList.contains('ph-mk-viewer')) return rect(VIEW);
      return rect({ left: 0, top: 0, width: 0, height: 0 });
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('nudges the mark one photo px with an arrow, ten with Shift, starting at the prediction', async () => {
    const first = shown();
    const [rx = NaN, ry = NaN] = xy(ringAt());
    press('ArrowRight');
    await sent();
    expect(lastMark()?.state).toBe('confirmed');
    // the ring's data-px is rounded to 0.1 px
    expect(lastMark()?.px[0]).toBeCloseTo(rx + 1, 0);
    expect(lastMark()?.px[1]).toBeCloseTo(ry, 0);
    await answer(OK);
    const from = lastMark()?.px ?? expect.fail('no mark');
    act(() => {
      q('marker-viewer').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }),
      );
    });
    await sent();
    expect(lastMark()?.px).toEqual([from[0], from[1] - 10]);
    await answer(OK);
    // the arrows never change the photo: N and P do
    expect(shown()).toBe(first);
    press('ArrowLeft');
    await answer(OK);
    expect(shown()).toBe(first);
    expect(xy(q('marker-mark').getAttribute('data-px'))).toEqual([from[0] - 1, from[1] - 10]);
  });

  it('rests the loupe on the prediction, then on the mark, while the cursor is off the photo', async () => {
    expect(loupe()).toBeNull(); // nothing to sample before the photo has loaded
    loaded();
    const [rx = NaN, ry = NaN] = xy(ringAt());
    const l = loupe() ?? expect.fail('no loupe');
    expect(l.getAttribute('aria-hidden')).toBe('true');
    expect(l.dataset.power).toBe('6');
    const [ax = NaN, ay = NaN] = xy(l.dataset.at);
    expect(ax).toBeCloseTo(rx, 0);
    expect(ay).toBeCloseTo(ry, 0);
    // drawn over the prediction on the photo: 1:2 from the photo's corner, in the viewer
    expect(parseFloat(l.style.left) + 130).toBeCloseTo(100 + ax / 2, 1);
    expect(parseFloat(l.style.top) + 130).toBeCloseTo(50 + ay / 2, 1);
    press('ArrowDown');
    await answer(OK);
    expect(xy(loupe()?.dataset.at)).toEqual(xy(q('marker-mark').getAttribute('data-px')));
    expect(host.querySelector('.ph-mk-bar')?.textContent).toContain('Photo 1:2 · loupe 6:1');
  });

  it('follows the cursor at true magnification and places the mark at its centre', async () => {
    loaded();
    // the cursor at (300, 200) is half way across the photo shown: original px 400, 300
    pointer('pointermove', 300, 200);
    const l = loupe() ?? expect.fail('no loupe');
    expect(xy(l.dataset.at)).toEqual([400, 300]);
    expect([l.style.left, l.style.top]).toEqual(['170px', '70px']);
    // 6 screen px per original px: the photo is 4800 x 3600, the aim under the centre
    expect(l.style.backgroundSize).toBe('4800px 3600px');
    expect(l.style.backgroundPosition).toBe('-2270px -1670px');
    // Shift: the aim moves at loupe speed, 12 screen px are 2 original px
    pointer('pointermove', 312, 197, { shiftKey: true });
    expect(xy(loupe()?.dataset.at)).toEqual([402, 299.5]);
    pointer('click', 312, 197);
    await sent();
    expect(lastMark()?.px).toEqual([402, 299.5]);
    await answer(OK);
    // off the photo: the loupe rests on the new mark
    pointer('pointerout', 600, 380, { relatedTarget: document.body });
    expect(xy(loupe()?.dataset.at)).toEqual([402, 299.5]);
  });

  it('changes the power with the wheel in steps from 2:1 to 12:1 and remembers it', () => {
    loaded();
    pointer('pointermove', 300, 200);
    const wheel = (deltaY: number) => {
      act(() => {
        host
          .querySelector('.ph-mk-img')
          ?.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
      });
    };
    wheel(-100);
    expect(loupe()?.dataset.power).toBe('8');
    for (let i = 0; i < 5; i++) wheel(-100);
    expect(loupe()?.dataset.power).toBe('12');
    expect(localStorage.getItem('quadrion.gcpLoupePower')).toBe('12');
    for (let i = 0; i < 9; i++) wheel(100);
    expect(loupe()?.dataset.power).toBe('2');
    expect(host.querySelector('.ph-mk-bar')?.textContent).toContain('loupe 2:1');
  });

  it('samples a photo read at another size in the calibrated size, where the marks are', () => {
    loaded([1600, 1200]); // a photo twice the calibrated 800 x 600
    pointer('pointermove', 300, 200);
    expect(xy(loupe()?.dataset.at)).toEqual([400, 300]);
    expect(loupe()?.style.backgroundSize).toBe('4800px 3600px');
  });
});

describe('the mark on the photo', () => {
  it('is an open crosshair the same size on screen at any zoom', async () => {
    press('Enter');
    await answer(OK);
    press('p');
    const arms = () =>
      [...host.querySelectorAll('[data-testid="marker-mark"] line:not(.halo)')].map((l) =>
        Math.hypot(
          Number(l.getAttribute('x2')) - Number(l.getAttribute('x1')),
          Number(l.getAttribute('y2')) - Number(l.getAttribute('y1')),
        ),
      );
    expect(arms()).toHaveLength(4);
    const unit = Number(q('marker-mark').dataset.unit);
    // in photo units, the arms are as long as their screen size times the photo px per screen px
    for (const a of arms()) expect(a / unit).toBeCloseTo(18, 6);
    expect(host.querySelector('[data-testid="marker-mark"] circle')).toBeNull();
  });
});
