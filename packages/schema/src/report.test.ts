import { describe, expect, it } from 'vitest';
import { EXPORT_FORMAT_KIND, EXPORT_FORMATS, ipc, Settings } from './ipc';
import {
  addNarrativeVersion,
  currentNarrative,
  currentVersion,
  emptyNarrative,
  NARRATIVE_MAX_VERSIONS,
  NarrativeFile,
  REPORT_TEXT_SCHEMA,
  REPORT_VIEWS_SCHEMA,
  ReportContentsSettings,
  ReportPageId,
  reportSectionOn,
  ReportTextFile,
  reportTextPath,
  ReportTypeId,
  reportViewsDir,
  ReportViewsFrame,
  VolumetricTextId,
  withVersion,
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

describe('part-level version helpers', () => {
  it('reads the newest version of a part and adds one, newest last', () => {
    expect(currentVersion(undefined)).toBeNull();
    const p = withVersion(undefined, v('One', 'template'));
    expect(currentVersion(p)?.text).toBe('One');
    const q = withVersion(p, v('Two'));
    expect(q.versions.map((x) => x.source)).toEqual(['template', 'user']);
    expect(withVersion(q, v('Two'))).toBe(q);
    expect(p.versions).toHaveLength(1);
  });
});

describe('report text file', () => {
  const file = {
    schema: REPORT_TEXT_SCHEMA,
    report: 'volumetric',
    parts: { title: { versions: [v('Stockpile volume report', 'template')] } },
    pileNotes: { 'm-1': { versions: [v('Reshaped on the north side.')] } },
    pages: { cover: true, change: false },
    compareWith: 'c1',
  };

  it('round-trips and keeps an unknown key', () => {
    const parsed = ReportTextFile.parse({ ...file, later: { x: 1 } });
    expect(JSON.parse(JSON.stringify(parsed))).toEqual({ ...file, later: { x: 1 } });
    expect(ReportTextFile.safeParse({ ...file, report: 'facade' }).success).toBe(true);
  });

  it('refuses a bad part id, page id, pile id or schema version', () => {
    const part = { versions: [v('x')] };
    expect(ReportTextFile.safeParse({ ...file, parts: { 'Bad id': part } }).success).toBe(false);
    expect(ReportTextFile.safeParse({ ...file, parts: { '1st': part } }).success).toBe(false);
    expect(ReportTextFile.safeParse({ ...file, pages: { appendix: true } }).success).toBe(false);
    expect(ReportTextFile.safeParse({ ...file, pileNotes: { 'a b': part } }).success).toBe(false);
    expect(ReportTextFile.safeParse({ ...file, schema: 'aio.report-text/2' }).success).toBe(false);
    expect(ReportTextFile.safeParse({ ...file, report: '' }).success).toBe(false);
  });

  it('names the ids and the paths of a report', () => {
    expect(ReportTypeId.options).toEqual(['volumetric']);
    expect(VolumetricTextId.options).toEqual([
      'title',
      'preparedFor',
      'preparedBy',
      'summary',
      'intro',
      'method',
      'closing',
    ]);
    expect(ReportPageId.options).toEqual(['cover', 'piles', 'change']);
    expect(reportTextPath('volumetric')).toBe('report/volumetric.json');
    expect(reportViewsDir('volumetric')).toBe('report/views/volumetric');
  });
});

describe('report views frame', () => {
  const view = { name: 'photo-c1', kind: 'photo', capture: 'c1', file: 'photo-c1.jpg' };
  const frame = {
    schema: REPORT_VIEWS_SCHEMA,
    extent: [500000, 2900000, 500400, 2900300],
    widthPx: 2000,
    heightPx: 1500,
    mPerPx: 0.2,
    views: [
      view,
      { name: 'cutfill-c1-c2', kind: 'cutfill', capture: 'c2', pair: 'c1', file: 'cf-c1-c2.jpg' },
      { name: '3d-c2', kind: '3d', capture: 'c2', file: '3d-c2.jpg' },
    ],
    markers3d: { c2: { 'm-1': [812.5, 400] } },
    fingerprint: 'sha256:abc',
  };

  it('parses a frame and keeps an unknown key', () => {
    const parsed = ReportViewsFrame.parse({ ...frame, later: true });
    expect(parsed.views).toHaveLength(3);
    expect(parsed.markers3d.c2?.['m-1']).toEqual([812.5, 400]);
    expect((parsed as Record<string, unknown>).later).toBe(true);
  });

  it('refuses a bad view kind, file name, extent or size', () => {
    const bad = (patch: Record<string, unknown>) =>
      ReportViewsFrame.safeParse({ ...frame, ...patch }).success;
    expect(bad({ views: [{ ...view, kind: 'sketch' }] })).toBe(false);
    expect(bad({ views: [{ ...view, file: '../x.jpg' }] })).toBe(false);
    expect(bad({ views: [{ ...view, file: 'photo.png' }] })).toBe(false);
    expect(bad({ extent: [500400, 2900000, 500000, 2900300] })).toBe(false);
    expect(bad({ widthPx: 0 })).toBe(false);
    expect(bad({ mPerPx: -1 })).toBe(false);
    expect(bad({ schema: 'aio.report-views/2' })).toBe(false);
  });
});

describe('volumetric report channels', () => {
  const file = { schema: REPORT_TEXT_SCHEMA, report: 'volumetric', parts: {} };

  it('reads and writes the report text file', () => {
    const read = ipc['report:readText'];
    expect(read.request.safeParse({ projectId: 'p', report: 'volumetric' }).success).toBe(true);
    expect(read.request.safeParse({ projectId: 'p', report: 'house' }).success).toBe(false);
    expect(read.response.safeParse({ ok: true, file: null, readOnly: false }).success).toBe(true);
    expect(read.response.safeParse({ ok: true, file, readOnly: true }).success).toBe(true);
    expect(read.response.safeParse({ ok: false, error: 'x' }).success).toBe(true);
    const write = ipc['report:writeText'];
    expect(write.request.safeParse({ projectId: 'p', report: 'volumetric', file }).success).toBe(
      true,
    );
    expect(
      write.request.safeParse({ projectId: 'p', report: 'volumetric', file: {} }).success,
    ).toBe(false);
    expect(write.response.safeParse({ ok: true }).success).toBe(true);
  });

  it('saves the pictures with their frame', () => {
    const req = ipc['report:saveViews'].request;
    const frame = {
      schema: REPORT_VIEWS_SCHEMA,
      extent: [0, 0, 10, 10],
      widthPx: 100,
      heightPx: 100,
      mPerPx: 0.1,
      views: [],
      markers3d: {},
      fingerprint: 'f',
    };
    const jpg = { name: 'photo-c1.jpg', data: new Uint8Array([0xff, 0xd8]) };
    const ok = { projectId: 'p', report: 'volumetric', frame, files: [jpg] };
    expect(req.safeParse(ok).success).toBe(true);
    expect(req.safeParse({ ...ok, files: [{ ...jpg, name: 'Photo.JPG' }] }).success).toBe(false);
    expect(req.safeParse({ ...ok, files: [{ ...jpg, name: '../a.jpg' }] }).success).toBe(false);
    expect(req.safeParse({ ...ok, files: Array<typeof jpg>(65).fill(jpg) }).success).toBe(false);
    expect(ipc['report:saveViews'].response.safeParse({ ok: true }).success).toBe(true);
  });

  it('asks main for the volumetric model', () => {
    const ch = ipc['report:volumetricModel'];
    expect(ch.request.safeParse({ projectId: 'p' }).success).toBe(true);
    expect(ch.request.safeParse({ projectId: 'p', compareWith: 'c1' }).success).toBe(true);
    expect(ch.request.safeParse({ projectId: 'p', extra: 1 }).success).toBe(false);
    expect(ch.response.safeParse({ ok: true, model: { piles: [] } }).success).toBe(true);
    expect(ch.response.safeParse({ ok: false, error: 'x' }).success).toBe(true);
  });

  it('files both volumetric exports under the report-pdf kind', () => {
    expect(EXPORT_FORMATS).toContain('volumetric-pdf');
    expect(EXPORT_FORMATS).toContain('volumetric-html');
    expect(EXPORT_FORMAT_KIND['volumetric-pdf']).toBe('report-pdf');
    expect(EXPORT_FORMAT_KIND['volumetric-html']).toBe('report-pdf');
  });
});
