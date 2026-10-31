// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shell/dateFolders', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  moveLayersToDate: vi.fn(() => Promise.resolve({ stays: {}, moved: [] })),
}));

const { listActions, runAction } = await import('./actionBridge');
const { moveLayersToDate } = await import('../shell/dateFolders');
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

beforeEach(() => {
  workspace.setState({
    project: { id: 'p', root: 'C:/p', manifest },
    hidden: {},
    issues: [],
  } as unknown as Partial<ReturnType<typeof workspace.getState>>);
  shell.setState({ pkg: null } as never);
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

  it('takes a layer by its name and a date by its day', async () => {
    const byName = await listActions({ target: { kind: 'layers', ids: ['Outline'] } });
    expect((byName.result as Listed).actions.length).toBeGreaterThan(0);
    const byDay = await listActions({ target: { kind: 'date', date: '2024-10-02' } });
    expect((byDay.result as Listed).actions.map((a) => a.id)).toContain('date.hide');
  });

  it('greys the edits in a package, with the reason the menu shows', async () => {
    shell.setState({ pkg: { name: 'x' } } as never);
    const r = await listActions({ target: { kind: 'layers', ids: ['v'] } });
    const del = (r.result as Listed).actions.find((a) => a.id === 'layer.delete');
    expect(del?.greyed).toBeTruthy();
  });
});

describe('run_action', () => {
  it('runs a view action as the menu does', async () => {
    const r = await runAction({ action: 'layer.hide', target: { kind: 'layers', ids: ['v'] } });
    expect(r.result).toMatchObject({ action: 'layer.hide', done: true });
    expect(workspace.getState().hidden.v).toBe(true);
  });

  it('files a layer under the picked date through the Datasets move', async () => {
    await runAction({
      action: 'layer.moveToDate',
      target: { kind: 'layers', ids: ['v'] },
      pick: 'oct',
    });
    expect(moveLayersToDate).toHaveBeenCalledWith(['v'], 'oct');
  });

  it('asks for a pick, and refuses one that is not offered', async () => {
    const move = { action: 'layer.moveToDate', target: { kind: 'layers', ids: ['v'] } };
    await expect(runAction(move)).rejects.toThrow(/needs a pick/);
    await expect(runAction({ ...move, pick: 'jan' })).rejects.toThrow(/No pick "jan"/);
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
