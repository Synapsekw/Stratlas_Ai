// @vitest-environment jsdom
import { emptyMeasurements, type SurveyMeasurement } from '@aio/schema';
import { volumetric } from '@aio/volumetric';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rfStore } from '../rf/rfStore';
import { roadStore } from '../road/store';
import { measureStore } from '../survey/measureStore';
import { antennaStore } from '../telecom/antennaStore';
import { heldFacts } from './heldFacts';
import { NOTHING_HELD, type Held, type ToolSet } from './toolSets';
import { useHeld, useToolSets } from './useToolSets';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let held: Held = NOTHING_HELD;
let sets: ToolSet[] = [];

/** Renders what the hooks say, for `read` to pick up after each change. */
function Probe() {
  return (
    <output data-held={JSON.stringify(useHeld())} data-sets={JSON.stringify([...useToolSets()])} />
  );
}

function read() {
  const out = host?.querySelector('output');
  held = JSON.parse(out?.getAttribute('data-held') ?? 'null') as Held;
  sets = JSON.parse(out?.getAttribute('data-sets') ?? '[]') as ToolSet[];
}

const measurement = (tool: string, family: string): SurveyMeasurement =>
  ({
    id: `m-${tool}`,
    family,
    tool,
    label: tool,
    scope: { kind: 'project' },
    points: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
    ],
    items: [],
    results: [],
    createdAt: '2026-11-18T00:00:00Z',
  }) as unknown as SurveyMeasurement;

const withMeasurements = (...list: SurveyMeasurement[]) => {
  measureStore.setState({
    projectId: 'p',
    status: 'ready',
    file: { ...emptyMeasurements(), measurements: list },
  });
};

/** Everything a project could hold, gone: an open confined space project with no records. */
function reset() {
  workspace.setState({
    project: { id: 'p', root: 'C:/p', manifest: { layers: [], purpose: 'confined-space' } },
  } as unknown as Partial<ReturnType<typeof workspace.getState>>);
  volumetric.setState({ status: 'none' });
  measureStore.setState({ projectId: 'p', status: 'ready', file: emptyMeasurements() });
  roadStore.setState({ status: 'none', road: null });
  antennaStore.setState({ projectId: 'p', status: 'ready', file: null });
  rfStore.setState({ projectId: 'p', status: 'ready', antennas: null, hasFile: false });
  heldFacts.setState({ thermal: false });
}

const set = (change: () => void) => {
  act(change);
  read();
};

beforeEach(() => {
  reset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(<Probe />);
  });
  read();
});
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
  reset();
  workspace.setState({ project: null });
});

describe('the records a project holds', () => {
  it('nothing held: a confined space project has no tool set', () => {
    expect(held).toEqual(NOTHING_HELD);
    expect([...sets]).toEqual([]);
  });

  it('an antenna inventory is Telecom', () => {
    set(() => {
      antennaStore.setState({ file: { units: [] } as never });
    });
    expect(held).toEqual({ ...NOTHING_HELD, telecom: true });
    expect([...sets]).toEqual(['telecom']);
  });

  it('the inventory as the coverage planner read it is Telecom', () => {
    set(() => {
      rfStore.setState({ antennas: { units: [] } as never });
    });
    expect(held.telecom).toBe(true);
  });

  it('saved sectors, an RF plan alone, is Telecom', () => {
    set(() => {
      rfStore.setState({ hasFile: true });
    });
    expect(held).toEqual({ ...NOTHING_HELD, telecom: true });
  });

  it("another project's RF plan is not this project's", () => {
    set(() => {
      rfStore.setState({ projectId: 'other', hasFile: true, antennas: {} as never });
    });
    expect(held.telecom).toBe(false);
  });

  it('a saved telecom measurement is Telecom, of each of the three tools', () => {
    for (const tool of ['azimuth', 'antenna-tilt', 'clearance']) {
      set(() => {
        withMeasurements(measurement(tool, 'telecom'));
      });
      expect(held, tool).toEqual({ ...NOTHING_HELD, telecom: true });
    }
    set(() => {
      withMeasurements(measurement('distance', 'line'));
    });
    expect(held).toEqual(NOTHING_HELD);
  });

  it('a pile is Earthworks', () => {
    set(() => {
      withMeasurements(measurement('volume', 'polygon'));
    });
    expect(held).toEqual({ ...NOTHING_HELD, earthworks: true });
  });

  it('the stockpile kit is Earthworks, while it loads too', () => {
    for (const status of ['loading', 'ready'] as const) {
      set(() => {
        volumetric.setState({ status });
      });
      expect(held.earthworks, status).toBe(true);
    }
    set(() => {
      volumetric.setState({ status: 'none' });
    });
    expect(held.earthworks).toBe(false);
  });

  it('a road model is Road; a road survey that has none yet holds nothing', () => {
    set(() => {
      roadStore.setState({ status: 'ready' });
    });
    expect(held).toEqual({ ...NOTHING_HELD, road: true });
    set(() => {
      roadStore.setState({ status: 'setup' });
    });
    expect(held.road).toBe(false);
  });

  it('a thermal photo is Thermal', () => {
    set(() => {
      heldFacts.setState({ thermal: true });
    });
    expect(held).toEqual({ ...NOTHING_HELD, thermal: true });
    expect([...sets]).toEqual(['thermal']);
  });
});

describe('a record that is there but cannot be read counts as held', () => {
  it('the antenna inventory', () => {
    set(() => {
      antennaStore.setState({ status: 'error', file: null });
    });
    expect(held).toEqual({ ...NOTHING_HELD, telecom: true });
  });

  it('the RF plan or its inventory', () => {
    set(() => {
      rfStore.setState({ status: 'error', antennas: null, hasFile: false });
    });
    expect(held).toEqual({ ...NOTHING_HELD, telecom: true });
  });

  it("not another project's unreadable inventory", () => {
    set(() => {
      antennaStore.setState({ projectId: 'other', status: 'error' });
      rfStore.setState({ projectId: 'other', status: 'error' });
    });
    expect(held.telecom).toBe(false);
  });

  it('the measurements: they may hold piles and telecom measurements', () => {
    set(() => {
      measureStore.setState({ status: 'error', file: emptyMeasurements() });
    });
    expect(held).toEqual({ ...NOTHING_HELD, earthworks: true, telecom: true });
  });

  it('the stockpile kit', () => {
    set(() => {
      volumetric.setState({ status: 'error' });
    });
    expect(held.earthworks).toBe(true);
  });

  it('the road model', () => {
    set(() => {
      roadStore.setState({ status: 'error' });
    });
    expect(held).toEqual({ ...NOTHING_HELD, road: true });
  });
});
