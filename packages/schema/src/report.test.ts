import { describe, expect, it } from 'vitest';
import { ipc, Settings } from './ipc';
import {
  addNarrativeVersion,
  currentNarrative,
  emptyNarrative,
  NARRATIVE_MAX_VERSIONS,
  NarrativeFile,
  ReportContentsSettings,
  reportSectionOn,
  type NarrativeVersion,
} from './report';

const v = (text: string, source: NarrativeVersion['source'] = 'user'): NarrativeVersion => ({
  text,
  source,
  createdAt: '2026-10-04T10:00:00Z',
});

describe('narrative file', () => {
  it('keeps every version, newest last, and prints the newest', () => {
    let f = addNarrativeVersion(null, 'summary', v('Draft', 'ai'));
    f = addNarrativeVersion(f, 'summary', v('Edited'));
    expect(f.parts.summary?.versions.map((x) => x.text)).toEqual(['Draft', 'Edited']);
    expect(currentNarrative(f, 'summary')).toBe('Edited');
    expect(currentNarrative(f, 'method')).toBeNull();
    expect(NarrativeFile.safeParse(f).success).toBe(true);
  });

  it('does not add a version for the same text and source', () => {
    const f = addNarrativeVersion(null, 'method', v('Same'));
    expect(addNarrativeVersion(f, 'method', v('Same'))).toBe(f);
    expect(addNarrativeVersion(f, 'method', v('Same', 'ai')).parts.method?.versions).toHaveLength(
      2,
    );
  });

  it('drops the oldest versions beyond the limit and never mutates the input', () => {
    let f = emptyNarrative();
    for (let i = 0; i < NARRATIVE_MAX_VERSIONS + 5; i++)
      f = addNarrativeVersion(f, 'findings', v(`T${String(i)}`));
    const versions = f.parts.findings?.versions ?? [];
    expect(versions).toHaveLength(NARRATIVE_MAX_VERSIONS);
    expect(versions[0]?.text).toBe('T5');
    const before = JSON.stringify(f);
    addNarrativeVersion(f, 'findings', v('new'));
    expect(JSON.stringify(f)).toBe(before);
  });

  it('rejects unknown parts, sources and schema versions', () => {
    const ok = { schema: 'aio.narrative/1', parts: { summary: { versions: [v('x')] } } };
    expect(NarrativeFile.safeParse(ok).success).toBe(true);
    expect(NarrativeFile.safeParse({ ...ok, schema: 'aio.narrative/2' }).success).toBe(false);
    expect(NarrativeFile.safeParse({ ...ok, parts: { intro: { versions: [] } } }).success).toBe(
      false,
    );
    expect(
      NarrativeFile.safeParse({ ...ok, parts: { summary: { versions: [v('x', 'bot' as 'ai')] } } })
        .success,
    ).toBe(false);
  });
});

describe('report contents', () => {
  it('includes every section unless switched off', () => {
    expect(reportSectionOn(undefined, 'register')).toBe(true);
    const c = ReportContentsSettings.parse({ sections: { register: false }, issuePages: 'none' });
    expect(reportSectionOn(c, 'register')).toBe(false);
    expect(reportSectionOn(c, 'site')).toBe(true);
    expect(ReportContentsSettings.safeParse({ sections: { cover: false } }).success).toBe(false);
  });

  it('is an optional part of the settings', () => {
    const base = {
      cloudAi: false,
      theme: 'dark',
      sidebarCollapsed: false,
      dataRoot: 'E:/Data',
      routes: [],
    };
    expect(Settings.safeParse(base).success).toBe(true);
    expect(
      Settings.safeParse({ ...base, reportContents: { issuePages: 'above-lowest' } }).success,
    ).toBe(true);
  });
});

describe('report channels', () => {
  it('reads and writes the narrative of an open project', () => {
    const file = { schema: 'aio.narrative/1', parts: {} };
    expect(ipc['report:readNarrative'].request.safeParse({ projectId: 'hcl' }).success).toBe(true);
    const res = ipc['report:readNarrative'].response;
    expect(res.safeParse({ ok: true, file: null, readOnly: false }).success).toBe(true);
    expect(res.safeParse({ ok: true, file, readOnly: true }).success).toBe(true);
    expect(ipc['report:writeNarrative'].request.safeParse({ projectId: 'hcl', file }).success).toBe(
      true,
    );
    expect(
      ipc['report:writeNarrative'].request.safeParse({ projectId: 'hcl', file: {} }).success,
    ).toBe(false);
  });

  it('drafts text on a task route and checks the route of a task', () => {
    const req = ipc['ai:draftText'].request;
    const ok = { runId: 'r1', projectId: 'hcl', task: 'report', system: 'S', prompt: 'P' };
    expect(req.safeParse(ok).success).toBe(true);
    expect(req.safeParse({ ...ok, task: 'poem' }).success).toBe(false);
    expect(req.safeParse({ ...ok, prompt: '' }).success).toBe(false);
    expect(ipc['ai:status'].request.safeParse({ task: 'report' }).success).toBe(true);
    expect(ipc['ai:status'].request.safeParse({}).success).toBe(true);
  });
});
