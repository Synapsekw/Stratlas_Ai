/**
 * Accessibility (M7 D6): every screen and the main popovers and dialogs pass an axe-core audit
 * (WCAG 2.1 AA plus best practices, `AXE_ALLOW` for what is not applicable), and the keyboard
 * walk keeps focus somewhere meaningful: popovers and dialogs take focus, keep Tab inside, close
 * on Esc and hand focus back to the control that opened them.
 *
 * Runs on synthetic projects (CI): the tiny project plus a two-date project with a point cloud,
 * a photo and an issue on it, and a package of the tiny project opened in player mode.
 * The video window and the real-data popovers run on a copy of HCl where the real data has it
 * (realData.ts, @realdata).
 */
import { ProjectManifest, type ProjectManifestInput } from '@aio/schema';
import type { Locator, Page } from '@playwright/test';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { expectAccessible, expectFocusMeaningful, focusInfo } from './a11y';
import {
  expect,
  launchApp,
  NetworkGuard,
  realProject,
  test,
  tinyGlb,
  tinyManifest,
  type DataRoot,
} from './fixtures';
import { hasRealProject, missingRealProject } from './realData';

test.setTimeout(240_000);

const COPC = join(import.meta.dirname, '../../../packages/pointcloud/test-data/synthetic.copc.laz');
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Next to the tiny project: two dates, a point cloud, a photo and an issue marked on it. */
async function richProject(data: DataRoot): Promise<void> {
  const dir = join(data.root, 'projects', 'e2e-a11y');
  await mkdir(join(dir, 'models'), { recursive: true });
  await mkdir(join(dir, 'clouds'), { recursive: true });
  await mkdir(join(dir, 'photos'), { recursive: true });
  for (const f of ['site', 'model-jan', 'model-jun'])
    await writeFile(join(dir, 'models', `${f}.glb`), tinyGlb());
  await copyFile(COPC, join(dir, 'clouds', 'synthetic.copc.laz'));
  const photo = await sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 92, g: 104, b: 118 } },
  })
    .jpeg()
    .toBuffer();
  await writeFile(join(dir, 'photos', 'p1.jpg'), photo);
  const mesh = (id: string, name: string, at: number) => ({
    kind: 'mesh' as const,
    id,
    name,
    visible: true,
    src: { path: `models/${id}.glb` },
    transform: [...IDENTITY.slice(0, 12), at, 0, 0, 1],
  });
  const manifest: ProjectManifestInput = {
    ...tinyManifest(),
    id: 'e2e-a11y',
    name: 'E2E accessibility',
    captures: [
      { id: 'jan', label: 'January flight', date: '2026-01-01' },
      { id: 'jun', label: 'June flight', date: '2026-06-01' },
    ],
    layers: [
      mesh('site', 'Site', 0),
      mesh('model-jan', 'Model 1 Jan 2026', 2),
      mesh('model-jun', 'Model 1 Jun 2026', 4),
      {
        kind: 'pointcloud',
        id: 'cloud',
        name: 'Synthetic cloud',
        src: { path: 'clouds/synthetic.copc.laz' },
        format: 'copc',
        pointCount: 16000,
      },
      {
        kind: 'photos',
        id: 'photos',
        name: 'Photos',
        items: [{ id: 'p1', src: { path: 'photos/p1.jpg' }, pos: [0.5, 2, -0.5] }],
      },
    ],
    severityModels: [
      {
        id: 'sev',
        name: 'Severity 1 to 5',
        levels: [
          { value: 1, label: 'Observation', color: '#8a94a6', criteria: 'No action' },
          { value: 3, label: 'Moderate', color: '#e8c547', criteria: 'Monitor' },
          { value: 5, label: 'Critical', color: '#e5484d', criteria: 'Repair now' },
        ],
      },
    ],
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(ProjectManifest.parse(manifest)));
  const issue = {
    id: 'i1',
    code: 'F01',
    classId: 'coating',
    severityModelId: 'sev',
    severity: 3,
    status: 'draft',
    title: 'Coating breakdown',
    note: '',
    author: 'reviewer',
    createdAt: '2026-10-03T10:00:00+03:00',
    updatedAt: '2026-10-03T10:00:00+03:00',
    sightings: [
      {
        on: 'image',
        layer: 'photos',
        photo: 'p1',
        geom: { type: 'box', x: 200, y: 150, w: 120, h: 90 },
      },
    ],
    source: 'human',
  };
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [issue] }),
  );
}

const nav = (win: Page, name: string) =>
  win.locator('.sb-nav .nav-item', { hasText: name }).first().click();

