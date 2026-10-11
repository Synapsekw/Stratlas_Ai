// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { starterFor } from './model';
import { ProjectKindTag, ProjectStarter } from './ProjectStarter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const manifest = (extra: Partial<ProjectManifest>): ProjectManifest => ({
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [],
  classCatalogues: [],
  ...extra,
});

let host: HTMLDivElement;
let root: Root | undefined;

function show(m: ProjectManifest) {
  act(() => {
    root = createRoot(host);
    root.render(
      <>
        <ProjectKindTag manifest={m} />
        <ProjectStarter manifest={m} />
      </>,
    );
  });
}

const tag = () => host.querySelector('[data-testid="project-kind"]')?.textContent ?? null;
const lines = () =>
  [...host.querySelectorAll('[data-testid="project-starter"] li')].map((li) => li.textContent);

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

describe('the type and starter list of an empty project', () => {
  it('show the purpose the wizard wrote and what to add first for it', () => {
    show(manifest({ type: 'inspection', purpose: 'confined-space' }));
    expect(tag()).toBe('Confined space inspection');
    expect(lines()).toEqual([...starterFor('confined-space')]);
    expect(host.querySelector('[data-testid="project-starter"]')?.textContent).toContain(
      'Add first',
    );
  });

  it('show what the older type says for a project without a purpose', () => {
    show(manifest({ type: 'twin' }));
    expect(tag()).toBe('Digital twin');
    expect(lines()).toEqual([...starterFor('data-fusion')]);
  });

  it('fall back to the type when a later build wrote a purpose this one does not know', () => {
    show(manifest({ type: 'volumetric', purpose: 'tunnel' }));
    expect(tag()).toBe('Survey');
    expect(lines()).toEqual([...starterFor('survey')]);
  });

  it('are left out for a project with neither', () => {
    show(manifest({}));
    expect(tag()).toBeNull();
    expect(host.querySelector('[data-testid="project-starter"]')).toBeNull();
  });
});
