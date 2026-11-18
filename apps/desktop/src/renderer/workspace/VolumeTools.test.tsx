// @vitest-environment jsdom
import type { HeightTiles } from '@aio/schema';
// @ts-expect-error the kit's own base computation is retired: the package no longer exports it
import { pileVolume } from '@aio/volumetric';
import { volumetric } from '@aio/volumetric';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteReply } from '../survey/engineClient';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCompareDates } from './dates/compareDates';
import { connectVolumeChange, connectVolumePair } from './VolumeTools';

/** Cut / fill turned on (the Show control does it in the app). */
const showCutFill = () => {
  volumetric.getState().setSurface('change');
};

/** A prepared surface of a capture (the engine's survey side). */
const surface = (id: string, capture: string) =>
  ({
    id,
    capture,
    cellM: 0.5,
    bounds: [0, 0, 0, 100, 100, 10],
    source: { kind: 'dsm' },
  }) as unknown as HeightTiles;

beforeEach(() => {
  volumetric.setState({
    status: 'ready',
    epoch: 'e3',
    surface: 'photo',
    swipe: false,
    change: null,
    changeGrid: null,
    file: {
      captures: [
        { epoch: 'e1', captureId: 'c1', date: '2026-01-12', label: '12 Jan 2026' },
        { epoch: 'e2', captureId: 'c2', date: '2026-02-09', label: '9 Feb 2026' },
        { epoch: 'e3', captureId: 'c3', date: '2026-03-09', label: '9 Mar 2026' },
      ],
    } as never,
  });
});
afterEach(() => {
  volumetric.setState({ status: 'idle', file: null, surface: 'photo', change: null });
});

describe('the kit Cut & fill pair follows the app compare pair', () => {
  it('previous to current until a pair is picked', () => {
    const pairs = createCompareDates();
    const off = connectVolumePair(volumetric, pairs);
    try {
      showCutFill();
      expect(volumetric.getState().change).toEqual({ from: 'e2', to: 'e3' });
    } finally {
      off();
    }
  });

  it('a From and To picked in the Cut & fill pane or on the dates strip recolour the terrain', () => {
    const pairs = createCompareDates();
    const off = connectVolumePair(volumetric, pairs);
    try {
      showCutFill();
      pairs.getState().set('c1', 'c3');
      expect(volumetric.getState().change).toEqual({ from: 'e1', to: 'e3' });
      pairs.getState().set('c1', 'c2');
      expect(volumetric.getState().change).toEqual({ from: 'e1', to: 'e2' });
      // a pair the wrong way round: the earlier survey is From
      pairs.getState().set('c3', 'c2');
      expect(volumetric.getState().change).toEqual({ from: 'e2', to: 'e3' });
    } finally {
      off();
    }
  });

  it('a pair picked before the colours are switched on is the one they open on', () => {
    const pairs = createCompareDates();
    pairs.getState().set('c1', 'c2');
    const off = connectVolumePair(volumetric, pairs);
    try {
      // the photo shows: the pair does not switch the colours on by itself
      expect(volumetric.getState().surface).toBe('photo');
      expect(volumetric.getState().change).toBeNull();
      showCutFill();
      expect(volumetric.getState().change).toEqual({ from: 'e1', to: 'e2' });
    } finally {
      off();
    }
  });

  it('a pair the kit has no survey for, or one date twice, leaves the kit pair alone', () => {
    const pairs = createCompareDates();
    const off = connectVolumePair(volumetric, pairs);
    try {
      showCutFill();
      pairs.getState().set('c1', 'other');
      pairs.getState().set('c2', 'c2');
      expect(volumetric.getState().change).toEqual({ from: 'e2', to: 'e3' });
      off();
      // disconnected: a later pick no longer reaches the kit
      pairs.getState().set('c1', 'c2');
      expect(volumetric.getState().change).toEqual({ from: 'e2', to: 'e3' });
    } finally {
      off();
    }
  });
});

