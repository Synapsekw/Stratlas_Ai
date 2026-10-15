// @vitest-environment jsdom
import type { LibraryEntry } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shell } from '../shell';
import { CoverDialog } from './CoverDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const yard: LibraryEntry = {
  id: 'north-yard',
  name: 'North yard',
  path: 'D:\\Survey Data\\projects\\north-yard',
  kind: 'native',
  purpose: 'survey',
  customCover: true,
};

const original = shell.getState();
const setThumbnail =
  vi.fn<(id: string, data: Uint8Array<ArrayBuffer> | null) => Promise<string | null>>();
const onClose = vi.fn();
let host: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  setThumbnail.mockReset();
  setThumbnail.mockResolvedValue(null);
  onClose.mockClear();
  shell.setState({ setThumbnail });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  shell.setState(original, true);
  vi.restoreAllMocks();
});

const render = (entry: LibraryEntry = yard) => {
  root = createRoot(host);
  act(() =>
    root?.render(
      <CoverDialog entry={entry} current={false} onClose={onClose} returnTo={() => null} />,
    ),
  );
};
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const settle = async (el: HTMLElement | null) => {
  await act(async () => {
    el?.click();
    await new Promise((r) => setTimeout(r, 0));
  });
};

describe('CoverDialog', () => {
  it('is a labelled dialog that offers the project picture back only for a custom cover', () => {
    render({ ...yard, customCover: undefined });
    const dlg = q('cover-dialog');
    expect(dlg?.getAttribute('role')).toBe('dialog');
    expect(document.getElementById(dlg?.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
      'Change thumbnail',
    );
    expect(q('cover-reset')).toBeNull();
    expect((q('cover-current-view') as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves the project picture back as null and closes', async () => {
    render();
    act(() => q('cover-reset')?.click());
    await settle(q('cover-save'));
    expect(setThumbnail).toHaveBeenCalledWith('north-yard', null);
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps an error in the dialog', async () => {
    setThumbnail.mockResolvedValue('The disk is full.');
    render();
    act(() => q('cover-reset')?.click());
    await settle(q('cover-save'));
    expect(onClose).not.toHaveBeenCalled();
    const alert = q('cover-dialog')?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('The thumbnail was not changed.');
    expect(alert?.textContent).toContain('The disk is full.');
    expect((q('cover-save') as HTMLButtonElement).disabled).toBe(false);
  });
});
