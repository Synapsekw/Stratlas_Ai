// @vitest-environment jsdom
import { emptyReportTemplate, type ProjectManifest, type ReportTemplateFile } from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const disk = vi.hoisted(() => ({ file: null as ReportTemplateFile | null, writes: 0 }));
vi.mock('../shell', () => ({
  bridge: {
    call: (channel: string, req: { file?: ReportTemplateFile }) => {
      if (channel === 'report:readTemplate')
        return Promise.resolve({ ok: true, value: { ok: true, file: disk.file } });
      if (channel === 'report:writeTemplate') {
        disk.writes++;
        disk.file = structuredClone(req.file ?? null);
        return Promise.resolve({ ok: true, value: { ok: true } });
      }
      return Promise.resolve({ ok: false, error: 'Not configured' });
    },
  },
}));

const { TemplateNote } = await import('./TemplateNote');
const { loadTemplate } = await import('./templateStore');

const manifest = { captures: [], layers: [] } as unknown as ProjectManifest;
const at = '2026-10-20T10:00:00.000Z';
let root: Root | undefined;
let host: HTMLElement;

beforeEach(() => {
  disk.writes = 0;
  disk.file = {
    ...emptyReportTemplate(),
    entries: [
      { kind: 'measurement', id: 'a', parts: ['value'], addedAt: at },
      { kind: 'measurement', id: 'b', parts: ['value'], addedAt: at },
    ],
  };
  workspace.getState().openProject({ id: 'p1', root: '/p1', manifest });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = '';
  workspace.getState().closeProject();
});

async function show(readOnly: boolean) {
  await loadTemplate();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<TemplateNote readOnly={readOnly} />);
    await Promise.resolve();
  });
}
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('the report template on the Reports screen', () => {
  it('says how many measurements print, and clears the template after asking', async () => {
    await show(false);
    expect(q('report-template-note')?.textContent).toContain(
      t('report.template.count', { count: 2 }),
    );
    act(() => {
      q('report-template-clear')?.click();
    });
    expect(q('report-template-clear-confirm')?.getAttribute('role')).toBe('alertdialog');
    expect(disk.writes).toBe(0);
    await act(async () => {
      q('report-template-clear-confirm-yes')?.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(disk.file?.entries).toEqual([]);
    // nothing chosen any more: the note goes
    expect(q('report-template-note')).toBeNull();
  });

  it('a package shows the note without the clear button', async () => {
    await show(true);
    expect(q('report-template-note')).not.toBeNull();
    expect(q('report-template-clear')).toBeNull();
  });

  it('no template: nothing shown', async () => {
    disk.file = null;
    await show(false);
    expect(q('report-template-note')).toBeNull();
  });
});