describe('Volume tools: Cut / fill', () => {
  it('the engine compares the picked surveys, not first and last', async () => {
    const site = vi.fn((): Promise<SiteReply> =>
      Promise.resolve({
        result: {} as never,
        grid: { dz: new Float32Array(4), nx: 2, ny: 2, x0: 0, y0: 0, cellM: 50 },
      }),
    );
    const pairs = createCompareDates();
    const offPair = connectVolumePair(volumetric, pairs);
    const off = connectVolumeChange(volumetric, {
      site,
      surfaces: () => [surface('h1', 'c1'), surface('h2', 'c2'), surface('h3', 'c3')],
    });
    try {
      showCutFill();
      pairs.getState().set('c1', 'c2');
      expect(volumetric.getState().change).toEqual({ from: 'e1', to: 'e2' });
      // the engine's whole-site comparison of the two picked surveys, never first to last
      const last = site.mock.calls.at(-1) as unknown as [{ from: unknown; to: unknown }, string];
      expect(last[0]).toMatchObject({
        from: { kind: 'survey', surface: 'h1' },
        to: { kind: 'survey', surface: 'h2' },
      });
      // and it opened on previous to current, not on the first and the last survey
      const first = site.mock.calls[0] as unknown as [{ from: unknown; to: unknown }, string];
      expect(first[0]).toMatchObject({
        from: { kind: 'survey', surface: 'h2' },
        to: { kind: 'survey', surface: 'h3' },
      });
      await vi.waitFor(() => {
        expect(volumetric.getState().changeGrid).toMatchObject({ from: 'e1', to: 'e2' });
      });
    } finally {
      off();
      offPair();
    }
  });

  it('leaves the colours to the survey heights when a date has no prepared surface', async () => {
    const site = vi.fn();
    const off = connectVolumeChange(volumetric, { site, surfaces: () => [surface('h3', 'c3')] });
    try {
      showCutFill();
      await Promise.resolve();
      expect(site).not.toHaveBeenCalled();
      expect(volumetric.getState().changeGrid).toBeNull();
    } finally {
      off();
    }
  });

  it('asks the engine once the prepared surfaces arrive', () => {
    const site = vi.fn(() => new Promise<SiteReply>(() => undefined));
    let surfaces: HeightTiles[] = [];
    const listeners = new Set<() => void>();
    const off = connectVolumeChange(volumetric, {
      site,
      surfaces: () => surfaces,
      onSurfaces: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    });
    try {
      showCutFill();
      expect(site).not.toHaveBeenCalled();
      surfaces = [surface('h2', 'c2'), surface('h3', 'c3')];
      for (const l of listeners) l();
      expect(site).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });
});

describe('the volumetric package', () => {
  it('exports no base computation', async () => {
    expect(pileVolume).toBeUndefined();
    const names = Object.keys(await import('@aio/volumetric'));
    for (const gone of [
      'pileVolume',
      'pileVolumes',
      'pileChange',
      'gridBase',
      'fineBody',
      'coarseBody',
      'sectionProfile',
      'BASE_IDS',
      'registerRows',
      'registerCsv',
      'VolumesPanel',
      'BaseSelect',
      'ProfileChart',
    ])
      expect(names).not.toContain(gone);
  });
});

describe('the retired kit pickers and section line', () => {
  it('are gone from the volume tools and the island: no second From and To', async () => {
    const tools = Object.keys(await import('./VolumeTools'));
    expect(tools).not.toContain('VolumeChangePicks');
    expect(tools).not.toContain('toggleVolumeSection');
    for (const file of ['VolumeTools.tsx', 'island/groups.tsx']) {
      const src = readFileSync(join(__dirname, file), 'utf8');
      expect(src).not.toContain('vol-change-from');
      expect(src).not.toContain('setBody');
      expect(src).not.toMatch(/>\s*Swipe\s*</);
      expect(src).not.toContain("'Swipe'");
    }
  });
});
