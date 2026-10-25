import type { Issue, PackageInfo, ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  actionAllowed,
  createToastStore,
  doneMessage,
  EXPORT_ACTIONS,
  exportUnavailable,
  legendEntries,
  snapshotName,
} from './exportModel';

const manifest = {
  name: 'Demo Yard 710',
  severityModels: [
    {
      id: 'sev',
      name: 'Lining',
      levels: [
        { value: 1, label: 'Low', color: '#5b9bd5', criteria: '' },
        { value: 5, label: 'Severe', color: '#e5484d', criteria: '' },
      ],
      uncertain: { label: 'Uncertain', color: '#b68ef8' },
    },
  ],
} as unknown as ProjectManifest;

const issue = (severity: Issue['severity']) => ({ severityModelId: 'sev', severity }) as Issue;

describe('export actions', () => {
  it('offers every format plus the 3D snapshot', () => {
    expect(EXPORT_ACTIONS.map((a) => a.id)).toEqual([
      'csv',
      'geojson',
      'coco',
      'kit-json',
      'masks-zip',
      'report-pdf',
      'house-pdf',
      'photo-report-pdf',
      'survey-report-pdf',
      'stockpile-csv',
      'measurements-csv',
      'volumetric-pdf',
      'volumetric-html',
      'snapshot',
    ]);
  });

  it('offers the volumetric report as PDF and HTML, under the report-pdf package kind', () => {
    const pdf = EXPORT_ACTIONS.find((a) => a.id === 'volumetric-pdf');
    const html = EXPORT_ACTIONS.find((a) => a.id === 'volumetric-html');
    expect(pdf).toMatchObject({ label: 'Volumetric report (PDF)', hint: 'Customer report' });
    expect(pdf?.title).toBe('Export the volumetric report as PDF');
    expect(html).toMatchObject({ label: 'Volumetric report (HTML)', hint: 'Opens offline' });
    expect(html?.title).toBe('Export the volumetric report as one offline HTML file');
    const pkg = (exports: string[]) => ({ header: { exports } }) as unknown as PackageInfo;
    expect(actionAllowed('volumetric-pdf', pkg(['report-pdf']))).toBe(true);
    expect(actionAllowed('volumetric-html', pkg(['report-pdf']))).toBe(true);
    expect(actionAllowed('volumetric-html', pkg(['issues-csv']))).toBe(false);
    expect(actionAllowed('volumetric-pdf', null)).toBe(true);
  });

  it('builds the legend worst first, with counts, skipping empty levels', () => {
    expect(legendEntries(manifest, [issue(1), issue(5), issue(5), issue('uncertain')])).toEqual([
      { label: 'Severe', color: '#e5484d', count: 2 },
      { label: 'Low', color: '#5b9bd5', count: 1 },
      { label: 'Uncertain', color: '#b68ef8', count: 1 },
    ]);
  });

  it('names snapshots after the project', () => {
    expect(snapshotName('Demo Yard: 710', new Date('2026-10-04T08:09:10Z'))).toBe(
      'Demo-Yard-710-3d-view-20261004-080910.png',
    );
  });

  it('says what was saved', () => {
    expect(doneMessage('csv', { path: 'C:/x/a.csv', count: 701 })).toBe(
      '701 issues saved to C:/x/a.csv',
    );
    expect(doneMessage('masks-zip', { path: 'C:/x/m.zip', count: 12 })).toBe(
      '12 mask files saved to C:/x/m.zip',
    );
    expect(doneMessage('snapshot', { path: 'C:/x/v.png' })).toBe('Saved to C:/x/v.png');
    expect(doneMessage('photo-report-pdf', { path: 'C:/x/a.pdf', count: 3 })).toBe(
      'Saved to C:/x/a.pdf',
    );
  });
});

describe('toast store', () => {
  it('tracks a job from progress to done and dismiss', () => {
    const s = createToastStore();
    s.getState().start('j1', 'Issues CSV');
    s.getState().progress('j1', 'Writing', 3, 4);
    expect(s.getState().toasts[0]).toMatchObject({ state: 'running', phase: 'Writing', done: 3 });
    s.getState().finish('j1', 'done', 'Saved');
    expect(s.getState().toasts[0]).toMatchObject({ state: 'done', message: 'Saved' });
    s.getState().dismiss('j1');
    expect(s.getState().toasts).toEqual([]);
  });

  it('ignores progress for unknown or finished jobs', () => {
    const s = createToastStore();
    s.getState().progress('nope', 'x', 1, 1);
    s.getState().start('j1', 'CSV');
    s.getState().finish('j1', 'error', 'Disk full');
    s.getState().progress('j1', 'late', 1, 2);
    expect(s.getState().toasts[0]).toMatchObject({ state: 'error', phase: '' });
  });
});

describe('exports that need data', () => {
  const empty = { layers: [] } as unknown as ProjectManifest;
  const withLayer = { layers: [{ kind: 'mesh', id: 'm' }] } as unknown as ProjectManifest;

  it('greys the project report of a project with no datasets and no issues, with the reason', () => {
    expect(exportUnavailable('house-pdf', empty, [])).toBe('Add data to the project first.');
    expect(exportUnavailable('house-pdf', withLayer, [])).toBeNull();
    expect(exportUnavailable('house-pdf', empty, [{ id: 'i' }])).toBeNull();
    expect(exportUnavailable('csv', empty, [])).toBeNull();
  });
});