async function openProject(win: Page, name: string) {
  await nav(win, 'Projects');
  await win.getByTestId('project-card').filter({ hasText: name }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
}

/**
 * A stage popover opened from its tool by keyboard: focus moves inside, Tab stays inside, Esc
 * closes it and focus is back on the tool. Audits the open popover.
 */
async function popoverByKeyboard(win: Page, label: string, within?: Locator) {
  const tool = (within ?? win.locator('.stbar')).getByRole('button', { name: label, exact: true });
  await tool.focus();
  await win.keyboard.press('Enter');
  const pop = win.getByRole('dialog', { name: label });
  await expect(pop).toBeVisible();
  await expect(tool).toHaveAttribute('aria-expanded', 'true');
  const inside = () => pop.evaluate((el) => el.contains(document.activeElement));
  await expect.poll(inside).toBe(true);
  for (let i = 0; i < 12; i++) await win.keyboard.press('Tab');
  expect(await inside(), `Tab left the ${label} popover`).toBe(true);
  await expectAccessible(win, `popover: ${label}`);
  await win.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await expect(tool).toBeFocused();
  await expectFocusMeaningful(win, `closing ${label}`);
}

test('library, import wizard, command search and every Settings section', async ({ win }) => {
  await expect(win.getByTestId('project-card').first()).toBeVisible();
  await expectAccessible(win, 'Projects');

  // the import wizard: focus inside, Tab stays inside, Esc closes back onto its button
  const newProject = win.getByTestId('new-project');
  await newProject.focus();
  await win.keyboard.press('Enter');
  const wizard = win.getByRole('dialog', { name: 'New project' });
  await expect(wizard).toBeVisible();
  await expect.poll(() => wizard.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  for (let i = 0; i < 25; i++) await win.keyboard.press('Tab');
  expect(await wizard.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await expectAccessible(win, 'Import wizard');
  await win.keyboard.press('Escape');
  await expect(wizard).toBeHidden();
  await expect(newProject).toBeFocused();

  // command search from the title bar button, and back
  const search = win.locator('.search-btn');
  await search.focus();
  await win.keyboard.press('Enter');
  const palette = win.getByRole('dialog', { name: 'Command search' });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('combobox')).toBeFocused();
  await expectAccessible(win, 'Command search');
  await win.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  await expect(search).toBeFocused();

  // Settings, one section after the other
  await win.locator('.sb-foot .nav-item', { hasText: 'Settings' }).click();
  const sections = win.locator('.set-nav button');
  const count = await sections.count();
  expect(count).toBeGreaterThanOrEqual(10);
  for (let i = 0; i < count; i++) {
    const b = sections.nth(i);
    const label = (await b.innerText()).trim();
    await b.click();
    await expect(win.locator('.set-page h1')).toHaveText(label);
    await expectAccessible(win, `Settings, ${label}`);
  }

  // the keyboard map: searchable, every place listed
  await sections.filter({ hasText: 'Keyboard' }).click();
  await expect(win.getByTestId('keymap-scene')).toContainText('Measure on or off');
  await win.getByTestId('keymap-search').fill('measure');
  await expect(win.getByTestId('keymap-scene')).toContainText('M');
  await expect(win.getByTestId('keymap-review')).toHaveCount(0);
  await expect(win.locator('.set-page [role="status"]')).toContainText('shortcuts');

  // more contrast and reduced motion from Settings, mirrored on <html>
  await sections.filter({ hasText: 'Appearance' }).click();
  const html = win.locator('html');
  await win.getByRole('switch', { name: 'Increase contrast' }).click();
  await expect(html).toHaveAttribute('data-contrast', 'more');
  await win.getByRole('switch', { name: 'Reduce motion' }).click();
  await expect(html).toHaveAttribute('data-motion', 'reduce');
  await expectAccessible(win, 'Settings, Appearance, more contrast');
  // and the light theme with more contrast
  await win.getByRole('radio', { name: 'Light', exact: true }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expectAccessible(win, 'Settings, Appearance, light, more contrast');
  await win.getByRole('switch', { name: 'Increase contrast' }).click();
  await expect(html).not.toHaveAttribute('data-contrast', 'more');
  await nav(win, 'Projects');
  await expectAccessible(win, 'Projects, light theme');
});

test('the OS asking for more contrast and less motion is followed', async ({ win }) => {
  await win.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await expect(win.locator('html')).toHaveAttribute('data-contrast', 'more');
  await expect(win.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await win.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' });
  await expect(win.locator('html')).not.toHaveAttribute('data-motion', 'reduce');
});

/** Nothing inside `root` animates or transitions (reduced motion: the OS or Settings). */
async function expectStill(root: ReturnType<Page['locator']>, where: string): Promise<void> {
  const moving = await root.evaluate((el) =>
    [el, ...Array.from(el.querySelectorAll('*'))].flatMap((n) => {
      const s = getComputedStyle(n);
      const slow = s.transitionDuration.split(',').some((d) => parseFloat(d) > 0.01);
      return s.animationName !== 'none' || slow
        ? [`${n.tagName}.${n.getAttribute('class') ?? ''}`]
        : [];
    }),
  );
  expect(moving, `${where}: moving parts under reduced motion`).toEqual([]);
}

test('user guide and report a problem keep focus inside and hold still', async ({ win }) => {
  await expect(win.getByTestId('project-card').first()).toBeVisible();
  await win.emulateMedia({ reducedMotion: 'reduce' });
  await expect(win.locator('html')).toHaveAttribute('data-motion', 'reduce');

  // F1: the guide takes focus in its search box, keeps Tab inside, Esc hands focus back
  const search = win.locator('.search-btn');
  await search.focus();
  await win.keyboard.press('F1');
  const guide = win.getByRole('dialog', { name: 'User guide' });
  await expect(guide).toBeVisible();
  await expect(guide.getByRole('searchbox').or(guide.locator('input')).first()).toBeFocused();
  for (let i = 0; i < 30; i++) await win.keyboard.press('Tab');
  expect(await guide.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await expectAccessible(win, 'User guide');
  await expectStill(guide, 'User guide');
  await win.keyboard.press('Escape');
  await expect(guide).toBeHidden();
  await expect(search).toBeFocused();

  // Settings, About and updates, Report a problem: the same rules for the form
  await win.locator('.sb-foot .nav-item', { hasText: 'Settings' }).click();
  await win.locator('.set-nav button', { hasText: 'About and updates' }).click();
  const report = win.getByTestId('diagnostics').getByRole('button', { name: 'Report a problem' });
  await report.focus();
  await win.keyboard.press('Enter');
  const form = win.getByRole('dialog', { name: 'Report a problem' });
  await expect(form).toBeVisible();
  await expect.poll(() => form.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  for (let i = 0; i < 20; i++) await win.keyboard.press('Tab');
  expect(await form.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await expectAccessible(win, 'Report a problem');
  await expectStill(form, 'Report a problem');
  await win.keyboard.press('Escape');
  await expect(form).toBeHidden();
  await expect(report).toBeFocused();
  await expectStill(win.locator('.set-page'), 'Settings, About and updates');
  await win.emulateMedia({ reducedMotion: 'no-preference' });
});

test.describe('a synthetic project', () => {
  test.beforeEach(async ({ dataRoot }) => {
    await richProject(dataRoot);
  });

  test('scene, stage tools and popovers, issue card, photo and every project screen', async ({
    app,
    win,
  }) => {
    await openProject(win, 'E2E accessibility');
    await expectAccessible(win, 'Scene, 3D');

    // the stage tools are one toolbar: Left and Right move between them
    const bar = win.getByRole('toolbar', { name: 'Stage tools' });
    await expect(bar).toBeVisible();
    await bar.getByRole('button', { name: '3D' }).focus();
    await win.keyboard.press('ArrowRight');
    await expect(bar.getByRole('button', { name: 'Map' })).toBeFocused();
    await win.keyboard.press('ArrowLeft');
    await expect(bar.getByRole('button', { name: '3D' })).toBeFocused();

    // Every stage popover, wherever the window width puts its tool: on the bar, or folded into
    // More tools. How many fold depends on the window, and the window on the screen (the macOS
    // runner's display is smaller than the default 1440 x 900, so the window opens narrower than
    // on Windows), so the bar is walked first at the size the window got, then again at the
    // smallest window the app allows, where tools fold on every platform.
    const POPOVERS = [
      'View presets',
      'Layers and issue pins',
      'Point cloud',
      'Environment and time of day',
      'See inside the asset: cut or transparent',
    ];
    const opened = new Set<string>();
    const walkBar = async () => {
      for (const label of POPOVERS) {
        const tool = bar.getByRole('button', { name: label, exact: true });
        if ((await tool.count()) === 0 || !(await tool.isEnabled())) continue;
        await popoverByKeyboard(win, label);
        opened.add(label);
      }
    };
    await walkBar();
    const firstWidth = await win.evaluate(() => window.innerWidth);
    const size = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (!w) return null;
      const before = w.getContentSize();
      const [minW = 0, minH = 0] = w.getMinimumSize();
      w.setContentSize(minW, minH);
      return [...before, minW];
    });
    // More tools may already show at the first size (a narrower screen), so it is no sign the bar
    // has refitted: wait until the renderer has the new size and every tool is inside the bar.
    await expect
      .poll(() =>
        bar.evaluate(
          (el, { first, min }) => {
            const end = el.getBoundingClientRect().right + 1;
            const inside = [...el.children].every((c) => c.getBoundingClientRect().right <= end);
            return (window.innerWidth < first || first <= min) && inside;
          },
          { first: firstWidth, min: size?.[2] ?? 0 },
        ),
      )
      .toBe(true);
    const more = bar.getByRole('button', { name: 'More tools', exact: true });
    await expect(more, 'tools fold into More tools in the smallest window').toBeVisible();
    await walkBar();
    // the folded tools, from inside the More tools popover; Esc closes the inner popover first
    const folded: string[] = [];
    for (const label of POPOVERS) {
      await more.focus();
      await win.keyboard.press('Enter');
      const menu = win.getByRole('dialog', { name: 'More tools' });
      await expect(menu).toBeVisible();
      const tool = menu.getByRole('button', { name: label, exact: true });
      if ((await tool.count()) > 0 && (await tool.isEnabled())) {
        await popoverByKeyboard(win, label, menu);
        await expect(menu, `More tools stays open after closing ${label}`).toBeVisible();
        folded.push(label);
        opened.add(label);
      }
      await win.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(more).toBeFocused();
    }
    expect(folded.length, 'popovers opened from More tools').toBeGreaterThan(0);
    expect([...opened].sort(), `popovers opened: ${[...opened].join(', ')}`).toEqual(
      [...POPOVERS].sort(),
    );
    await app.evaluate(({ BrowserWindow }, s) => {
      if (s) BrowserWindow.getAllWindows()[0]?.setContentSize(s[0] ?? 1440, s[1] ?? 900);
    }, size);

    // the issue card from the register, its photo full size, and back
    await win.getByRole('tab', { name: /Issues/ }).click();
    await win.locator('.ann-list').getByText('F01').first().click();
    await expect(win.getByTestId('issue-card')).toBeVisible();
    await expectAccessible(win, 'Scene, issue card');
    const photo = win.getByTestId('issue-card-photo');
    if (await photo.count()) {
      await photo.focus();
      await win.keyboard.press('Enter');
      const lb = win.getByTestId('lightbox');
      await expect(lb).toBeVisible();
      await expect.poll(() => lb.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      await expectAccessible(win, 'Lightbox');
      await win.keyboard.press('Escape');
      await expect(lb).toBeHidden();
      await expect(photo).toBeFocused();
    }

    // map and split
    await win.keyboard.press('Escape');
    await win.locator('body').press('2');
    await expect(win.locator('.app')).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Map' })).toHaveAttribute('aria-pressed', 'true');
    await expectAccessible(win, 'Scene, Map');
    await bar.getByRole('button', { name: 'Split' }).click();
    await expectAccessible(win, 'Scene, Split');

    // compare two dates in the split
    const compare = win.getByTestId('compare-dates');
    if (await compare.count()) {
      // A software GPU (CI) is the Low tier, where Compare dates offers two maps by design; the
      // audit covers the two 3D views, so pin Medium there (as compare.spec does).
      await win.evaluate(() => {
        const g = (
          window as unknown as {
            __stratlas: {
              graphics(): { getState(): { tier: string; setOverride(t: string | null): void } };
            };
          }
        ).__stratlas
          .graphics()
          .getState();
        if (g.tier === 'low') g.setOverride('medium');
      });
      await compare.click();
      await expect(win.locator('[data-scene-view] canvas')).toHaveCount(2);
      await expectAccessible(win, 'Scene, compare dates');
    }
    await bar.getByRole('button', { name: '3D' }).click();

    for (const screen of ['Issues', 'Media', 'Detections', 'Reports', 'Jobs']) {
      await nav(win, screen);
      await expect(win.locator('.crumbs b')).toHaveText(screen);
      await expectAccessible(win, screen);
    }

    // Issues: the export menu by keyboard
    await nav(win, 'Issues');
    const exportBtn = win.getByRole('button', { name: 'Export', exact: true });
    await exportBtn.focus();
    await win.keyboard.press('Enter');
    const menu = win.getByRole('menu', { name: 'Export' });
    await expect(menu).toBeVisible();
    await expect.poll(() => menu.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await win.keyboard.press('ArrowDown');
    await expectAccessible(win, 'Issues, export menu');
    await win.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(exportBtn).toBeFocused();

    // Reports: the package export dialog
    await nav(win, 'Reports');
    await win.getByTestId('export-package').click();
    const pkg = win.getByTestId('package-export');
    await expect(pkg).toBeVisible();
    await expect.poll(() => pkg.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await expectAccessible(win, 'Package export dialog');
    await win.keyboard.press('Escape');
    await expect(pkg).toBeHidden();
    await expectFocusMeaningful(win, 'closing the package export dialog');
  });
});

test('a package opens in player mode and is accessible', async ({ app, win, dataRoot }) => {
  const file = join(dataRoot.base, 'tiny.aio');
  await win.getByTestId('project-card').first().click();
  await nav(win, 'Reports');
  await win.getByTestId('export-package').click();
  const dialog = win.getByTestId('package-export');
  await expect(dialog.getByTestId('pkg-size')).not.toContainText('...');
  await app.evaluate(({ dialog: d }, target) => {
    d.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: target });
  }, file);
  await dialog.getByTestId('pkg-export').click();
  await expect(dialog.getByTestId('pkg-done')).toBeVisible({ timeout: 180_000 });
  // the export result is announced through the dialog's own status text
  await expectAccessible(win, 'Package export, done');
  expect((await stat(file)).size).toBeGreaterThan(0);

  const customer: DataRoot = {
    base: dataRoot.base,
    root: join(dataRoot.base, 'customer-data'),
    userData: join(dataRoot.base, 'customer-user'),
    projectId: '',
    projectDir: '',
  };
  await mkdir(customer.root, { recursive: true });
  const network = new NetworkGuard();
  const player = await launchApp(customer, {}, [file]);
  try {
    await network.attach(player);
    const pw = await player.firstWindow();
    await pw.waitForLoadState('domcontentloaded');
    await expect(pw.getByTestId('welcome')).toContainText('E2E tiny project');
    await expectAccessible(pw, 'Package player, welcome');
    await pw.locator('.sb-nav .nav-item', { hasText: 'Scene' }).first().click();
    await expect(pw.locator('[data-scene-view] canvas').first()).toBeVisible();
    await expectAccessible(pw, 'Package player, scene');
    expect(await network.outbound()).toEqual([]);
  } finally {
    await player.close();
  }
});

test('focus never falls into the page when the control that had it goes away', async ({ win }) => {
  await win.getByTestId('project-card').first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
  // a nav button that disappears with its screen: leaving the project removes Jobs-only UI
  await nav(win, 'Jobs');
  const newJob = win.getByRole('button', { name: /New job/ }).first();
  if (await newJob.count()) {
    await newJob.focus();
    await nav(win, 'Issues');
  }
  // closing the project from the switcher removes the menu item that had focus
  await win.locator('.proj-switch').focus();
  await win.keyboard.press('Enter');
  const menu = win.locator('.proj-menu');
  await expect(menu).toBeVisible();
  await expect.poll(() => menu.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await menu.getByRole('menuitem', { name: 'Close project' }).focus();
  await win.keyboard.press('Enter');
  const f = await expectFocusMeaningful(win, 'closing the project from the switcher');
  expect(f.lost).toBe(false);
  expect((await focusInfo(win)).tag).not.toBe('body');
});

test.describe('@realdata HCl (real data, local only)', () => {
  test.skip(!hasRealProject('hcl'), missingRealProject('hcl'));

  test('video window, inside the asset, point cloud and issue card', async () => {
    // a temporary copy of the project (realData.ts), deleted at close
    const run = await realProject('hcl');
    const { win, network } = run;
    try {
      await win.getByTestId('project-card').filter({ hasText: /HCl/i }).first().click();
      await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible({
        timeout: 60_000,
      });
      await expect(win.locator('.vwin').first()).toBeVisible({ timeout: 60_000 });
      await expectAccessible(win, 'HCl, scene with the video window');
      const bar = win.getByRole('toolbar', { name: 'Stage tools' });
      for (const label of [
        'Layers and issue pins',
        'Point cloud',
        'See inside the asset: cut or transparent',
        'Flight paths',
      ]) {
        const tool = bar.getByRole('button', { name: label, exact: true });
        if ((await tool.count()) === 0 || !(await tool.isEnabled())) continue;
        await popoverByKeyboard(win, label);
      }
      await win.getByRole('tab', { name: /Issues/ }).click();
      await win.locator('.ann-list [role="option"]').first().click();
      await expect(win.getByTestId('issue-card')).toBeVisible();
      await expectAccessible(win, 'HCl, issue card');
      expect(await network.outbound()).toEqual([]);
    } finally {
      await run.close();
    }
  });
});
