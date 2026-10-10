/**
 * The user guide screenshots (docs/guide/images), one list: each shot names its file, the
 * chapter that shows it, the project it opens and how to bring the app there. guide-shots.spec.ts
 * takes them off-screen with the bundled demo projects in the library (synthetic data made by
 * tools/demo/build-demo.mjs, checked for client data), so they are safe to run and to publish.
 *
 * `SHOT_PROJECT` is the project every shot opens: the demo tank farm.
 */
import type { Page } from '@playwright/test';
import { join } from 'node:path';

/** The demo build (`pnpm demo:build`, `--quick` is enough), or QUADRION_E2E_DEMO. */
export const DEMO_DIR = process.env.QUADRION_E2E_DEMO ?? join(import.meta.dirname, '..', 'demo');

/** The project the shots open. */
export const SHOT_PROJECT = { id: 'demo-tank-farm', name: 'Demo tank farm' };

export interface GuideShot {
  /** File name in docs/guide/images, without `.png`. */
  id: string;
  /** Chapter slug that shows it (docs/guide/NN-<slug>.md). */
  chapter: string;
  /** The project opened before the shot, or null to stay on the library (demo projects only). */
  project: { id: string; name: string } | null;
  /** Bring the app from a freshly opened project (or the library) to what the shot shows. */
  setup: (win: Page) => Promise<void>;
}

async function palette(win: Page, query: string): Promise<void> {
  await win.keyboard.press('Control+K');
  const box = win.getByRole('dialog', { name: 'Command search' }).getByRole('combobox');
  await box.fill(query);
  await win.keyboard.press('Enter');
}

const settingsPage = (name: string) => async (win: Page) => {
  await palette(win, 'Go to Settings');
  await win
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name })
    .click();
  await win.getByRole('heading', { level: 1, name }).waitFor();
};

const screen = (name: string, heading: RegExp) => async (win: Page) => {
  await palette(win, `Go to ${name}`);
  await win.locator('.crumbs b').filter({ hasText: name }).waitFor();
  await win.getByRole('heading', { name: heading }).first().waitFor();
};

export const GUIDE_SHOTS: GuideShot[] = [
  {
    id: 'first-start',
    chapter: 'install',
    project: null,
    setup: async (win) => {
      await win.getByTestId('first-start').getByText('Open the demo project').waitFor();
    },
  },
  {
    id: 'help',
    chapter: 'install',
    project: SHOT_PROJECT,
    setup: async (win) => {
      await win.keyboard.press('F1');
      await win.getByRole('searchbox', { name: 'Search the guide' }).fill('compare dates');
      await win.getByRole('dialog', { name: 'User guide' }).locator('.help-hit').first().click();
      await win.getByRole('heading', { level: 2, name: 'Compare two dates' }).waitFor();
    },
  },
  {
    id: 'projects-library',
    chapter: 'projects',
    project: SHOT_PROJECT,
    setup: async (win) => {
      await palette(win, 'Go to Projects');
      await win.getByTestId('project-card').first().waitFor();
    },
  },
  {
    id: 'palette',
    chapter: 'projects',
    project: SHOT_PROJECT,
    setup: async (win) => {
      await win.keyboard.press('Control+K');
      await win.getByRole('dialog', { name: 'Command search' }).getByRole('combobox').fill('show');
    },
  },
  {
    id: 'scene-3d',
    chapter: 'scene',
    project: SHOT_PROJECT,
    setup: async (win) => {
      await win.locator('.crumbs b').filter({ hasText: 'Scene' }).waitFor();
      await win.keyboard.press('h');
    },
  },
  {
    id: 'issue-card',
    chapter: 'annotation-and-issues',
    project: SHOT_PROJECT,
    setup: async (win) => {
      await win.locator('.crumbs b').filter({ hasText: 'Scene' }).waitFor();
      await palette(win, 'F01');
      await win.getByText('F01').first().waitFor();
    },
  },
  {
    id: 'issues',
    chapter: 'annotation-and-issues',
    project: SHOT_PROJECT,
    setup: screen('Issues', /Issue register/),
  },
  {
    id: 'new-project',
    chapter: 'building-projects',
    project: null,
    setup: async (win) => {
      await win.getByTestId('new-project').first().click();
      await win.getByRole('heading', { name: 'What is the project?' }).waitFor();
    },
  },
  {
    id: 'reports',
    chapter: 'reports-and-exports',
    project: SHOT_PROJECT,
    setup: screen('Reports', /Project report/),
  },
  {
    id: 'package-export',
    chapter: 'packages',
    project: SHOT_PROJECT,
    setup: async (win) => {
      await palette(win, 'Export project package');
      await win.getByRole('dialog').getByText('Customer policy').waitFor();
    },
  },
  {
    id: 'settings-maps',
    chapter: 'maps',
    project: SHOT_PROJECT,
    setup: settingsPage('Offline maps'),
  },
  {
    id: 'settings-ai',
    chapter: 'ai-agent',
    project: SHOT_PROJECT,
    setup: settingsPage('AI providers'),
  },
  {
    id: 'settings-data',
    chapter: 'settings',
    project: SHOT_PROJECT,
    setup: settingsPage('Data folder'),
  },
  {
    id: 'settings-tools',
    chapter: 'settings',
    project: SHOT_PROJECT,
    setup: settingsPage('Processing tools'),
  },
  {
    id: 'settings-graphics',
    chapter: 'settings',
    project: SHOT_PROJECT,
    setup: settingsPage('Graphics quality'),
  },
];
