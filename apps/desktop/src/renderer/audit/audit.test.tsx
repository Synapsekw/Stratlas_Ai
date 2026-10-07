// @vitest-environment jsdom
import { issueEditor, issueSaver, setAnnotateReadOnly } from '@aio/annotate';
import type {
  AuditEntry,
  IpcChannel,
  IpcEvent,
  IpcRequest,
  IpcResponse,
  Issue,
  ProjectManifest,
  VerifyReport,
} from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditApi } from './api';
import { AuditScreen } from './AuditScreen';
import { HistoryPanel } from './HistoryPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEV = `d_${'a'.repeat(52)}`;
const ACTOR = `a_${'b'.repeat(26)}`;
const CHAIN = `${DEV}.r_${'d'.repeat(16)}`;

const manifest = {
  schema: 'aio.project/1',
  id: 'hcl',
  name: 'HCl',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [
    {
      id: 'tank-1-5',
      name: 'Tank',
      levels: [1, 2, 3, 4, 5].map((value) => ({
        value,
        label: `L${String(value)}`,
        color: '#8a94a6',
        criteria: '',
      })),
    },
  ],
  classCatalogues: [
    {
      id: 'tank',
      name: 'Tank defects',
      assetType: 'tank',
      classes: [
        { id: 'crack', label: 'Crack', color: '#e5484d', hotkey: 'c', severityModel: 'tank-1-5' },
      ],
    },
  ],
} as unknown as ProjectManifest;

const F01: Issue = {
  id: 'i1',
  code: 'F01',
  classId: 'crack',
  severityModelId: 'tank-1-5',
  severity: 4,
  status: 'draft',
  title: 'Crack in bottom plate',
  note: '',
  author: 'Dana Saleh',
  createdAt: '2026-10-07T10:00:00.000Z',
  updatedAt: '2026-10-07T10:00:00.000Z',
  sightings: [{ on: 'mesh', layer: 'tank', geom: { type: 'spoint', p: [1, 2, 3], n: [0, 1, 0] } }],
  source: 'human',
};

function entry(seq: number, over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    op: String(seq).padStart(64, '0'),
    chain: CHAIN,
    seq,
    hlc: `1791374700000.${String(seq).padStart(4, '0')}.${DEV}`,
    at: '2026-10-07T12:05:00.000Z',
    actor: { id: ACTOR, name: 'Dana Saleh' },
    device: DEV,
    kind: 'issue.patch',
    target: { rec: 'issue', id: 'i1' },
    how: 'hand',
    state: 'ok',
    ...over,
  };
}

type Handler = { [C in IpcChannel]?: (req: IpcRequest<C>) => IpcResponse<C> };

/** A fake AuditApi: canned answers per channel, recorded requests, a trigger for events. */
function fakeApi(handlers: Handler) {
  const calls: { channel: string; request: unknown }[] = [];
  const changed = new Set<(e: IpcEvent<'journal:changed'>) => void>();
  const api: AuditApi = {
    call: (channel, request) => {
      calls.push({ channel, request });
      const h = handlers[channel] as
        ((r: typeof request) => IpcResponse<typeof channel>) | undefined;
      if (!h) return Promise.resolve({ ok: false, error: `No ${channel}` });
      return Promise.resolve({ ok: true, value: h(request) });
    },
    onJournalChanged: (l) => {
      changed.add(l);
      return () => changed.delete(l);
    },
    onIssuesSaved: () => () => undefined,
  };
  return {
    api,
    calls,
    emit: (e: IpcEvent<'journal:changed'>) => {
      for (const l of changed) l(e);
    },
  };
}

let mounted: { root: Root; el: HTMLElement } | null = null;

