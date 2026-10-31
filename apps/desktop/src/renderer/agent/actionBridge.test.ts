// @vitest-environment jsdom
import type { Layer, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The manifest write under the Datasets move: it waits until the test lets it answer. */
const write = vi.hoisted(() => ({
  answer: null as string | null,
  gate: null as Promise<void> | null,
}));

vi.mock('../change/SurveyDate', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  setLayersCapture: vi.fn(async (ids: readonly string[], capture: string | null) => {
    if (write.gate) await write.gate;
    if (write.answer) return write.answer;
    const { workspace: ws } = await import('@aio/workspace');
    const p = ws.getState().project;
    if (p) {
      const layers = p.manifest.layers.map((l: Layer) =>
        ids.includes(l.id) ? { ...l, ...(capture ? { capture } : { capture: undefined }) } : l,
      );
      ws.setState({ project: { ...p, manifest: { ...p.manifest, layers } } } as never);
    }
    return null;
  }),
}));
vi.mock('../shell/removal', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  askRemove: vi.fn(),
}));

const { describeRun, listActions, runAction, targetText } = await import('./actionBridge');
const { setLayersCapture } = await import('../change/SurveyDate');
const { askRemove } = await import('../shell/removal');
const { shell } = await import('../shell');

const L = (o: Record<string, unknown>) => ({ visible: true, ...o });
const manifest = {
  captures: [
    { id: 'sep', label: 'Survey', date: '2024-09-04' },
    { id: 'oct', label: 'Baseline', date: '2024-10-02' },
  ],
  layers: [
    L({ kind: 'vector', id: 'v', name: 'Outline', capture: 'sep', format: 'geojson' }),
    L({ kind: 'mesh', id: 'mesh', name: 'Model', capture: 'oct' }),
  ],
} as unknown as ProjectManifest;

interface Listed {
  actions: { id: string; asksApproval?: true; greyed?: string; picks?: { id: string }[] }[];
}

const open = (m: ProjectManifest = manifest) => {
  workspace.setState({
    project: { id: 'p', root: 'C:/p', manifest: m },
    hidden: {},
    issues: [],
  } as unknown as Partial<ReturnType<typeof workspace.getState>>);
};

beforeEach(() => {
  open();
  shell.setState({ pkg: null } as never);
  write.answer = null;
  write.gate = null;
  vi.mocked(setLayersCapture).mockClear();
});

describe('list_actions', () => {
  it("lists what the row's menu offers the agent, with approval and picks", async () => {
    const r = await listActions({ target: { kind: 'layers', ids: ['v'] } });
    const { actions } = r.result as Listed;
    const ids = actions.map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['layer.hide', 'layer.moveToDate', 'layer.delete']));
    // a name field stays with the person
    expect(ids).not.toContain('layer.rename');
    expect(actions.find((a) => a.id === 'layer.delete')?.asksApproval).toBe(true);
    expect(actions.find((a) => a.id === 'layer.hide')?.asksApproval).toBeUndefined();
    const picks = actions.find((a) => a.id === 'layer.moveToDate')?.picks?.map((p) => p.id);
    expect(picks).toEqual(expect.arrayContaining(['sep', 'oct']));
  });

  it('takes a layer by its name, a date by its day, and the earliest or latest date', async () => {
    const byName = await listActions({ target: { kind: 'layers', ids: ['Outline'] } });
    expect((byName.result as Listed).actions.length).toBeGreaterThan(0);
    const byDay = await listActions({ target: { kind: 'date', date: '2024-10-02' } });
    expect((byDay.result as Listed).actions.map((a) => a.id)).toContain('date.hide');
    const latest = await listActions({ target: { kind: 'date', date: 'latest' } });
    expect((latest.result as Listed).actions.map((a) => a.id)).toContain('date.hide');
  });

  it('greys the edits in a package, with the reason the menu shows', async () => {
    shell.setState({ pkg: { name: 'x' } } as never);
    const r = await listActions({ target: { kind: 'layers', ids: ['v'] } });
    const del = (r.result as Listed).actions.find((a) => a.id === 'layer.delete');
    expect(del?.greyed).toBeTruthy();
  });
});

describe('ambiguous targets', () => {
  const twins = {
    ...manifest,
    layers: [
      ...manifest.layers,
      L({ kind: 'vector', id: 'v2', name: 'Outline', capture: 'oct', format: 'geojson' }),
    ],
  } as unknown as ProjectManifest;

  it('refuses a layer name two layers share, naming each with its id and date', async () => {
    open(twins);
    await expect(
      runAction({ action: 'layer.hide', target: { kind: 'layers', ids: ['outline'] } }),
    ).rejects.toThrow(/fits several layers: v \(Outline, 2024-09-04\), v2 \(Outline, 2024-10-02\)/);
    expect(workspace.getState().hidden).toEqual({});
    // the exact id is taken
    await runAction({ action: 'layer.hide', target: { kind: 'layers', ids: ['v2'] } });
    expect(workspace.getState().hidden.v2).toBe(true);
  });

  it('refuses a date prefix two dates share', async () => {
    await expect(
      runAction({ action: 'date.hide', target: { kind: 'date', date: '2024' } }),
    ).rejects.toThrow(/fits several survey dates: sep \(2024-09-04, Survey\), oct/);
  });

  it('shows the resolved target on the approval card, not the text the model typed', () => {
    const card = describeRun({
      action: 'layer.delete',
      target: { kind: 'layers', ids: ['outline'] },
    });
    expect(card).toMatch(/Outline \(.*2024.*\)/);
    expect(card).not.toContain('outline');
    open(twins);
    expect(
      describeRun({ action: 'layer.delete', target: { kind: 'layers', ids: ['outline'] } }),
    ).toBeNull();
  });
});

