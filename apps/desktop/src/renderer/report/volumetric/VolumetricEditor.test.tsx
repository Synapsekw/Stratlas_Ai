// @vitest-environment jsdom
import { volumetricModel, type VolumetricInput, type VolumetricModel } from '@aio/project/export';
import type { ReportTextFile, SurveyMeasurement } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editText } from './editorModel';
import { picturesFingerprint, volumetricView } from './editorView';
import { VolumetricEditor } from './VolumetricEditor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../../shell', () => ({ bridge: { call } }));
vi.mock('../../author', () => ({ authorName: () => 'Surveyor' }));
vi.mock('../../diskChanged', () => ({
  reportIfChangedOnDisk: vi.fn(),
  useDiskChanged: (pick: (s: { reloads: number }) => unknown) => pick({ reloads: 0 }),
}));
const { runExportAction } = vi.hoisted(() => ({ runExportAction: vi.fn() }));
vi.mock('../../exports/exports', () => ({ runExportAction }));
const { takeReportPictures } = vi.hoisted(() => ({ takeReportPictures: vi.fn() }));
vi.mock('./liveStage', () => ({ takeReportPictures }));

const pileDate = (capture: string, volumeM3: number) => ({
  capture,
  volumeM3,
  densityTPerM3: 1.6,
  areaM2: 100,
  peakM: 4,
  plusMinusM3: null,
  outline: [
    [0, 0],
    [10, 0],
    [10, 10],
  ] as [number, number][],
});
const input: VolumetricInput = {
  captures: [
    { id: 'c1', label: 'June', date: '2026-06-01' },
    { id: 'c2', label: 'July', date: '2026-07-01' },
  ],
  piles: [
    {
      id: 'm1',
      label: 'SP1',
      material: null,
      base: 'Lowest point',
      dates: [pileDate('c1', 1000), pileDate('c2', 1200)],
    },
  ],
  project: { name: 'Demo yard', customer: 'Yard owner', site: null, crs: 'EPSG:32639' },
  method: { cellM: 0.1, gsdCm: 3, siteDensityTPerM3: null },
  frame: null,
};
const twoDates = volumetricModel(input);
const oneDate = volumetricModel({
  ...input,
  captures: input.captures.slice(1),
  piles: input.piles.map((p) => ({ ...p, dates: p.dates.slice(1) })),
});

const measurements = [
  {
    id: 'm1',
    family: 'polygon',
    label: 'SP1',
    points: [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
    ],
    items: [{ from: { kind: 'lowest' }, to: { kind: 'current' } }],
    results: [],
  },
] as unknown as SurveyMeasurement[];

let model: VolumetricModel = twoDates;
let saved: ReportTextFile | null = null;
let readOnly = false;
const writes: ReportTextFile[] = [];

let host: HTMLDivElement;
let root: Root | undefined;

async function mount(props: { exportsAllowed?: boolean } = {}) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <VolumetricEditor
        projectId="p1"
        customer="Yard owner"
        companyName="Survey company"
        measurements={measurements}
        exportsAllowed={props.exportsAllowed ?? true}
        onClose={() => undefined}
      />,
    );
  });
  // the saved edits, then the model
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await Promise.resolve();
    });
}

const field = (label: string) =>
  host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
