// @vitest-environment jsdom
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ViewTools } from './StageTools';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

describe('ViewTools', () => {
  it('centres on the project beside Whole site, with its own key', () => {
    root = createRoot(host);
    act(() => root?.render(<ViewTools stage={null} map={false} />));
    const labels = [...host.querySelectorAll('button.tool')].map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels.slice(0, 2)).toEqual(['Whole site', 'Centre on project']);
    const centre = host.querySelector<HTMLButtonElement>('[aria-label="Centre on project"]');
    expect(centre?.getAttribute('aria-keyshortcuts')).toBe('G');
    act(() => centre?.click());
    expect(workspace.getState().camera?.target).toEqual({ kind: 'site' });
  });
});
