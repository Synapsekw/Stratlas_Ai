// @vitest-environment jsdom
import { defaultToolContext, runRendererTool, type RendererToolContext } from '@aio/ai';
import type { AgentNote } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// main's store, in memory: the real one is tested in main/agentMemory.test.ts
let notes: AgentNote[] = [];
let readOnly = false;
let seq = 0;
function main(channel: string, req: Record<string, unknown>) {
  if (channel === 'ai:memory') return { ok: true, value: { ok: true, notes, readOnly } };
  if (readOnly)
    return { ok: true, value: { ok: false, error: 'This project is a read-only package.' } };
  if (channel === 'ai:remember') {
    const note = (req.restore as AgentNote | undefined) ?? {
      id: `n-test${++seq}`,
      text: String(req.text).trim(),
      ...(req.about ? { about: req.about as string } : {}),
      by: req.by as 'agent',
      createdAt: '2026-11-12T10:00:00.000Z',
    };
    notes = [...notes, note];
    return { ok: true, value: { ok: true, note } };
  }
  if (channel === 'ai:forget') {
    const note = notes.find((n) => n.id === req.id);
    if (!note)
      return { ok: true, value: { ok: false, error: `There is no note ${String(req.id)}.` } };
    notes = notes.filter((n) => n.id !== req.id);
    return { ok: true, value: { ok: true, note } };
  }
  return { ok: false, error: 'unexpected' };
}
const call = vi.fn((channel: string, req: Record<string, unknown>) =>
  Promise.resolve(main(channel, req)),
);
vi.mock('../shell', () => ({ bridge: { call: (c: string, r: never) => call(c, r) } }));

const { agentNotes, describeForget, describeRemember, loadNotes, registerMemoryTools } =
  await import('./memoryTools');

const ctx = (): RendererToolContext => defaultToolContext('scene3d');
const open = (id: string | null) => {
  workspace.setState({
    project: id ? { id, root: 'C:/p', manifest: { captures: [], layers: [] } } : null,
  } as unknown as Partial<ReturnType<typeof workspace.getState>>);
};

beforeAll(() => {
  registerMemoryTools();
});

beforeEach(() => {
  notes = [];
  readOnly = false;
  call.mockClear();
  agentNotes.setState({ projectId: null, notes: [], readOnly: false, error: null });
  open('p');
});

describe('remember_note', () => {
  it('saves the note as the agent, says so, and its undo forgets it', async () => {
    await loadNotes('p');
    const r = await runRendererTool(
      'remember_note',
      { text: 'Volumes are reported in cubic yards', about: 'measurement:m-3' },
      ctx(),
    );
    expect(call).toHaveBeenCalledWith('ai:remember', {
      projectId: 'p',
      text: 'Volumes are reported in cubic yards',
      about: 'measurement:m-3',
      by: 'agent',
    });
    expect(r.result).toEqual({
      saved: {
        id: 'n-test1',
        text: 'Volumes are reported in cubic yards',
        about: 'measurement:m-3',
      },
    });
    expect(r.summary).toBe('Noted: Volumes are reported in cubic yards');
    await vi.waitFor(() => {
      expect(agentNotes.getState().notes).toHaveLength(1);
    });
    expect(await r.undo?.()).toBeNull();
    expect(notes).toEqual([]);
  });

  it('answers the refusal plainly (a package, a full memory)', async () => {
    readOnly = true;
    await expect(runRendererTool('remember_note', { text: 'x' }, ctx())).rejects.toThrow(
      /read-only package/,
    );
  });

  it('answers plainly with no project open', async () => {
    open(null);
    await expect(runRendererTool('remember_note', { text: 'x' }, ctx())).rejects.toThrow(
      /No project is open/,
    );
    expect(call).not.toHaveBeenCalled();
  });

  it('shows the note on the approval card', () => {
    expect(describeRemember({ text: ' Units are feet ' })).toBe('Remember: Units are feet');
    expect(describeRemember({ text: 'Weighed as granite', about: 'measurement:m-3' })).toBe(
      'Remember about measurement:m-3: Weighed as granite',
    );
  });
});

describe('forget_note', () => {
  const kept: AgentNote = {
    id: 'n-keep1',
    text: 'The crusher is called C-2',
    by: 'person',
    createdAt: '2026-11-01T08:00:00.000Z',
  };

  it('deletes the note and its undo puts it back as it was', async () => {
    notes = [kept];
    const r = await runRendererTool('forget_note', { id: 'n-keep1' }, ctx());
    expect(r.summary).toBe('Note deleted: The crusher is called C-2');
    expect(notes).toEqual([]);
    expect(await r.undo?.()).toBeNull();
    expect(call).toHaveBeenLastCalledWith('ai:remember', {
      projectId: 'p',
      text: kept.text,
      by: 'person',
      restore: kept,
    });
    expect(notes).toEqual([kept]);
  });

  it('refuses the undo in another project', async () => {
    notes = [kept];
    const r = await runRendererTool('forget_note', { id: 'n-keep1' }, ctx());
    open('other');
    expect(await r.undo?.()).toBe('Not undone: another project is open.');
    expect(notes).toEqual([]);
  });

  it('says so when the note is not there', async () => {
    await expect(runRendererTool('forget_note', { id: 'n-none1' }, ctx())).rejects.toThrow(
      /no note n-none1/,
    );
  });

  it('names the note on the approval card once the notes were read, else its id', async () => {
    expect(describeForget({ id: 'n-keep1' })).toBe('Forget: n-keep1');
    notes = [kept];
    await loadNotes('p');
    expect(describeForget({ id: 'n-keep1' })).toBe('Forget: The crusher is called C-2');
    expect(agentNotes.getState()).toMatchObject({ projectId: 'p', readOnly: false, error: null });
  });
});
