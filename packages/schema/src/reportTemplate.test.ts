import { describe, expect, it } from 'vitest';
import { ReportTemplateFile, TemplateEntry, emptyReportTemplate } from './index';

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

  it('a measurement entry needs at least one part', () => {
    const e = { kind: 'measurement', id: 'm-1', parts: [], addedAt: '2026-10-20T08:00:00Z' };
    expect(TemplateEntry.safeParse(e).success).toBe(false);
  });

  it('an unknown entry kind is refused', () => {
    expect(TemplateEntry.safeParse({ kind: 'banner', text: 'x' }).success).toBe(false);
  });
});
