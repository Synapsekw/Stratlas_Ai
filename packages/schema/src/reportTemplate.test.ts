import { describe, expect, it } from 'vitest';
import {
  ReportTemplateFile,
  TemplateEntry,
  emptyReportTemplate,
  ipc,
  isMeasurementEntry,
  isSectionEntry,
  knownParts,
} from './index';

describe('report template', () => {
  it('emptyReportTemplate parses', () => {
    expect(ReportTemplateFile.parse(emptyReportTemplate())).toEqual(emptyReportTemplate());
  });

  it('parses both entry kinds, including the volume-over-time section', () => {
    const file = {
      ...emptyReportTemplate(),
      entries: [
        {
          kind: 'measurement',
          id: 'm-1',
          parts: ['value', 'chart'],
          addedAt: '2026-10-20T08:00:00Z',
        },
        { kind: 'section', section: 'volume-over-time' },
      ],
    };
    expect(ReportTemplateFile.parse(file).entries).toHaveLength(2);
  });

  it('declares the two report template channels, with strict requests', () => {
    const tpl = emptyReportTemplate();
    expect(Object.keys(ipc)).toContain('report:readTemplate');
    expect(Object.keys(ipc)).toContain('report:writeTemplate');
    const read = ipc['report:readTemplate'];
    const write = ipc['report:writeTemplate'];
    expect(read.request.safeParse({ projectId: 'p1' }).success).toBe(true);
    expect(read.request.safeParse({ projectId: 'p1', extra: 1 }).success).toBe(false);
    expect(read.response.safeParse({ ok: true, file: null }).success).toBe(true);
    expect(read.response.safeParse({ ok: true, file: tpl }).success).toBe(true);
    expect(read.response.safeParse({ ok: false, error: 'x' }).success).toBe(true);
    expect(write.request.safeParse({ projectId: 'p1', file: tpl }).success).toBe(true);
    expect(write.request.safeParse({ projectId: 'p1', file: tpl, extra: 1 }).success).toBe(false);
    expect(write.response.safeParse({ ok: true }).success).toBe(true);
  });

  it('a measurement entry needs at least one part', () => {
    const e = { kind: 'measurement', id: 'm-1', parts: [], addedAt: '2026-10-20T08:00:00Z' };
    expect(TemplateEntry.safeParse(e).success).toBe(false);
  });

  it("a later build's additions are kept, not refused: entry kinds, parts and sections", () => {
    const file = {
      ...emptyReportTemplate(),
      layout: { columns: 2 },
      entries: [
        { kind: 'banner', text: 'Site A', colour: 'red' },
        {
          kind: 'measurement',
          id: 'm-1',
          parts: ['value', 'photo'],
          addedAt: '2026-10-20T08:00:00Z',
          note: 'x',
        },
        { kind: 'section', section: 'drone-photos' },
      ],
    };
    const read = ReportTemplateFile.parse(file);
    // written back as it was read: nothing a later build saved is lost
    expect(read).toEqual(file);
    const [banner, m, section] = read.entries;
    expect(banner && isMeasurementEntry(banner)).toBe(false);
    expect(banner && isSectionEntry(banner)).toBe(false);
    expect(m && isMeasurementEntry(m) ? knownParts(m) : null).toEqual(['value']);
    expect(section && isSectionEntry(section) ? section.section : null).toBe('drone-photos');
  });

  it('a known entry kind still has to be well formed', () => {
    expect(TemplateEntry.safeParse({ kind: 'measurement', parts: ['value'] }).success).toBe(false);
    expect(TemplateEntry.safeParse({ kind: 'section' }).success).toBe(false);
    expect(TemplateEntry.safeParse({ text: 'no kind' }).success).toBe(false);
  });
});