const preview = () => host.querySelector('[data-testid="volumetric-preview"]');
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent.trim() === text);

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const blur = (el: HTMLElement) => {
  act(() => {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
};

beforeEach(() => {
  model = twoDates;
  saved = null;
  readOnly = false;
  writes.length = 0;
  runExportAction.mockReset();
  takeReportPictures.mockReset();
  call.mockReset();
  call.mockImplementation((channel: string, req: Record<string, unknown>) => {
    if (channel === 'report:readText')
      return Promise.resolve({ ok: true, value: { ok: true, file: saved, readOnly } });
    if (channel === 'report:writeText') {
      writes.push(req.file as ReportTextFile);
      return Promise.resolve({ ok: true, value: { ok: true } });
    }
    if (channel === 'report:volumetricModel')
      return Promise.resolve({ ok: true, value: { ok: true, model } });
    return Promise.resolve({ ok: false, error: `unexpected ${channel}` });
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  volumetricView.setState({ openFor: null, taken: {}, pictureError: null });
});

describe('the volumetric report editor', () => {
  it('shows the fields with their defaults and the preview pages', async () => {
    await mount();
    expect(field('Title')?.value).toBe('Stockpile volume report');
    expect(field('Prepared for')?.value).toBe('Yard owner');
    expect(field('Prepared by')?.value).toBe('Survey company');
    expect(field('In short')?.value).not.toBe('');
    expect(field('Method note')?.value).not.toBe('');
    expect(field('Intro')?.value).toBe('');
    expect(field('Closing remarks')?.value).toBe('');
    expect(field('Note on SP1')).not.toBeNull();
    expect(host.querySelector('[aria-label="Compare with"]')).not.toBeNull();
    const pages = preview()?.querySelectorAll('.vr-page') ?? [];
    expect(pages.length).toBeGreaterThan(0);
    expect(preview()?.textContent).toContain('Stockpile volume report');
  });

  it('updates the preview as the person types, and saves the edit', async () => {
    await mount();
    const summary = field('In short');
    if (!summary) throw new Error('no summary field');
    type(summary, 'Edited summary for the demo yard.');
    expect(preview()?.textContent).toContain('Edited summary for the demo yard.');
    blur(summary);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });
    expect(writes.at(-1)?.parts.summary?.versions.at(-1)).toMatchObject({
      text: 'Edited summary for the demo yard.',
      source: 'user',
    });
  });

  it('puts the generated sentence back with Reset to generated', async () => {
    saved = editText(null, 'summary', 'Written by hand.');
    await mount();
    expect(field('In short')?.value).toBe('Written by hand.');
    const reset = host.querySelector<HTMLButtonElement>(
      '[aria-label="Reset to generated: In short"]',
    );
    act(() => reset?.click());
    expect(field('In short')?.value).not.toBe('Written by hand.');
    expect(preview()?.textContent).not.toContain('Written by hand.');
  });

  it('asks for pictures when none are saved, and takes them for the report dates', async () => {
    takeReportPictures.mockResolvedValue({ ok: true, frame: {} });
    await mount();
    const bar = host.querySelector('[data-testid="volumetric-pictures"]');
    expect(bar?.textContent).toContain('No pictures yet');
    await act(async () => {
      button('Take pictures')?.click();
      await Promise.resolve();
    });
    expect(takeReportPictures).toHaveBeenCalledTimes(1);
    const req = takeReportPictures.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(req).toMatchObject({
      projectId: 'p1',
      dates: ['c1', 'c2'],
      pair: { from: 'c1', to: 'c2' },
      fingerprint: picturesFingerprint(measurements, ['c1', 'c2'], { from: 'c1', to: 'c2' }),
    });
    expect((req.piles as { id: string }[]).map((p) => p.id)).toEqual(['m1']);
    expect(volumetricView.getState().taken).toEqual({ p1: 1 });
  });

  it('says when the pictures are stale', async () => {
    model = {
      ...twoDates,
      frame: {
        schema: 'aio.report-views/1',
        extent: [0, 0, 10, 10],
        widthPx: 100,
        heightPx: 100,
        mPerPx: 0.1,
        views: [],
        markers3d: {},
        fingerprint: 'v1-old',
      },
    };
    await mount();
    const bar = host.querySelector('[data-testid="volumetric-pictures"]');
    expect(bar?.textContent).toContain('The data changed since the pictures were taken.');
    expect(button('Take pictures again')).toBeDefined();
  });

  it('writes pending edits, then exports the PDF and the HTML', async () => {
    await mount();
    const title = field('Title');
    if (!title) throw new Error('no title field');
    type(title, 'Monthly stock');
    await act(async () => {
      button('Export PDF')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(writes.at(-1)?.parts.title?.versions.at(-1)?.text).toBe('Monthly stock');
    expect(runExportAction).toHaveBeenLastCalledWith('volumetric-pdf');
    await act(async () => {
      button('Export HTML')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(runExportAction).toHaveBeenLastCalledWith('volumetric-html');
  });

  it('turns pages on and off, keeping one on', async () => {
    await mount();
    const page = (name: string) =>
      [...host.querySelectorAll<HTMLLabelElement>('.vre-pages-on label')]
        .find((l) => l.textContent.includes(name))
        ?.querySelector('input');
    const before = preview()?.querySelectorAll('.vr-page').length ?? 0;
    act(() => page('B. Pile cards')?.click());
    expect(preview()?.querySelectorAll('.vr-page').length).toBeLessThan(before);
    act(() => page('C. What changed')?.click());
    // only A is on now: it cannot be turned off
    expect(page('A. Cover and summary')?.disabled).toBe(true);
  });

  it('leaves page C and the comparison out with one date', async () => {
    model = oneDate;
    await mount();
    expect(host.textContent).toContain('Only one survey date has figures');
    expect(host.querySelector('[aria-label="Compare with"]')).toBeNull();
  });

  it('opens a package read only, and still exports', async () => {
    readOnly = true;
    await mount();
    expect(host.textContent).toContain('This package is read only.');
    expect(field('In short')?.readOnly).toBe(true);
    expect(button('Export PDF')?.disabled).toBe(false);
  });

  it('says so when the package does not allow report exports', async () => {
    await mount({ exportsAllowed: false });
    expect(button('Export PDF')).toBeUndefined();
  });
});