describe('run_action', () => {
  it('runs a view action as the menu does', async () => {
    const r = await runAction({ action: 'layer.hide', target: { kind: 'layers', ids: ['v'] } });
    expect(r.result).toMatchObject({ action: 'layer.hide', status: 'done' });
    expect(workspace.getState().hidden.v).toBe(true);
  });

  it('waits for the date move to be written, then offers the Datasets undo', async () => {
    let release: () => void = () => undefined;
    write.gate = new Promise<void>((r) => {
      release = r;
    });
    let settled = false;
    const running = runAction({
      action: 'layer.moveToDate',
      target: { kind: 'layers', ids: ['v'] },
      pick: 'oct',
    }).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    release();
    write.gate = null;
    const r = await running;
    expect(setLayersCapture).toHaveBeenCalledWith(['v'], 'oct');
    expect(r.result).toMatchObject({ status: 'done' });
    expect(workspace.getState().project?.manifest.layers.find((l) => l.id === 'v')?.capture).toBe(
      'oct',
    );
    expect(await r.undo?.()).toBeNull();
    expect(workspace.getState().project?.manifest.layers.find((l) => l.id === 'v')?.capture).toBe(
      'sep',
    );
  });

  it('fails the step when the write is refused', async () => {
    write.answer = 'The project file could not be saved.';
    await expect(
      runAction({
        action: 'layer.moveToDate',
        target: { kind: 'layers', ids: ['v'] },
        pick: 'oct',
      }),
    ).rejects.toThrow(/could not be saved/);
  });

  it('says which layers keep the date their name carries', async () => {
    open({
      ...manifest,
      layers: [
        ...manifest.layers,
        L({ kind: 'vector', id: 'n', name: 'Cloud 2024-09-04', format: 'geojson' }),
      ],
    } as unknown as ProjectManifest);
    const r = await runAction({
      action: 'layer.moveToDate',
      target: { kind: 'layers', ids: ['n'] },
      pick: 'every',
    });
    expect(r.result).toMatchObject({ kept: [{ layer: 'Cloud 2024-09-04', keeps: '2024-09-04' }] });
  });

  it('answers that a delete waits for the person to confirm, not that it is done', async () => {
    const r = await runAction({ action: 'layer.delete', target: { kind: 'layers', ids: ['v'] } });
    expect(askRemove).toHaveBeenCalled();
    expect(r.result).toMatchObject({ status: 'waiting' });
    expect(r.summary).toMatch(/waiting for you to confirm/);
  });

  it('asks for a pick, and refuses one that is not offered', async () => {
    const move = { action: 'layer.moveToDate', target: { kind: 'layers', ids: ['v'] } };
    await expect(runAction(move)).rejects.toThrow(/needs a pick/);
    await expect(runAction({ ...move, pick: 'jan' })).rejects.toThrow(/No pick "jan"/);
  });

  it('reads the issue-row menu target and keeps the finding actions off the agent', async () => {
    expect(targetText({ kind: 'issues', ids: ['i1'], clicked: 'i1' }, manifest)).toBe(
      'the Issues rows',
    );
    const r = await listActions({ target: { kind: 'annotations', row: 'issues' } });
    const ids = (r.result as Listed).actions.map((a) => a.id);
    expect(ids).not.toContain('finding.movePoint');
    expect(ids).not.toContain('issue.placeOnModel');
  });

  it('refuses an excluded action with its reason', async () => {
    await expect(
      runAction({ action: 'layer.rename', target: { kind: 'layers', ids: ['v'] } }),
    ).rejects.toThrow(/stays with the person: Opens a name field/);
  });

  it('refuses an action the target does not offer, naming the offered ones', async () => {
    await expect(
      runAction({ action: 'measure.delete', target: { kind: 'layers', ids: ['v'] } }),
    ).rejects.toThrow(/not offered on this target\. Offered: .*layer\.hide/);
  });

  it('refuses a greyed action with its reason', async () => {
    shell.setState({ pkg: { name: 'x' } } as never);
    await expect(
      runAction({ action: 'layer.delete', target: { kind: 'layers', ids: ['v'] } }),
    ).rejects.toThrow(/is greyed: /);
  });

  it('says when a layer or date does not exist', async () => {
    await expect(
      runAction({ action: 'layer.hide', target: { kind: 'layers', ids: ['nope'] } }),
    ).rejects.toThrow(/No layer "nope"/);
    await expect(
      runAction({ action: 'date.hide', target: { kind: 'date', date: '1999-01-01' } }),
    ).rejects.toThrow(/No survey date "1999-01-01"/);
  });
});
