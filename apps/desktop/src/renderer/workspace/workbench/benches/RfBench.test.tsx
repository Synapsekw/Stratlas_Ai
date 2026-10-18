// @vitest-environment jsdom
import type { AntennasFile, PipelinePackStatus, RfSectorsFile } from '@aio/schema';
import { RF_COVERAGE_MIN_PACK } from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ShellModule from '../../../shell';
import {
  AAU_ENTRY,
  ANTENNA_ENTRY,
  RADIO_ENTRY,
  antennasFile,
  lteSettings,
  sectorsFile,
  unit,
} from '../../../rf/__fixtures__/rfData';
import { processingTools } from '../../../processingTools';
import { RfLayer } from '../../../rf/RfLayer';
import { assumptionsText } from '../../../rf/rfText';
import { resetRf, rfStore, setPreviewState } from '../../../rf/rfStore';
import { threeDates } from '../../__fixtures__/threeDates';
import { sectionStore } from '../sectionState';
import { workbench } from '../workbenchStore';
import { RfBench } from './RfBench';

type Call = [string, Record<string, unknown>];

const h = vi.hoisted(() => ({
  antennas: null as AntennasFile | null,
  sectors: null as RfSectorsFile | null,
  readOnly: false,
  calls: [] as Call[],
  writeWarnings: undefined as string[] | undefined,
  pack: null as Pick<PipelinePackStatus, 'state' | 'version'> | null,
  loads: 0,
}));

vi.mock('../../../shell', async (importOriginal) => ({
  ...(await importOriginal<typeof ShellModule>()),
  bridge: {
    call: vi.fn((channel: string, req: Record<string, unknown>) => {
      h.calls.push([channel, req]);
      switch (channel) {
        case 'telecom:readAntennas':
          return Promise.resolve({
            ok: true,
            value: { ok: true, file: structuredClone(h.antennas), readOnly: false },
          });
        case 'rf:readSectors':
          return Promise.resolve({
            ok: true,
            value: {
              ok: true,
              file: structuredClone(h.sectors),
              readOnly: h.readOnly,
              orphans: [],
            },
          });
        case 'rf:listCatalogue':
          return Promise.resolve({
            ok: true,
            value: {
              ok: true,
              entries: [ANTENNA_ENTRY, RADIO_ENTRY, AAU_ENTRY].map((entry) => ({
                origin: 'builtin',
                entry,
              })),
              warnings: [],
            },
          });
        case 'rf:listRuns':
          return Promise.resolve({ ok: true, value: { ok: true, runs: [] } });
        case 'rf:writeSectors':
          h.sectors = structuredClone(req.file) as RfSectorsFile;
          return Promise.resolve({
            ok: true,
            value: { ok: true, ...(h.writeWarnings ? { warnings: h.writeWarnings } : {}) },
          });
        case 'jobs:start':
          return Promise.resolve({
            ok: true,
            value: {
              ok: true,
              job: {
                id: 'job-1',
                pipeline: 'rf.coverage',
                project: '/p3',
                params: req.params,
                status: 'running',
                progress: 0,
                steps: [],
                artifacts: [],
                createdAt: '2026-10-17T10:00:00Z',
                updatedAt: '2026-10-17T10:00:00Z',
              },
            },
          });
        default:
          return Promise.resolve({ ok: false, error: 'unexpected' });
      }
    }),
  },
}));

