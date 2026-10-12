/**
 * The agent's photo tools end to end (M10 integration follow-up), with the scripted test model
 * (`#tool` lines) on the stand-in pipelines: process_photos asks for approval, starts a run on
 * the project's photos layer, the maps come back as layers by themselves, then accuracy_summary
 * reads that run (GNSS only, no ground control). A rejected approval starts nothing. Synthetic
 * photos only; zero network.
 */
import type { Page } from '@playwright/test';
import { expect, hasPipelinePython, test as plain, VENV_PYTHON } from './fixtures';
import {
  openPhotoSite,
  PHOTO_PLATFORM,
  PHOTO_PLATFORM_ONLY,
  photoFixtures,
  type PhotoFixtures,
  type PhotoWorkerFixtures,
} from './photoPack';

const test = plain.extend<PhotoFixtures, PhotoWorkerFixtures>({
  ...photoFixtures,
  // the photo pack and the scripted model
  appEnv: async ({ photoPackEnv, photoSite }, use) => {
    expect(photoSite.dir).toBeTruthy();
    await use({ ...photoPackEnv, QUADRION_AI_TEST_PROVIDER: '1' });
  },
});

interface Probe {
  __stratlas: {
    workspace: {
      getState(): { project: { manifest: { layers: { id: string; kind: string }[] } } | null };
    };
  };
}

const agent = (win: Page) => win.getByRole('region', { name: 'Agent' });
const steps = (win: Page) => agent(win).locator('.step');
const replies = (win: Page) => agent(win).getByText(/^Tool \w+ returned/);

/**
 * Send a request (with a `#tool` line for the scripted model) and wait until the agent answers it
 * with a step or a reply. The first send in a project stops at the send preview.
 */
async function send(win: Page, text: string) {
  const box = agent(win).getByRole('textbox', { name: 'Message the agent' });
  await expect(box).toBeEnabled({ timeout: 60_000 });
  const before = (await steps(win).count()) + (await replies(win).count());
  await box.fill(text);
  await box.press('Enter');
  const preview = win.getByRole('dialog', { name: /Send to/ });
  await expect
    .poll(
      async () => {
        if (await preview.isVisible())
          await preview
            .getByRole('button', { name: 'Send' })
            .click()
            .catch(() => undefined);
        return (await steps(win).count()) + (await replies(win).count());
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(before);
}

const layerIds = (win: Page) =>
  win.evaluate(
    () =>
      (window as unknown as Probe).__stratlas.workspace
        .getState()
        .project?.manifest.layers.map((l) => l.id) ?? [],
  );

const alignJobs = (win: Page) =>
  win.evaluate(async () => {
    const list = await window.aio.invoke('jobs:list', {});
    return list.jobs.filter((j) => j.pipeline === 'photo.align').length;
  });

test.describe('agent photo tools on the stand-in pipelines', () => {
  test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);
  test.skip(!PHOTO_PLATFORM, PHOTO_PLATFORM_ONLY);

  test('process_photos asks, starts a run whose maps come back, accuracy_summary reads it', async ({
    win,
  }) => {
    test.setTimeout(240_000);
    await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: true }));
    await openPhotoSite(win);

    await send(win, 'make maps from the photos #tool process_photos {"preset":"fast"}');
    await expect(agent(win).locator('.step.awaiting')).toContainText('process_photos');
    await agent(win).getByRole('button', { name: 'Approve' }).click();
    const done = agent(win).locator('.step.done').last();
    await expect(done).toContainText(/Run \d{8}-\d{4}(-\d+)? started/, { timeout: 60_000 });
    const run = /Run (\d{8}-\d{4}(?:-\d+)?) started/.exec(await done.innerText())?.[1] ?? '';
    expect(run).not.toBe('');

    // the maps start by themselves after alignment and come in as layers (the stand-in
    // pipelines add one model layer for any products)
    await expect.poll(() => layerIds(win), { timeout: 180_000 }).toContain(`photo-${run}-mesh`);

    await send(win, 'how accurate is it #tool accuracy_summary {}');
    await expect(replies(win).last()).toContainText('Tool accuracy_summary returned', {
      timeout: 60_000,
    });
    await expect(replies(win).last()).toContainText(run);
    await expect(agent(win).locator('.step.done').last()).toContainText('GNSS only');
  });

  test('a rejected approval starts nothing', async ({ win }) => {
    await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: true }));
    await openPhotoSite(win);
    await send(win, 'make maps #tool process_photos {}');
    await expect(agent(win).locator('.step.awaiting')).toContainText('process_photos');
    await agent(win).getByRole('button', { name: 'Reject' }).click();
    await expect(agent(win).locator('.step.awaiting')).toHaveCount(0);
    await expect(replies(win).last()).toContainText('Tool process_photos returned');
    expect(await alignJobs(win)).toBe(0);
  });
});
