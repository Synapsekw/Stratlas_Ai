// @vitest-environment jsdom
import type { IssueClass, ProjectManifest, SeverityModel } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { annotateUi, beginSighting, cancelSighting } from '../runtime';
import { catalogue, photoSighting, strictModel, tankModel } from '../testing';
import { SightingPicker } from './SightingPicker';
import { registerClassCreator, registerSeverityCreator } from './NewClassRow';

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

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(node: ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(node);
  });
  return host;
}

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
  cancelSighting();
  annotateUi.setState({ pending: null, lastClassId: null, lastSeverity: null });
  workspace.getState().closeProject();
});

describe('SightingPicker', () => {
  it('shows the classes and the selected scale by name, and filters the list', () => {
    workspace.getState().openProject({ id: 'p', root: 'r', manifest }, []);
    const el = render(<SightingPicker kinds={['image']} />);
    act(() => {
      beginSighting(photoSighting, { x: 40, y: 40 });
    });
    const pop = el.querySelector('[aria-label="New issue"]');
    expect(pop?.textContent).toContain('Crack');
    expect(pop?.textContent).toContain('Coating blister');
    expect(pop?.textContent).toContain('Observation');
    expect(pop?.textContent).toContain('Critical');
    const search = el.querySelector('[aria-label="Find a class"]');
    if (!(search instanceof HTMLInputElement)) throw new Error('no search');
    act(() => {
      type(search, 'pot');
    });
    const list = el.querySelector('[aria-label="Class"]');
    expect(list?.textContent).toContain('Pothole');
    expect(list?.textContent).not.toContain('Crack');
    act(() => {
      list?.querySelector('button')?.click();
    });
    const grades = el.querySelector('[aria-label="Severity"]');
    expect(grades?.textContent).toContain('Medium');
    expect(grades?.textContent).not.toContain('Critical');
  });

  it('creates a class on a generated 1 to 5 scale', async () => {
    workspace.getState().openProject({ id: 'p', root: 'r', manifest }, []);
    const created: IssueClass = {
      id: 'spalling',
      label: 'Spalling',
      color: '#7cc46b',
      severityModel: 'coating-1-to-5',
    };
    let finishScale: () => void = () => undefined;
    const onClass = vi.fn(() => Promise.resolve(created));
    const onScale = vi.fn(
      (model: SeverityModel) =>
        new Promise<SeverityModel>((resolve) => {
          finishScale = () => {
            resolve(model);
          };
        }),
    );
    const offClass = registerClassCreator(onClass);
    const offScale = registerSeverityCreator(onScale);
    try {
      const el = render(<SightingPicker kinds={['image']} />);
      act(() => {
        beginSighting(photoSighting, { x: 40, y: 40 });
      });
      const add = el.querySelector<HTMLButtonElement>('[data-testid="picker-new-class"]');
      act(() => {
        add?.click();
      });
      const radios = [...el.querySelectorAll('[role="radio"]')];
      const fresh = radios[radios.length - 1];
      if (!(fresh instanceof HTMLButtonElement)) throw new Error('no new scale');
      act(() => {
        fresh.click();
      });
      const five = [...el.querySelectorAll('button')].find((b) => b.textContent === '1 to 5');
      act(() => {
        five?.click();
      });
      expect(el.querySelector('[aria-label="Grade 5 name"]')).not.toBeNull();
      const name = el.querySelector('[aria-label="New class name"]');
      const scale = el.querySelector('[aria-label="Severity scale name"]');
      if (!(name instanceof HTMLInputElement) || !(scale instanceof HTMLInputElement)) {
        throw new Error('form fields missing');
      }
      act(() => {
        type(name, 'Spalling');
        type(scale, 'Coating 1 to 5');
      });
      const save = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Create class');
      act(() => {
        save?.click();
      });
      await act(async () => {
        finishScale();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onScale).toHaveBeenCalledTimes(1);
      const model = onScale.mock.calls[0]?.[0];
      expect(model?.name).toBe('Coating 1 to 5');
      expect(model?.levels).toHaveLength(5);
      expect(model?.uncertain?.label).toBe('Uncertain');
      expect(onClass).toHaveBeenCalledWith('Spalling', {
        color: expect.any(String) as string,
        severityModel: model?.id,
      });
    } finally {
      act(() => {
        offClass();
        offScale();
      });
    }
  });
});
