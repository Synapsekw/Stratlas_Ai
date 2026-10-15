// @vitest-environment jsdom
import { stackModel, type ComponentsPanel } from '@aio/modelling';
import type { EngineerRun, ProcModel } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { engineerHost } from './host';
import { useEngineeringReview } from './review';
import type { RunIpc, RunState } from './runStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
let seen: { model: ProcModel; panel: ComponentsPanel } | null = null;
const see = (v: typeof seen) => {
  seen = v;
};

function Probe({ shown }: { shown: ProcModel | null }) {
  see(useEngineeringReview(shown));
  return null;
}

const model = (): ProcModel => {
  const m = stackModel();
  return {
    ...m,
    assemblies: m.assemblies.map((a) =>
      a.id === 'flue-1' ? { ...a, sources: [{ kind: 'photo', ref: 'img-photo-1' }] } : a,
    ),
  };
};
const run = {
  id: 'run-1',
  setup: { sources: { clouds: [{ layer: 'scan' }], meshes: [], photos: [] } },
  stages: {},
} as unknown as EngineerRun;

function setup() {
  const rebuild = vi.fn(() => Promise.resolve());
  const store = createStore<RunState>(
    () =>
      ({
        run,
        model: model(),
        draftLayer: 'model-draft-stack',
        busy: false,
        build: null,
        report: null,
        conflicts: [],
        unresolved: [],
        flagged: [],
        rebuild,
      }) as unknown as RunState,
  );
  const modelWrite = vi.fn(() => Promise.resolve());
  const modelBuild = vi.fn(() => Promise.resolve({ layer: 'model-draft-stack' }));
  const evidenceImage = vi.fn(() => Promise.resolve('data:image/png;base64,AAAA'));
  const ipc = { modelWrite, modelBuild, evidenceImage } as unknown as RunIpc;
  engineerHost.setState({ projectId: 'p', store, ipc, selected: null, hidden: [], thumbnails: {} });
  return { store, rebuild, modelWrite, modelBuild, evidenceImage };
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  engineerHost.setState({ store: null, ipc: null, projectId: null });
  seen = null;
});

const panel = () => {
  if (!seen) throw new Error('no review');
  return seen.panel;
};

describe('the engineering review in the Model builder', () => {
  it('shows the run model with its panel, not another model the builder has open', () => {
    setup();
    act(() => root?.render(<Probe shown={null} />));
    expect(seen?.model.id).toBe('stack-test');
    act(() => root?.render(<Probe shown={{ id: 'other' } as ProcModel} />));
    expect(seen).toBeNull();
  });

  it('turns a value edit and a removal into a rebuild with the person values', () => {
    const { rebuild } = setup();
    act(() => root?.render(<Probe shown={null} />));
    act(() => {
      panel().onField('flue-1', 'height', 7);
    });
    const user = (rebuild.mock.calls[0] as unknown[] | undefined)?.[0] as {
      params: Record<string, Record<string, unknown>>;
    };
    expect(user.params['flue-1']?.height).toBe(7);
    act(() => {
      panel().onRemove('flue-2');
    });
    expect((rebuild.mock.calls[1] as unknown[] | undefined)?.[0]).toMatchObject({
      removed: ['flue-2'],
    });
  });

  it('writes status and additions to the model and draws the draft again', async () => {
    const { modelWrite, modelBuild, store } = setup();
    act(() => root?.render(<Probe shown={null} />));
    await act(async () => {
      panel().onStatus(['flue-1'], 'accepted');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(modelWrite).toHaveBeenCalledTimes(1);
    expect(store.getState().model?.assemblies.find((a) => a.id === 'flue-1')?.status).toBe(
      'accepted',
    );
    expect(modelBuild).toHaveBeenCalledWith('stack-test', true);
  });

  it('hides a component in the draft, loads the evidence thumbnails and focuses it', async () => {
    const { evidenceImage } = setup();
    workspace.setState({ selection: null } as never);
    act(() => root?.render(<Probe shown={null} />));
    act(() => {
      panel().onToggle('flue-2');
    });
    expect(engineerHost.getState().hidden).toEqual(['flue-2']);
    await act(async () => {
      panel().onSelect('flue-1');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(evidenceImage).toHaveBeenCalledWith('run-1', 'img-photo-1');
    expect(panel().thumbnails['img-photo-1']).toBe('data:image/png;base64,AAAA');
    const flyTo = vi.spyOn(workspace.getState(), 'flyTo');
    act(() => {
      panel().onFocus('flue-1');
    });
    expect(workspace.getState().selection).toEqual({
      kind: 'asset',
      id: 'flue-1',
      layer: 'model-draft-stack',
    });
    expect(flyTo).toHaveBeenCalled();
    flyTo.mockRestore();
  });
});