vi.mock('../../../processingTools', async () => {
  const { createStore, useStore } = await import('zustand');
  const store = createStore(() => ({
    status: h.pack,
    error: null as string | null,
    load: () => {
      h.loads++;
      return Promise.resolve();
    },
  }));
  return {
    processingTools: store,
    useProcessingTools: <T,>(sel: (s: { status: typeof h.pack; error: string | null }) => T) =>
      useStore(store, sel),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
const q = (sel: string) => document.body.querySelector<HTMLElement>(sel);
const qi = (sel: string) => document.body.querySelector<HTMLInputElement>(sel);
const byTest = (id: string) => q(`[data-testid="${id}"]`);

/** The mocked processing tools store holds only the pack's state and version. */
const setPack = (pack: typeof h.pack) => {
  processingTools.setState({ status: pack as PipelinePackStatus | null, error: null });
};
const flush = async () => {
  for (let i = 0; i < 5; i++) await act(() => Promise.resolve());
};
const render = async () => {
  act(() => {
    setPack(h.pack);
  });
  root = createRoot(host);
  act(() => root?.render(<RfBench />));
  await flush();
};
const click = (el: Element | null) => {
  act(() => (el as HTMLElement | null)?.click());
};
const setNumber = (input: HTMLInputElement | null, value: string) => {
  if (!input) throw new Error('no input');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    input.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
};

const OK_PACK = { state: 'ok', version: RF_COVERAGE_MIN_PACK } as const;

beforeEach(() => {
  localStorage.clear();
  sectionStore.setState({ byBench: {} });
  resetRf();
  workbench.getState().reset();
  h.calls = [];
  h.readOnly = false;
  h.writeWarnings = undefined;
  h.pack = OK_PACK;
  h.antennas = antennasFile([unit('ant-a1', 10), unit('ant-a2', 130)]);
  h.sectors = sectorsFile(
    [
      { id: 'sec-s1', antennaIds: ['ant-a1'] },
      { id: 'sec-s2', antennaIds: ['ant-a2'] },
    ],
    [lteSettings('ant-a1'), lteSettings('ant-a2')],
  );
  workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: threeDates });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
});

describe('RfBench', () => {
  it('has the Site, Sector and Results sections, open', async () => {
    await render();
    for (const id of ['rf-site', 'rf-sector', 'rf-results'])
      expect(byTest(`wb-section-${id}`)?.getAttribute('data-open')).toBe('true');
  });

  it('shows the measured geometry with its basis marks', async () => {
    await render();
    const az = q('[data-testid="rf-unit-ant-a1"] [data-field="azimuth"]');
    // grid 10, convergence 0.5
    expect(az?.textContent).toContain('10.5° true · 10.0° grid');
    expect(az?.querySelector('.tag')?.textContent).toBe('measured');
    const tilt = q('[data-testid="rf-unit-ant-a1"] [data-field="downtilt"]');
    expect(tilt?.textContent).toContain('4.0°');
    expect(tilt?.querySelector('.tag')?.textContent).toBe('measured');
    // box centre 131.5 over the detected tower base at 100
    expect(qi('[data-testid="rf-height"]')?.value).toBe('31.5');
    const height = q('[data-testid="rf-unit-ant-a1"] [data-field="height"]');
    expect(height?.querySelector('.tag')?.textContent).toBe('measured');
  });

  it('marks a typed height as typed and clears it back to measured', async () => {
    await render();
    setNumber(qi('[data-testid="rf-height"]'), '28');
    const height = q('[data-testid="rf-unit-ant-a1"] [data-field="height"]');
    expect(height?.querySelector('.tag')?.textContent).toBe('typed');
    expect(rfStore.getState().sectors.antennas[0]?.heightOverrideM).toBe(28);
  });

  it('keeps the e-tilt slider inside the port range and clamps a typed value', async () => {
    h.sectors = sectorsFile(
      [{ id: 'sec-s1', antennaIds: ['ant-a1'] }],
      // port "high": 0 to 8 degrees, step 1; a stored 20 is outside it
      [lteSettings('ant-a1', { etiltDeg: 20 })],
    );
    await render();
    const slider = qi('[data-testid="rf-etilt"]');
    expect(slider?.min).toBe('0');
    expect(slider?.max).toBe('8');
    expect(slider?.step).toBe('1');
    expect(slider?.value).toBe('8');
    setNumber(qi('[data-testid="rf-etilt-number"]'), '-3');
    expect(rfStore.getState().sectors.antennas[0]?.etiltDeg).toBe(0);
    setNumber(qi('[data-testid="rf-etilt-number"]'), '5.4');
    expect(rfStore.getState().sectors.antennas[0]?.etiltDeg).toBe(5);
    expect(q('[data-testid="rf-unit-ant-a1"] [data-field="etilt"]')?.textContent).toContain(
      'range 0 to 8°, step 1°',
    );
  });

  it('keeps unsaved edits when the tab is shown again (another tab in front, then RF)', async () => {
    await render();
    setNumber(qi('[data-testid="rf-etilt-number"]'), '6');
    expect(rfStore.getState().dirty).toBe(true);
    // the workbench unmounts a tab that is not in front and mounts it again when shown
    act(() => root?.unmount());
    await render();
    expect(rfStore.getState().dirty).toBe(true);
    expect(rfStore.getState().sectors.antennas[0]?.etiltDeg).toBe(6);
    expect(qi('[data-testid="rf-etilt-number"]')?.value).toBe('6');
    expect(h.sectors?.antennas[0]?.etiltDeg).toBe(4);
  });

  it('states the assumptions as the legend does (one helper, the same total margin)', async () => {
    await render();
    const study = rfStore.getState().sectors.study;
    const line = assumptionsText(t, study);
    expect(byTest('rf-indicative')?.textContent).toContain(line);
    expect(line).toMatch(/^Assumes outdoor use: 0 dB penetration, .* dB in all; phone at /);
  });

  it('a study too large to preview says so, and can still be saved and run', async () => {
    await render();
    const save = () => byTest('rf-save-run');
    setNumber(qi('[data-testid="rf-etilt-number"]'), '6');
    // the coverage follower (the RF layer) works the preview out; here its state is set directly
    expect(save()?.getAttribute('aria-disabled')).toBe('true');
    expect(byTest('rf-preview-too-large')).toBeNull();
    act(() => {
      setPreviewState({ status: 'too-large', error: null });
    });
    expect(byTest('rf-preview-too-large')?.textContent).toBe(t('rf.results.previewTooLarge'));
    expect(save()?.getAttribute('aria-disabled')).toBeNull();
    expect(byTest('rf-run')?.getAttribute('aria-disabled')).toBeNull();
  });

  it('a close and reopen of the same project does not bring back unsaved edits', async () => {
    // the RF layer, mounted with the app, resets the store when the project closes
    root = createRoot(host);
    act(() => {
      setPack(h.pack);
      root?.render(
        <>
          <RfLayer />
          <RfBench />
        </>,
      );
    });
    await flush();
    setNumber(qi('[data-testid="rf-etilt-number"]'), '6');
    expect(rfStore.getState().dirty).toBe(true);
    act(() => {
      workspace.getState().closeProject();
    });
    await flush();
    expect(rfStore.getState().projectId).toBeNull();
    act(() => {
      workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: threeDates });
    });
    await flush();
    expect(rfStore.getState().projectId).toBe('p3');
    expect(rfStore.getState().dirty).toBe(false);
    expect(rfStore.getState().sectors.antennas[0]?.etiltDeg).toBe(4);
    expect(qi('[data-testid="rf-etilt-number"]')?.value).toBe('4');
  });

  it('picking an AAU disables the antenna and radio fields and labels the AAU total power', async () => {
    await render();
    expect(byTest('rf-pick-antenna')?.getAttribute('aria-disabled')).toBeNull();
    click(byTest('rf-pick-aau'));
    expect(byTest('rf-catalogue')).not.toBeNull();
    // the carrier is B3, which this AAU does not support: the band filter hides it until cleared
    expect(byTest('rf-cat-aau-x')).toBeNull();
    const supports = [...document.querySelectorAll<HTMLElement>('.rf-cat-filters button')].find(
      (b) => b.textContent === 'Supports B3',
    );
    expect(supports?.getAttribute('aria-pressed')).toBe('true');
    click(supports ?? null);
    click(byTest('rf-cat-aau-x'));
    click(byTest('rf-cat-use'));
    await flush();
    expect(byTest('rf-catalogue')).toBeNull();
    const s = rfStore.getState().sectors.antennas.find((a) => a.antennaId === 'ant-a1');
    expect(s?.equipment).toEqual({ kind: 'aau', aau: 'aau-x' });
    // an AAU's carriers name neither a radio nor a port
    expect(s?.carriers[0]?.port).toBeUndefined();
    for (const id of ['rf-pick-antenna', 'rf-pick-radio']) {
      const b = byTest(id);
      expect(b?.getAttribute('aria-disabled')).toBe('true');
      expect(b?.textContent).toContain('Built into the AAU');
    }
    expect(byTest('rf-loss')?.hasAttribute('disabled')).toBe(true);
    const power = q('[data-testid="rf-unit-ant-a1"] [data-field="power"]');
    expect(power?.textContent).toContain('AAU total power');
    expect(power?.textContent).toContain('53 dBm');
    // the e-tilt follows the AAU's range (3 to 9)
    expect(qi('[data-testid="rf-etilt"]')?.min).toBe('3');
  });

  it('holds Run coverage until the pack is known, then starts the job, the tab open but not a live tool', async () => {
    h.pack = null;
    await render();
    const run = () => byTest('rf-run');
    expect(run()?.getAttribute('aria-disabled')).toBe('true');
    expect(run()?.textContent).toContain('Checking the processing tools');
    act(() => {
      setPack(OK_PACK);
    });
    expect(run()?.getAttribute('aria-disabled')).toBeNull();
    workbench.getState().open('rf');
    click(run());
    await flush();
    const start = h.calls.find(([c]) => c === 'jobs:start');
    expect(start?.[1]).toMatchObject({ pipeline: 'rf.coverage', project: '/p3' });
    expect((start?.[1].params as { runId: string }).runId).toMatch(/^rf-/);
    // a run is an activity the Jobs tab follows, not a tool (review I2)
    expect(workbench.getState().tabs.find((t) => t.id === 'rf')?.live).toBeFalsy();
    expect(workbench.getState().front).toBe('rf');
    expect(rfStore.getState().running).toBe(true);
  });

  it('says why a run cannot start: a pack too old and no coordinate system', async () => {
    h.pack = { state: 'ok', version: '0.1.0' };
    await render();
    expect(byTest('rf-run')?.textContent).toContain(
      `processing tools ${RF_COVERAGE_MIN_PACK} or newer`,
    );
    resetRf();
    h.pack = OK_PACK;
    h.antennas = antennasFile([unit('ant-a1', 10, { convergenceDeg: null })]);
    h.sectors = sectorsFile([{ id: 'sec-s1', antennaIds: ['ant-a1'] }], [lteSettings('ant-a1')]);
    act(() => root?.unmount());
    await render();
    expect(byTest('rf-run')?.textContent).toContain('no coordinate system');
    expect(byTest('rf-left-out')?.textContent).toContain('true north is unknown');
  });

  it('keeps a deleted sector that holds orphan settings and says why, inline', async () => {
    h.sectors = sectorsFile(
      [{ id: 'sec-s1', antennaIds: ['ant-a1', 'ant-gone'] }],
      [lteSettings('ant-a1'), lteSettings('ant-gone')],
    );
    await render();
    click(q('[data-sector="sec-s1"] button[aria-label="Delete sector S1"]'));
    expect(rfStore.getState().sectors.sectors.map((s) => s.id)).toEqual(['sec-s1']);
    expect(byTest('rf-sector-kept')?.textContent).toContain(
      'still holds settings for antennas no longer found',
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(byTest('rf-orphans')?.textContent).toContain('ant-gone');
  });

  it('shows the warnings rf:writeSectors returns after a save', async () => {
    h.writeWarnings = ['Pattern file p1.msi could not be copied.'];
    await render();
    const name = qi('[data-sector="sec-s1"] input');
    setNumber(name, 'North');
    click(byTest('rf-save'));
    await flush();
    expect(h.sectors?.sectors[0]?.name).toBe('North');
    expect(byTest('rf-write-warnings')?.textContent).toContain('p1.msi could not be copied');
  });

  it('says when the processing tools could not be checked, and checks again on Retry', async () => {
    h.pack = null;
    await render();
    act(() => {
      processingTools.setState({ error: 'The pack folder could not be read.' });
    });
    const failed = byTest('rf-pack-failed');
    expect(failed?.textContent).toContain('The pack folder could not be read.');
    expect(byTest('rf-run')?.textContent).toContain('could not be checked');
    const before = h.loads;
    click(failed?.querySelector('button') ?? null);
    expect(h.loads).toBe(before + 1);
  });

  it('notes the carriers it does not edit', async () => {
    const two = lteSettings('ant-a1');
    two.carriers = [
      ...two.carriers,
      { id: 'c2', tech: 'lte', band: 'B20', bandwidthMhz: 10, feederLossDb: 0 },
    ];
    h.sectors = sectorsFile([{ id: 'sec-s1', antennaIds: ['ant-a1'] }], [two]);
    await render();
    expect(byTest('rf-more-carriers')?.textContent).toContain('1 more carrier');
  });

  it('shows the empty state when the project has no antenna inventory', async () => {
    h.antennas = null;
    await render();
    expect(byTest('rf-bench')?.textContent).toContain('No antenna inventory yet');
  });
});