async function mount(node: ReactNode): Promise<HTMLElement> {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted = { root, el };
  await act(async () => {
    root.render(node);
    await Promise.resolve();
  });
  return el;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const byTest = (el: HTMLElement, id: string) => [...el.querySelectorAll(`[data-testid="${id}"]`)];

afterEach(() => {
  if (mounted) {
    const { root, el } = mounted;
    act(() => {
      root.unmount();
    });
    el.remove();
    mounted = null;
  }
  issueSaver.cancel();
  setAnnotateReadOnly(false);
  workspace.getState().closeProject();
});

describe('HistoryPanel', () => {
  it('lists the record history with who, how and before and after values', async () => {
    workspace.getState().openProject({ id: 'hcl', root: 'r', manifest }, [F01]);
    const { api, calls } = fakeApi({
      'journal:history': () => ({
        ok: true,
        cursor: null,
        entries: [
          entry(3, {
            label: 'F01 to reviewed',
            kind: 'issue.status',
            changes: [{ field: 'status', before: 'draft', after: 'reviewed' }],
          }),
          entry(2, {
            how: 'pipeline',
            via: { pipeline: { name: 'inspection.run', jobId: 'j1' } },
            state: 'unsigned',
          }),
          entry(1, {
            label: 'Edit F01',
            actor: { id: ACTOR },
            changes: [{ field: 'severity', before: 2, after: 4 }],
          }),
        ],
      }),
    });
    const el = await mount(
      <HistoryPanel projectId="hcl" target={{ rec: 'issue', id: 'i1' }} api={api} />,
    );
    expect(calls[0]).toEqual({
      channel: 'journal:history',
      request: { projectId: 'hcl', filter: { target: { rec: 'issue', id: 'i1' } }, limit: 500 },
    });
    const rows = byTest(el, 'history-entry');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('F01 to reviewed');
    expect(rows[0]?.textContent).toContain('Dana Saleh');
    expect(rows[0]?.textContent).toContain('By hand');
    expect(rows[0]?.textContent).toContain('draft');
    expect(rows[1]?.textContent).toContain('Inspection pipeline (run by Dana Saleh)');
    expect(rows[1]?.textContent).toContain('Not signed');
    expect(rows[2]?.textContent).toContain('Unknown author');
    // the issue is a draft now, so the status row has nothing to put back; severity has
    expect(byTest(el, 'history-restore')).toHaveLength(1);
    expect(byTest(el, 'history-restore')[0]?.getAttribute('aria-label')).toBe(
      'Restore F01 severity',
    );
  });

  it('restores the before values as a new change', async () => {
    workspace.getState().openProject({ id: 'hcl', root: 'r', manifest }, [F01]);
    const { api } = fakeApi({
      'journal:history': () => ({
        ok: true,
        cursor: null,
        entries: [entry(1, { changes: [{ field: 'severity', before: 2, after: 4 }] })],
      }),
    });
    const el = await mount(
      <HistoryPanel projectId="hcl" target={{ rec: 'issue', id: 'i1' }} api={api} />,
    );
    const undoBefore = issueEditor.state.undoLabel;
    await act(async () => {
      (byTest(el, 'history-restore')[0] as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(workspace.getState().issues[0]?.severity).toBe(2);
    expect(issueEditor.state.undoLabel).toBe('Edit F01');
    expect(issueEditor.state.undoLabel).not.toBe(undoBefore ?? 'none');
    // the value matches now: nothing left to restore on that row
    expect(byTest(el, 'history-restore')).toHaveLength(0);
  });

  it('hides Restore in a read-only package', async () => {
    workspace.getState().openProject({ id: 'hcl', root: 'r', manifest }, [F01]);
    setAnnotateReadOnly(true);
    const { api } = fakeApi({
      'journal:history': () => ({
        ok: true,
        cursor: null,
        entries: [entry(1, { changes: [{ field: 'severity', before: 2, after: 4 }] })],
      }),
    });
    const el = await mount(
      <HistoryPanel projectId="hcl" target={{ rec: 'issue', id: 'i1' }} api={api} />,
    );
    expect(byTest(el, 'history-entry')).toHaveLength(1);
    expect(byTest(el, 'history-restore')).toHaveLength(0);
  });

  it('shows the empty, switched off and failure states', async () => {
    const empty = fakeApi({ 'journal:history': () => ({ ok: true, cursor: null, entries: [] }) });
    let el = await mount(
      <HistoryPanel projectId="hcl" target={{ rec: 'issue', id: 'i1' }} api={empty.api} />,
    );
    expect(el.textContent).toContain('No changes recorded yet.');
    act(() => {
      mounted?.root.unmount();
    });
    mounted = null;

    const off = fakeApi({
      'journal:history': () => ({ ok: true, cursor: null, entries: [], off: true }),
    });
    el = await mount(
      <HistoryPanel projectId="hcl" target={{ rec: 'part', id: 'p1' }} api={off.api} />,
    );
    expect(el.textContent).toContain('History is switched off for this project.');
    act(() => {
      mounted?.root.unmount();
    });
    mounted = null;

    const failing = fakeApi({
      'journal:history': () => ({
        ok: false,
        error: 'The journal is not ready yet.',
        code: 'not-implemented',
      }),
    });
    el = await mount(
      <HistoryPanel projectId="hcl" target={{ rec: 'issue', id: 'i1' }} api={failing.api} />,
    );
    expect(byTest(el, 'history-error')[0]?.textContent).toBe('The journal is not ready yet.');
  });

  it('reloads when journal:changed names its record or every record', async () => {
    const { api, calls, emit } = fakeApi({
      'journal:history': () => ({ ok: true, cursor: null, entries: [] }),
    });
    await mount(<HistoryPanel projectId="hcl" target={{ rec: 'issue', id: 'i1' }} api={api} />);
    expect(calls).toHaveLength(1);
    emit({ projectId: 'hcl', records: [{ rec: 'issue', id: 'i2' }] });
    emit({ projectId: 'other', records: [] });
    await flush();
    expect(calls).toHaveLength(1);
    emit({ projectId: 'hcl', records: [{ rec: 'issue', id: 'i1' }] });
    emit({ projectId: 'hcl', records: [] });
    await flush();
    expect(calls).toHaveLength(3);
  });
});

describe('AuditScreen', () => {
  const report: VerifyReport = {
    ok: true,
    checkedAt: '2026-10-07T12:00:00.000Z',
    head: { root: 'f'.repeat(64), count: 2 },
    chains: [],
    counts: { ops: 2, signed: 2, unsigned: 0, external: 0, quarantined: 0, redacted: 0 },
    problems: [],
  };

  it('lists entries, pages with the cursor and filters by record', async () => {
    workspace.getState().openProject({ id: 'hcl', root: 'r', manifest }, [F01]);
    const { api, calls } = fakeApi({
      'journal:history': (req) =>
        req.cursor
          ? { ok: true, cursor: null, entries: [entry(1)] }
          : { ok: true, cursor: 'c1', entries: [entry(3), entry(2)] },
    });
    const el = await mount(<AuditScreen projectId="hcl" api={api} />);
    expect(byTest(el, 'audit-screen')).toHaveLength(1);
    expect(byTest(el, 'audit-entry')).toHaveLength(2);
    expect(byTest(el, 'audit-entry')[0]?.textContent).toContain('F01');
    await act(async () => {
      (byTest(el, 'audit-load-more')[0] as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(byTest(el, 'audit-entry')).toHaveLength(3);
    expect(calls[1]?.request).toMatchObject({ projectId: 'hcl', cursor: 'c1', limit: 100 });
    // the Who filter offers the actors seen
    const who = byTest(el, 'audit-filter-who')[0] as HTMLSelectElement;
    expect([...who.options].map((o) => o.textContent)).toEqual(['Anyone', 'Dana Saleh']);
    expect(byTest(el, 'audit-filter-record')[0]?.tagName).toBe('INPUT');
    expect(byTest(el, 'audit-filter-how')[0]?.tagName).toBe('SELECT');
  });

  it('verifies: intact and signed, or the problems with file and line', async () => {
    const file = `journal/ops/${CHAIN}/000001.jsonl`;
    let answer: VerifyReport = report;
    const { api } = fakeApi({
      'journal:history': () => ({ ok: true, cursor: null, entries: [] }),
      'journal:verify': () => ({ ok: true, report: answer }),
    });
    const el = await mount(<AuditScreen projectId="hcl" api={api} />);
    await act(async () => {
      (byTest(el, 'audit-verify')[0] as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(byTest(el, 'audit-verify-result')[0]?.textContent).toContain(
      'The history is intact. Every entry is signed.',
    );
    answer = {
      ...report,
      ok: false,
      problems: [{ code: 'hash-mismatch', file, line: 2, message: 'The op id does not match.' }],
    };
    await act(async () => {
      (byTest(el, 'audit-verify')[0] as HTMLButtonElement).click();
      await Promise.resolve();
    });
    const problems = byTest(el, 'audit-problem');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.textContent).toContain(`Line 2 of ${file} was edited.`);
    expect(byTest(el, 'audit-verify-result')[0]?.textContent).toContain('1 problem found.');
  });

  it('exports with the current filter and says where it saved', async () => {
    let path: string | null = 'C:\\Audit\\hcl-audit.csv';
    const { api, calls } = fakeApi({
      'journal:history': () => ({ ok: true, cursor: null, entries: [] }),
      'audit:export': () => ({ ok: true, path, count: 12 }),
    });
    const el = await mount(<AuditScreen projectId="hcl" api={api} />);
    await act(async () => {
      (byTest(el, 'audit-export-csv')[0] as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(calls.at(-1)).toEqual({
      channel: 'audit:export',
      request: { projectId: 'hcl', format: 'audit-csv', filter: {} },
    });
    expect(byTest(el, 'audit-export-result')[0]?.textContent).toBe(
      'Saved 12 entries to C:\\Audit\\hcl-audit.csv',
    );
    path = null;
    await act(async () => {
      (byTest(el, 'audit-export-json')[0] as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(byTest(el, 'audit-export-result')).toHaveLength(0);
  });
});
