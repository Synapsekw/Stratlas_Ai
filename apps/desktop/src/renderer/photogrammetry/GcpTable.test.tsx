// @vitest-environment jsdom
import { ProjectManifest, type GcpFile, type GcpPoint, type PhotoRun } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Reply {
  ok: true;
  value: { ok: true } | { ok: false; error: string };
}
const { call, writes, startGeoref } = vi.hoisted(() => ({
  call: vi.fn(),
  /** The `photo:writeGcp` calls main has not answered yet, oldest first. */
  writes: [] as { gcp: GcpFile; answer: (r: Reply) => void }[],
  startGeoref: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../shell', () => ({
  bridge: { call },
  useJobs: (selector: (s: { jobs: never[] }) => unknown) => selector({ jobs: [] }),
}));
vi.mock('@aio/maps', () => ({ LocationPicker: () => null }));
vi.mock('./actions', () => ({ startGeoref }));
vi.mock('./GcpMarker', () => ({ GcpMarker: () => null }));

import { GcpPanel } from './GcpTable';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RUN = '20261010-1200';
const manifest = ProjectManifest.parse({
  schema: 'aio.project/1',
  id: 'gcp-site',
  name: 'GCP site',
  customer: 'Test',
  site: 'Synthetic site',
  crs: { epsg: 32639 },
  origin: [500000, 3200000, 0],
  captures: [{ id: 'c1', label: 'Survey', date: '2026-10-01' }],
  layers: [],
  severityModels: [],
  classCatalogues: [],
});
const gcpPoint = (id: string): GcpPoint => ({
  id,
  role: 'control',
  xyz: [500000, 3200000, 10],
  accuracy: { horizontalM: 0.02, verticalM: 0.03 },
  marks: [],
});
const onDisk: GcpFile = {
  schema: 'aio.gcp/1',
  crs: { epsg: 32639 },
  points: ['GCP1', 'GCP2', 'GCP3', 'GCP4'].map(gcpPoint),
};
const OK: Reply = { ok: true, value: { ok: true } };

let host: HTMLDivElement;
let root: Root | undefined;
/** Open the panel on a run whose gcp.json is `gcp`. */
const mount = async (gcp: GcpFile) => {
  call.mockImplementation((channel: string, req: { gcp: GcpFile }) => {
    if (channel === 'photo:readGcp') return Promise.resolve({ ok: true, value: { ok: true, gcp } });
    if (channel === 'photo:writeGcp')
      return new Promise<Reply>((answer) => {
        writes.push({ gcp: req.gcp, answer });
      });
    throw new Error(`unexpected channel ${channel}`);
  });
  act(() => root?.unmount());
  root = createRoot(host);
  await act(async () => {
    // the run document only has to be there: the table reads the points from gcp.json
    root?.render(<GcpPanel run={RUN} data={{ id: RUN } as PhotoRun} />);
    await Promise.resolve();
  });
};
beforeEach(async () => {
  writes.length = 0;
  call.mockReset();
  startGeoref.mockClear();
  workspace.getState().openProject({ id: manifest.id, root: '/gcp-site', manifest });
  host = document.createElement('div');
  document.body.append(host);
  await mount(onDisk);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
});

const use = (id: string) =>
  host.querySelector<HTMLInputElement>(`input[aria-label="Use ${id}"]`) ??
  expect.fail(`no Use checkbox for ${id}`);
const click = (el: HTMLElement) => {
  act(() => {
    el.click();
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
  const w = writes.shift() ?? expect.fail('no write is waiting');
  await act(async () => {
    w.answer(r);
    await Promise.resolve();
    await Promise.resolve();
  });
};
const disabled = (f: GcpFile | undefined) =>
  (f?.points ?? []).filter((p) => p.disabled).map((p) => p.id);

describe('the Use checkbox of the ground control table', () => {
  it('switches a point off at the click, before main has saved it', async () => {
    expect(use('GCP2').checked).toBe(true);
    click(use('GCP2'));
    // nothing is saved yet: the checkbox shows the change (it used to bounce back until the save)
    expect(use('GCP2').checked).toBe(false);
    expect(host.querySelector('tr[data-point="GCP2"]')?.className).toBe('off');
    await sent();
    expect(writes).toHaveLength(1);
    expect(use('GCP2').checked).toBe(false);
    expect(disabled(writes[0]?.gcp)).toEqual(['GCP2']);
    await answer(OK);
    expect(use('GCP2').checked).toBe(false);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    // and on again
    click(use('GCP2'));
    expect(use('GCP2').checked).toBe(true);
    await sent();
    expect(disabled(writes[0]?.gcp)).toEqual([]);
    expect(writes[0]?.gcp.points[1]).not.toHaveProperty('disabled');
  });

  it('saves two quick changes one after the other, the second on top of the first', async () => {
    click(use('GCP2'));
    click(use('GCP4'));
    expect([use('GCP2').checked, use('GCP4').checked]).toEqual([false, false]);
    await sent();
    // one write at a time: two at once would look to main like a change on disk
    expect(writes).toHaveLength(1);
    expect(disabled(writes[0]?.gcp)).toEqual(['GCP2']);
    await answer(OK);
    expect(writes).toHaveLength(1);
    expect(disabled(writes[0]?.gcp)).toEqual(['GCP2', 'GCP4']);
    await answer(OK);
    expect(writes).toHaveLength(0);
    expect([use('GCP2').checked, use('GCP4').checked]).toEqual([false, false]);
  });

  it('goes back to what was saved, with the reason, when a save is refused', async () => {
    click(use('GCP2'));
    await sent();
    await answer(OK);
    click(use('GCP3'));
    expect(use('GCP3').checked).toBe(false);
    await sent();
    await answer({ ok: true, value: { ok: false, error: 'gcp.json changed on disk.' } });
    expect(use('GCP3').checked).toBe(true);
    expect(use('GCP2').checked).toBe(false);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('changed on disk');
  });

  it('starts the adjustment only when the change shown is in gcp.json', async () => {
    // three control points marked in three photos each, a fourth without a mark
    const marked = (p: GcpPoint): GcpPoint => ({
      ...p,
      marks: ['a', 'b', 'c'].map((photo) => ({
        photo,
        px: [10, 10] as [number, number],
        by: 'person' as const,
        at: '2026-10-10T10:00:00.000Z',
        state: 'confirmed' as const,
      })),
    });
    await mount({
      ...onDisk,
      points: onDisk.points.map((p) => (p.id === 'GCP4' ? p : marked(p))),
    });
    const adjust =
      host.querySelector<HTMLButtonElement>('[data-testid="gcp-adjust"]') ??
      expect.fail('no Adjust button');
    expect(adjust.disabled).toBe(true);
    // GCP4 off: Adjust can be clicked at once, while main is still saving that
    click(use('GCP4'));
    expect(adjust.disabled).toBe(false);
    click(adjust);
    await sent();
    expect(writes).toHaveLength(1);
    expect(startGeoref).not.toHaveBeenCalled();
    await answer(OK);
    expect(startGeoref).toHaveBeenCalledTimes(1);
  });
});
