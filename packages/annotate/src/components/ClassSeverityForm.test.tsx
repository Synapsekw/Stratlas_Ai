// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogue, strictModel, tankModel } from '../testing';
import { ClassSeverityForm } from './ClassSeverityForm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [tankModel, strictModel],
  classCatalogues: [catalogue],
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  workspace.getState().openProject({ id: 'p', root: 'r', manifest }, []);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  workspace.getState().closeProject();
});

type Props = ComponentProps<typeof ClassSeverityForm>;
const render = (over: Partial<Props> = {}) => {
  const props: Props = {
    initialClassId: null,
    initialSeverity: null,
    confirmLabel: 'Accept',
    onConfirm: vi.fn(() => null),
    onCancel: vi.fn(),
    ...over,
  };
  act(() => {
    root.render(<ClassSeverityForm {...props} />);
  });
  return props;
};
const button = (text: string) => {
  const b = [...host.querySelectorAll('button')].find((x) => x.textContent.includes(text));
  if (!b) throw new Error(`no button ${text}`);
  return b;
};
const click = (b: HTMLElement) => {
  act(() => {
    b.click();
  });
};
const pressed = (group: string) =>
  [...host.querySelectorAll(`[aria-label="${group}"] [aria-pressed="true"]`)].map(
    (b) => b.textContent,
  );
const key = (k: string) => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
};

describe('ClassSeverityForm', () => {
  it('starts on the given class and severity and confirms them', () => {
    const p = render({ initialClassId: 'blister', initialSeverity: 4 });
    expect(pressed('Class')).toHaveLength(1);
    expect(pressed('Class')[0]).toContain('Coating blister');
    expect(pressed('Severity')[0]).toContain('High');
    click(button('Accept'));
    expect(p.onConfirm).toHaveBeenCalledWith('blister', 4);
  });

  it('clears a severity the newly picked class model does not have', () => {
    const p = render({ initialClassId: 'crack', initialSeverity: 5 });
    click(button('Pothole'));
    expect(pressed('Severity')).toEqual([]);
    click(button('Accept'));
    expect(p.onConfirm).not.toHaveBeenCalled();
    expect(host.querySelector('.ann-error')?.textContent).toBe('Pick a class and a severity');
    // a grade the new scale has is kept
    click(button('High'));
    click(button('Crack'));
    expect(pressed('Severity')[0]).toContain('Medium');
  });

  it('shows the error onConfirm returns', () => {
    render({
      initialClassId: 'crack',
      initialSeverity: 2,
      onConfirm: () => 'This issue is locked',
    });
    click(button('Accept'));
    expect(host.querySelector('.ann-error')?.textContent).toBe('This issue is locked');
    // and clears it on the next pick
    click(button('Observation'));
    expect(host.querySelector('.ann-error')).toBeNull();
  });

  it('picks with the keyboard: a class hotkey, a digit, Enter; Esc cancels', () => {
    const p = render();
    key('p');
    key('3');
    key('Enter');
    expect(p.onConfirm).toHaveBeenCalledWith('pothole', 3);
    key('Escape');
    expect(p.onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows the footer in the button row and the confirm label', () => {
    render({ footer: <button type="button">Same as F02</button>, confirmLabel: 'Change' });
    const foot = host.querySelector('.ann-pop-foot');
    expect([...(foot?.querySelectorAll('button') ?? [])].map((b) => b.textContent)).toEqual([
      'Cancel',
      'Same as F02',
      'Change',
    ]);
  });

  it('puts rows between the lists and the button row', () => {
    render({ rows: <p className="extra-row">Same as an existing finding</p> });
    expect([...host.children].map((c) => c.className)).toEqual([
      'ann-pop-body',
      'ann-pop-rows',
      'ann-pop-foot',
    ]);
    expect(host.querySelector('.ann-pop-rows .extra-row')).not.toBeNull();
  });

  it('keeps the Lightbox markup when there are no rows', () => {
    render();
    expect([...host.children].map((c) => c.className)).toEqual(['ann-pop-body', 'ann-pop-foot']);
    expect(host.querySelector('.ann-pop-rows')).toBeNull();
  });
});
