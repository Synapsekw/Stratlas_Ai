/**
 * The agent shows things (scripted test model, no network) on the tank farm demo: the worst
 * finding with its photo beside the 3D view, Media with the highest severity level set, a scope
 * chip the person clears, Undo, a finding shown from Media, the folding agent column, the Issues
 * list filtered, a change of project, and the column in the smallest window.
 *
 * The requests carry `#tool <name> <json>` lines for the scripted model. The tests of the first
 * group share one app and one conversation, in order: each starts from where the one before left
 * the app, as a person's session does. The state of the app is read through `window.__stratlas`.
 * The demos are the bundled ones (`pnpm demo:build --quick`), opened as working copies.
 */
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CHANGE_DEMO,
  createDataRoot,
  DEMO_FOLDER,
  expect,
  hasChangeDemo,
  launchApp,
  NetworkGuard,
  openChangeDemo,
  test,
  type DataRoot,
} from './fixtures';
import { openDemo } from './surveyJobs';

test.setTimeout(180_000);

const TANK_FARM = { id: 'demo-tank-farm', name: 'Demo tank farm' };
const hasTankFarm = () => existsSync(join(DEMO_FOLDER, TANK_FARM.id, 'manifest.json'));
test.skip(
  !hasTankFarm() || !hasChangeDemo(),
  `no demos in ${DEMO_FOLDER}: run pnpm demo:build --quick`,
);

const SHOTS = process.env.QUADRION_E2E_SHOTS;

type V3 = [number, number, number];
type Level = number | 'uncertain';

interface DemoIssue {
  id: string;
  code: string;
  title: string;
  severity: Level;
  status: string;
  sightings: { on: string; layer: string; photo?: string; geom?: { type: string; p?: V3 } }[];
}

interface DemoManifest {
  layers: {
    kind: string;
    id: string;
    items?: { id: string }[];
    tags?: { node: string; tag: string; area?: string }[];
  }[];
}

const demoFile = (project: string, file: string): unknown =>
  JSON.parse(readFileSync(join(DEMO_FOLDER, project, file), 'utf8'));
const demoManifest = (project: string) => demoFile(project, 'manifest.json') as DemoManifest;

/** The tank farm as it is on disk: what the screens must agree with. */
function tankFarm() {
  const { issues } = demoFile(TANK_FARM.id, 'issues.json') as { issues: DemoIssue[] };
  const manifest = demoManifest(TANK_FARM.id);
  const byCode = (code: string) => {
    const found = issues.find((i) => i.code === code);
    if (!found) throw new Error(`the demo has no finding ${code}`);
    return found;
  };
  const point = (code: string): V3 => {
    const p = byCode(code).sightings.find((s) => s.on === 'mesh')?.geom?.p;
    if (!p) throw new Error(`${code} has no place on the model`);
    return p;
  };
  const photosOf = (list: DemoIssue[]) => [
    ...new Set(list.flatMap((i) => i.sightings.flatMap((s) => (s.photo ? [s.photo] : [])))),
  ];
  const onPhotos = issues.filter((i) => i.sightings.some((s) => s.on === 'image'));
  const worst = Math.max(...onPhotos.map((i) => (typeof i.severity === 'number' ? i.severity : 0)));
  return {
    issues,
    byCode,
    point,
    photosOf,
    photos: manifest.layers.flatMap((l) => (l.kind === 'photos' ? (l.items ?? []) : [])).length,
    photosWithFindings: photosOf(onPhotos),
    worstOnPhotos: worst,
    photosOfWorst: photosOf(onPhotos.filter((i) => i.severity === worst)),
    nodes: manifest.layers
      .flatMap((l) => (l.id === 'model' ? (l.tags ?? []) : []))
      .map((t) => t.node),
  };
}

interface Probe {
  __stratlas: {
    workspace: {
      getState(): {
        project: { manifest: { id: string } } | null;
        selection: { kind: string; id: string } | null;
      };
    };
    stage(): {
      saveView(): { position: V3; target: V3 };
      scene: { getObjectByName(n: string): unknown };
    } | null;
    shell: {
      getState(): {
        screen: string;
        stageMode: string;
        agentDockCollapsed: boolean;
        rightCollapsed: boolean;
      };
    };
    mediaView: {
      getState(): {
        onlyFindings: boolean;
        order: string;
        severity: Level | null;
        scope: { label: string; ids: string[] } | null;
      };
    };
    issueView: {
      getState(): {
        text: string;
        sev: Level | null;
        classId: string;
        status: string;
        sort: string;
        dir: string;
        scope: { label: string; ids: string[] } | null;
      };
    };
    evidence: { getState(): { open: { issueId: string; kind: string } | null } };
  };
}

/** What the app shows now, as plain data. */
const appState = (win: Page) =>
  win.evaluate(() => {
    const s = (window as unknown as Probe).__stratlas;
    const sh = s.shell.getState();
    const ws = s.workspace.getState();
    const open = s.evidence.getState().open;
    return {
      project: ws.project?.manifest.id ?? null,
      screen: sh.screen,
      stageMode: sh.stageMode,
      dockFolded: sh.agentDockCollapsed,
      selection: ws.selection ? { kind: ws.selection.kind, id: ws.selection.id } : null,
      evidence: open ? { issueId: open.issueId, kind: open.kind } : null,
      media: { ...s.mediaView.getState() },
      issues: { ...s.issueView.getState() },
    };
  });

const camera = (win: Page) =>
  win.evaluate(() => (window as unknown as Probe).__stratlas.stage()?.saveView() ?? null);

const dist = (a: readonly number[], b: readonly number[]) =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));

/** Metres from the point the 3D camera looks at to `want`; far away while there is no 3D view. */
async function lookingAt(win: Page, want: V3): Promise<number> {
  const v = await camera(win);
  return v ? Math.round(dist(v.target, want) * 100) / 100 : 9999;
}

/**
 * How many readings in a row the 3D camera has stood still: 0 while it moves, and while there is
 * no 3D view. Polled, it says when a flight and whatever the view does as it mounts are over.
 */
function cameraRest(win: Page): () => Promise<number> {
  let last: { position: V3; target: V3 } | null = null;
  let still = 0;
  return async () => {
    const now = await camera(win);
    const same =
      now !== null &&
      last !== null &&
      dist(now.position, last.position) < 0.01 &&
      dist(now.target, last.target) < 0.01;
    still = same ? still + 1 : 0;
    last = now;
    return still;
  };
}

/** Wait until every named node of the model is in the 3D scene. */
async function waitForNodes(win: Page, names: string[]) {
  await expect
    .poll(
      () =>
        win.evaluate((ns) => {
          const scene = (window as unknown as Probe).__stratlas.stage()?.scene;
          return scene ? ns.filter((n) => !scene.getObjectByName(n)).length : -1;
        }, names),
      { timeout: 120_000 },
    )
    .toBe(0);
}

const agent = (win: Page) => win.getByRole('region', { name: 'Agent' });
const dock = (win: Page) => win.locator('#agent-dock');
const toggle = (win: Page) => win.getByTestId('agent-toggle');
const replies = (win: Page) => agent(win).getByText(/^Tool \w+ returned/);
const requests = (win: Page) => agent(win).locator('.ag-msg.user');
const photoCards = (win: Page) => win.locator('.media-main .m-card.sq[data-photo]');
const issueRows = (win: Page) => win.locator('.issues-screen [data-issue-list] .ann-row');
const onScreen = (win: Page, screen: string) =>
  expect(win.locator(`.app[data-screen="${screen}"]`)).toBeVisible();

/**
 * Send a request (with `#tool` lines for the scripted model) and return the model's answer, which
 * quotes the last tool's result. The first send in a project stops at the send preview.
 */
async function send(win: Page, text: string): Promise<string> {
  const box = agent(win).getByRole('textbox', { name: 'Message the agent' });
  await expect(box).toBeEnabled({ timeout: 60_000 });
  const before = await replies(win).count();
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
        // a step can change the screen, and the panel with it: the conversation is the same
        return replies(win).count();
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(before);
  return replies(win).last().innerText();
}

/** `send`, for a request whose step must succeed. */
async function ask(win: Page, text: string): Promise<string> {
  const reply = await send(win, text);
  expect(reply, 'the tool failed').not.toContain('error-text');
  return reply;
}

const shownIn = (reply: string) => Number(/"shown":(\d+)/.exec(reply)?.[1] ?? NaN);

async function goTo(win: Page, name: 'Scene' | 'Issues' | 'Media' | 'Detections' | 'Reports') {
  await win.locator('.sb-nav .nav-item', { hasText: name }).first().click();
  await onScreen(win, name.toLowerCase());
}

/** The first visit to Scene of `askOnMediaOnceMeasured`: long enough on a machine that keeps up. */
const SCENE_VISIT_MS = 2000;

/** Scene for `ms` once the model is there, then Media again. */
async function visitScene(win: Page, node: string, ms: number) {
  await goTo(win, 'Scene');
  await waitForNodes(win, [node]);
  await win.waitForTimeout(ms);
  await goTo(win, 'Media');
}

/**
 * Ask about an asset on Media once the bounds of the assets are known there. They are measured
 * once a second while the 3D view shows the model (assetWarm.ts) and remembered; nothing on
 * screen says when that has happened, and a question asked on Scene would measure them itself.
 * What says it is the answer on Media, where nothing can be measured: while that is "still
 * loading", Scene gets another visit, twice as long each time. A slow machine takes longer; it
 * does not fail.
 */
async function askOnMediaOnceMeasured(win: Page, node: string, text: string): Promise<string> {
  await onScreen(win, 'media');
  let reply = await send(win, text);
  for (let ms = SCENE_VISIT_MS * 2; reply.includes('still loading'); ms *= 2) {
    expect(ms, 'the bounds of the assets were never measured on Scene').toBeLessThan(40_000);
    await visitScene(win, node, ms);
    reply = await send(win, text);
  }
  return reply;
}

async function unfold(win: Page) {
  if ((await toggle(win).getAttribute('aria-expanded')) !== 'true') await toggle(win).click();
  await expect(dock(win)).toBeVisible();
}

async function fold(win: Page) {
  if ((await toggle(win).getAttribute('aria-expanded')) === 'true') await toggle(win).click();
  await expect(dock(win)).toBeHidden();
}

async function pressKeys(win: Page, keys: string) {
  await win.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await win.keyboard.press(keys);
}

/**
 * What sticks out of the Media list sideways: the parts of it that end right of its own edge.
 * Nothing, when the list fits the room it has.
 */
const mediaOverflow = (win: Page) =>
  win.evaluate(() => {
    const main = document.querySelector('.media-main');
    if (!main) throw new Error('Media is not showing');
    const edge = main.getBoundingClientRect().left + main.clientLeft + main.clientWidth;
    const out: string[] = [];
    for (const el of main.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= edge + 0.5) continue;
      // the outermost part that sticks out says it; what is inside it follows
      if (out.length < 6 && !el.parentElement?.closest('[data-out]')) {
        el.setAttribute('data-out', '');
        out.push(
          `${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''} by ${String(Math.round(r.right - edge))} px`,
        );
      }
    }
    for (const el of main.querySelectorAll('[data-out]')) el.removeAttribute('data-out');
    return { width: main.clientWidth, out };
  });

/**
 * The parts of the screen beside the column that scroll sideways (a scroll bar the person would
 * have to use), each with what sticks out of it. None, when everything fits the room it has.
 */
const sidewaysScrollers = (win: Page) =>
  win.evaluate(() => {
    const screen = document.querySelector('.main > .screen');
    if (!screen) throw new Error('no screen is showing');
    // the class attribute, not className: on an SVG element that is not a string
    const name = (el: Element) =>
      [el.tagName.toLowerCase(), ...(el.getAttribute('class') ?? '').split(/\s+/)]
        .filter(Boolean)
        .join('.');
    const found: string[] = [];
    for (const el of [screen, ...screen.querySelectorAll('*')]) {
      const over = el.scrollWidth - el.clientWidth;
      if (over <= 1 || el.clientWidth === 0) continue;
      const overflow = getComputedStyle(el).overflowX;
      if (overflow !== 'auto' && overflow !== 'scroll') continue;
      const edge = el.getBoundingClientRect().left + el.clientLeft + el.clientWidth;
      const out: string[] = [];
      for (const child of el.querySelectorAll('*')) {
        const r = child.getBoundingClientRect();
        if (r.width === 0 || r.right <= edge + 1) continue;
        if (
          out.length < 5 &&
          ![...child.children].some((c) => c.getBoundingClientRect().right > edge + 1)
        )
          out.push(`${name(child)} +${String(Math.round(r.right - edge))}`);
      }
      found.push(
        `${name(el)} (${String(el.clientWidth)} px) scrolls ${String(over)} px: ${out.join(', ')}`,
      );
    }
    return found;
  });

/**
 * How far the first photo card shown lies outside the visible part of the Media list, in px: 0
 * when the whole card is in view, -1 when no photo card is shown.
 */
const firstPhotoOutside = (win: Page) =>
  win.evaluate(() => {
    const main = document.querySelector('.media-main');
    const card = main?.querySelector('.m-card.sq[data-photo]');
    if (!main || !card) return -1;
    const m = main.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    const top = m.top + main.clientTop;
    const left = m.left + main.clientLeft;
    return Math.max(
      0,
      top - c.top,
      c.bottom - Math.min(top + main.clientHeight, window.innerHeight),
      left - c.left,
      c.right - (left + main.clientWidth),
    );
  });

const mediaScrollTop = (win: Page) => win.locator('.media-main').evaluate((el) => el.scrollTop);

async function shot(win: Page, name: string) {
  if (SHOTS) await win.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** How a scope chip is drawn: the label, the look, and whether a click on its x reaches the x. */
async function chipLook(chip: Locator) {
  const clear = chip.getByRole('button');
  await expect(chip).toBeVisible();
  await expect(clear).toBeVisible();
  return chip.evaluate((el) => {
    const button = el.querySelector('button');
    if (!button) throw new Error('the chip has no clear button');
    const cs = getComputedStyle(el);
    const bs = getComputedStyle(button);
    const c = el.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    const row = el.parentElement?.getBoundingClientRect();
    return {
      look: {
        display: cs.display,
        height: Math.round(c.height),
        background: cs.backgroundColor,
        border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
        color: cs.color,
        fontSize: cs.fontSize,
        radius: cs.borderTopLeftRadius,
        buttonSize: `${String(Math.round(b.width))} x ${String(Math.round(b.height))}`,
        buttonBackground: bs.backgroundColor,
        buttonBorder: bs.borderTopWidth,
        icon: Math.round(button.querySelector('svg')?.getBoundingClientRect().width ?? 0),
      },
      buttonWidth: b.width,
      buttonHeight: b.height,
      // the x sits inside the chip, and the chip inside its row
      buttonInside: b.left >= c.left && b.right <= c.right + 0.5,
      chipInside: row ? c.left >= row.left - 0.5 && c.right <= row.right + 0.5 : false,
      reached: hit !== null && button.contains(hit),
    };
  });
}

/** A chip the person can use: drawn as a chip, its x of a size to hit and not covered. */
function expectUsable(chip: Awaited<ReturnType<typeof chipLook>>) {
  // laid out as a row (a chip in a flex row computes to flex, alone to inline-flex)
  expect(chip.look.display).toMatch(/^(inline-)?flex$/);
  expect(chip.look.height).toBe(24);
  expect(chip.look.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(chip.look.icon).toBeGreaterThan(0);
  expect(chip.buttonWidth).toBeGreaterThanOrEqual(16);
  expect(chip.buttonHeight).toBeGreaterThanOrEqual(16);
  expect(chip.buttonInside).toBe(true);
  expect(chip.chipInside).toBe(true);
  expect(chip.reached).toBe(true);
}

interface Run {
  data: DataRoot;
  app: ElectronApplication;
  win: Page;
  network: NetworkGuard;
}

/** The app with the bundled demos and the scripted model, cloud AI on, the tank farm open. */
async function start(env: Record<string, string> = {}): Promise<Run> {
  const data = await createDataRoot();
  const app = await launchApp(data, {
    QUADRION_AI_TEST_PROVIDER: '1',
    QUADRION_DEMO: DEMO_FOLDER,
    ...env,
  });
  try {
    const network = new NetworkGuard();
    await network.attach(app);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: true }));
    await openDemo(win, TANK_FARM.name, TANK_FARM.id);
    return { data, app, win, network };
  } catch (e) {
    await app.close().catch(() => undefined);
    await rm(data.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    throw e;
  }
}

async function stop(run: Run) {
  // read before the app closes; a read that fails must not leave the app open
  const outbound = await run.network.outbound().catch((e: unknown) => [`not read: ${String(e)}`]);
  await run.app.close();
  await rm(run.data.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  expect(outbound, 'the app made network requests').toEqual([]);
}

test.describe('the agent shows findings, photos and issues on the tank farm', () => {
  test.describe.configure({ mode: 'serial' });

  const farm = tankFarm();
  const AREA = 'Tank T-101';
  let run: Run;
  let win: Page;
  /** How the Media chip is drawn, to compare the Issues chip with. */
  let mediaChip: Awaited<ReturnType<typeof chipLook>>['look'] | null = null;

  test.beforeAll(async () => {
    run = await start();
    win = run.win;
    const [w, h, scale] = await win.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
    process.stdout.write(
      `[e2e] window ${String(w)} x ${String(h)} px at display scale ${String(scale)}\n`,
    );
    // the bounds of the tagged assets come from the model: every asset question needs it loaded
    await waitForNodes(win, farm.nodes);
  });

  test.afterAll(async () => {
    await stop(run);
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus)
      await win.screenshot({ path: info.outputPath('failed.png') }).catch(() => undefined);
  });

  test('take me to the most severe point: F04 is selected, flown to, its photo beside the 3D view', async () => {
    const worst = farm.byCode('F04');
    expect(worst.title).toBe('Heavy corrosion at a rack column base');
    await onScreen(win, 'scene');
    expect((await appState(win)).evidence).toBeNull();

    const reply = await ask(
      win,
      'take me to the most severe point on this asset #tool show_issue {}',
    );
    await expect(agent(win).locator('.step.done').last()).toContainText('show_issue');
    await expect(agent(win).locator('.step.done').last()).toContainText('F04');

    const now = await appState(win);
    expect(now.selection).toEqual({ kind: 'issue', id: worst.id });
    expect(now.stageMode).toBe('split');
    expect(now.evidence).toEqual({ issueId: worst.id, kind: 'photo' });
    await expect(win.locator('.stage')).toHaveAttribute('data-mode', 'split');
    await expect(win.getByTestId('evidence-photo')).toBeVisible();
    await expect(win.getByTestId('evidence-photo')).toHaveAttribute('data-issue', worst.id);
    // the 3D side looks at the finding, close up
    await expect
      .poll(() => lookingAt(win, farm.point('F04')), { timeout: 15_000 })
      .toBeLessThan(0.5);
    const view = await camera(win);
    expect(dist(view?.position ?? [], view?.target ?? [9999])).toBeLessThan(15);

    // the answer names the finding, its level by name and the asset it sits on
    expect(reply).toContain('"code":"F04"');
    expect(reply).toContain('"severityLabel":"Severe"');
    expect(reply).toMatch(/"asset":"Pipe rack [^"]+"/);
    expect(reply).toContain('"area":"Pipe rack"');
    await shot(win, 'agent-show-01-worst-finding');
  });

  test('open the images with the highest severity: Media, the level set, the column with the conversation', async () => {
    const reply = await ask(
      win,
      'open up images with the highest level of severity #tool show_photos {"severity":"highest"}',
    );
    await onScreen(win, 'media');
    expect(farm.worstOnPhotos).toBe(3);
    await expect(win.getByTestId('media-severity')).toHaveValue('3');
    await expect(win.getByTestId('media-severity').locator('option:checked')).toHaveText('Severe');
    await expect(win.getByTestId('media-only-findings')).toHaveAttribute('aria-pressed', 'true');
    await expect(win.getByTestId('media-order')).toHaveValue('severity');

    // the photos shown are the ones the answer counts, and each carries a finding
    await expect(photoCards(win)).toHaveCount(farm.photosOfWorst.length);
    expect(shownIn(reply)).toBe(farm.photosOfWorst.length);
    expect(reply).toContain(`"total":${String(farm.photos)}`);
    expect(reply).toContain('"severity":"Severe"');
    const cards = await photoCards(win).evaluateAll((els) =>
      els.map((el) => ({
        photo: el.getAttribute('data-photo'),
        findings: Number(el.getAttribute('data-findings') ?? 0),
      })),
    );
    expect(cards.map((c) => c.photo).sort()).toEqual([...farm.photosOfWorst].sort());
    for (const card of cards) expect(card.findings).toBeGreaterThan(0);

    // the agent came along: the column is open, with both requests of this conversation
    await expect(dock(win)).toBeVisible();
    await expect(toggle(win)).toHaveAttribute('aria-expanded', 'true');
    await expect(requests(win)).toHaveCount(2);
    await expect(requests(win).nth(0)).toContainText('take me to the most severe point');
    await expect(requests(win).nth(1)).toContainText('open up images with the highest level');
    await expect(agent(win).locator('.ag-bind')).toContainText('Photos');

    // the finding of the first request is still selected, so its card is open beside the photos:
    // with the column that is three panes, and the list of photos still fits its own
    await expect(win.locator('.media.with-viewer')).toBeVisible();
    const list = await mediaOverflow(win);
    expect(list.out, `the Media list is ${String(list.width)} px wide`).toEqual([]);
    expect(await sidewaysScrollers(win)).toEqual([]);
    // what was asked for is in view without a scroll: the photos sit below the videos, and the
    // list brought the first one shown into view when the agent set the filter
    await expect.poll(() => firstPhotoOutside(win)).toBe(0);
    expect(await mediaScrollTop(win)).toBeGreaterThan(0);
    expect((await photoCards(win).first().boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(120);
    expect(
      await win.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await shot(win, 'agent-show-02-media-highest');
  });

  test('the person clears the level; an area shows as a chip that its x clears', async () => {
    await onScreen(win, 'media');
    // the person scrolls back to the top and works the controls: the list stays where they put it
    await win.locator('.media-main').evaluate((el) => {
      el.scrollTop = 0;
    });
    // the person's own change stands: Any brings back every photo with a finding (Only with
    // findings is still pressed, as the agent left it), and that switch brings back the rest
    await win.getByTestId('media-severity').selectOption('');
    await expect(photoCards(win)).toHaveCount(farm.photosWithFindings.length);
    expect(await mediaScrollTop(win)).toBe(0);
    expect(await firstPhotoOutside(win)).toBeGreaterThan(0);
    await expect(win.getByTestId('media-only-findings')).toHaveAttribute('aria-pressed', 'true');
    await win.getByTestId('media-only-findings').click();
    await expect(photoCards(win)).toHaveCount(farm.photos);
    expect((await appState(win)).media).toMatchObject({ severity: null, onlyFindings: false });

    // a filter of the agent that no photo passes: the screen says so, and nothing scrolls
    const none = await ask(
      win,
      'minor ones on the bund #tool show_photos {"severity":1,"where":"Bund"}',
    );
    expect(shownIn(none)).toBe(0);
    await expect(win.getByTestId('media-no-match')).toBeVisible();
    await expect(win.getByTestId('media-scope-chip')).toHaveText('On Bund');
    await expect(photoCards(win)).toHaveCount(0);
    expect(await mediaScrollTop(win)).toBe(0);

    // asked on Media, where there is no 3D view: the bounds of the assets are remembered
    const reply = await ask(win, `photos of the tank #tool show_photos {"where":"${AREA}"}`);
    await onScreen(win, 'media');
    const chip = win.getByTestId('media-scope-chip');
    await expect(chip).toHaveText(`On ${AREA}`);
    // and the photos it shows come into view, this time with Media already showing
    await expect.poll(() => firstPhotoOutside(win)).toBe(0);
    expect(reply).toContain(`"scope":"On ${AREA}"`);
    const shown = shownIn(reply);
    expect(shown).toBeGreaterThan(0);
    await expect(photoCards(win)).toHaveCount(shown);
    const photos = await photoCards(win).evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-photo')),
    );
    // F01 is on the tank's first shell course; F04 is on the pipe rack
    expect(photos).toEqual(expect.arrayContaining(farm.photosOf([farm.byCode('F01')])));
    for (const p of farm.photosOf([farm.byCode('F04')])) expect(photos).not.toContain(p);

    const look = await chipLook(chip);
    expectUsable(look);
    mediaChip = look.look;
    await shot(win, 'agent-show-03-media-chip');
    await chip.getByRole('button', { name: `Clear the filter On ${AREA}` }).click();
    await expect(chip).toHaveCount(0);
    expect((await appState(win)).media.scope).toBeNull();
    await expect(photoCards(win)).toHaveCount(farm.photosWithFindings.length);
  });

  test('Undo puts Media back as it was before the step', async () => {
    await onScreen(win, 'media');
    // the person's own filter first, so "as it was" is not the default
    await win.getByTestId('media-severity').selectOption('2');
    await win.getByTestId('media-order').selectOption('count');
    const before = await appState(win);
    expect(before.media).toMatchObject({ severity: 2, order: 'count', scope: null });
    const cardsBefore = await photoCards(win).count();

    await ask(win, `photos of the tank again #tool show_photos {"where":"${AREA}"}`);
    await expect(win.getByTestId('media-scope-chip')).toHaveText(`On ${AREA}`);
    await expect(win.getByTestId('media-severity')).toHaveValue('');

    await agent(win).getByRole('button', { name: 'Undo' }).last().click();
    await expect(win.getByTestId('media-scope-chip')).toHaveCount(0);
    await onScreen(win, 'media');
    await expect(win.getByTestId('media-severity')).toHaveValue('2');
    await expect(win.getByTestId('media-order')).toHaveValue('count');
    await expect(photoCards(win)).toHaveCount(cardsBefore);
    const after = await appState(win);
    expect(after.media).toEqual(before.media);
    expect(after.dockFolded).toBe(false);
    await expect(agent(win).locator('.step.undone').last()).toContainText('show_photos');
  });

  test('from Media back to 3D: a finding is shown, the camera ends on it, the conversation is intact', async () => {
    await onScreen(win, 'media');
    const asked = await requests(win).count();
    const f01 = farm.byCode('F01');

    const reply = await ask(win, 'show me F01 #tool show_issue {"issue":"F01"}');
    await onScreen(win, 'scene');
    expect(reply).toContain('"code":"F01"');
    const now = await appState(win);
    expect(now.selection).toEqual({ kind: 'issue', id: f01.id });
    expect(now.evidence).toEqual({ issueId: f01.id, kind: 'photo' });
    await expect(win.getByTestId('evidence-photo')).toHaveAttribute('data-issue', f01.id);

    // the camera request was sent as the 3D view mounted: it must win over the view putting its
    // own camera back, and still hold once the view has settled
    await expect
      .poll(() => lookingAt(win, farm.point('F01')), { timeout: 15_000 })
      .toBeLessThan(0.5);
    // settled: the camera has not moved for five readings (two seconds, more on a slow machine)
    await expect
      .poll(cameraRest(win), { timeout: 60_000, intervals: [400] })
      .toBeGreaterThanOrEqual(5);
    expect(await lookingAt(win, farm.point('F01'))).toBeLessThan(0.5);
    const view = await camera(win);
    expect(dist(view?.position ?? [], view?.target ?? [9999])).toBeLessThan(15);

    // the same conversation, now in the Scene's right panel
    await expect(requests(win)).toHaveCount(asked + 1);
    await expect(requests(win).first()).toContainText('take me to the most severe point');
    await expect(requests(win).last()).toContainText('show me F01');
    await shot(win, 'agent-show-05-finding-from-media');
  });

  test('Undo of a finding shown from Media goes back to Media, its filter and the column as they were', async () => {
    // the person closes the photo beside the 3D view, so the step starts without one
    await onScreen(win, 'scene');
    await win.getByTestId('evidence-close').click();
    await expect(win.getByTestId('evidence-photo')).toHaveCount(0);
    // on Media with a filter of the person's and the column open
    await goTo(win, 'Media');
    await unfold(win);
    await win.getByTestId('media-severity').selectOption('1');
    const before = await appState(win);
    expect(before.media.severity).toBe(1);
    expect(before.dockFolded).toBe(false);
    expect(before.evidence).toBeNull();
    const cardsBefore = await photoCards(win).count();

    await ask(win, 'show me F03 #tool show_issue {"issue":"F03"}');
    await onScreen(win, 'scene');
    expect((await appState(win)).selection).toEqual({ kind: 'issue', id: farm.byCode('F03').id });
    await expect(win.getByTestId('evidence-photo')).toBeVisible();

    await agent(win).getByRole('button', { name: 'Undo' }).last().click();
    await onScreen(win, 'media');
    await expect(dock(win)).toBeVisible();
    await expect(win.getByTestId('media-severity')).toHaveValue('1');
    await expect(photoCards(win)).toHaveCount(cardsBefore);
    const after = await appState(win);
    expect(after.media).toEqual(before.media);
    expect(after.dockFolded).toBe(false);
    expect(after.selection).toEqual(before.selection);
    expect(after.evidence).toEqual(before.evidence);
    expect(after.stageMode).toBe(before.stageMode);
    // nothing of the step is left on Scene either
    await goTo(win, 'Scene');
    await expect(win.getByTestId('evidence-photo')).toHaveCount(0);
    await expect(win.locator('.stage')).toHaveAttribute('data-mode', before.stageMode);
  });

  test('the column folds: the title bar button, Ctrl Alt B, and the choice is remembered', async () => {
    await goTo(win, 'Issues');
    await unfold(win);
    await expect(toggle(win)).toHaveAttribute('aria-controls', 'agent-dock');

    await toggle(win).click();
    await expect(dock(win)).toBeHidden();
    await expect(toggle(win)).toHaveAttribute('aria-expanded', 'false');
    await toggle(win).click();
    await expect(dock(win)).toBeVisible();
    await expect(toggle(win)).toHaveAttribute('aria-expanded', 'true');

    await pressKeys(win, 'Control+Alt+b');
    await expect(dock(win)).toBeHidden();
    await expect(toggle(win)).toHaveAttribute('aria-expanded', 'false');
    // folded survives a visit to Media
    await goTo(win, 'Media');
    await expect(dock(win)).toBeHidden();
    await goTo(win, 'Issues');
    await expect(dock(win)).toBeHidden();

    await pressKeys(win, 'Control+Alt+b');
    await expect(dock(win)).toBeVisible();
    // and so does unfolded
    await goTo(win, 'Media');
    await expect(dock(win)).toBeVisible();
    await goTo(win, 'Issues');
    await expect(dock(win)).toBeVisible();
    // the conversation is in it
    await expect(requests(win).first()).toContainText('take me to the most severe point');
    await expect(agent(win).locator('.ag-bind')).toContainText('Issues');
  });

  test('Issues filtered: the highest level in an area, the chip, only matching rows', async () => {
    await goTo(win, 'Issues');
    await unfold(win);
    const reply = await ask(
      win,
      `the worst of the tank #tool show_issues {"severity":"highest","where":"${AREA}"}`,
    );
    await onScreen(win, 'issues');
    const chip = win.getByTestId('issue-scope-chip');
    await expect(chip).toHaveText(`On ${AREA}`);
    expect(reply).toContain(`"scope":"On ${AREA}"`);
    // the worst open findings of the tank are Moderate, not the project's Severe
    expect(reply).toContain('"severity":"Moderate"');
    const severity = win.getByRole('group', { name: 'Severity filter' });
    await expect(severity.locator('button[aria-pressed="true"]')).toHaveAttribute(
      'title',
      'Severity 2',
    );
    await expect(win.getByRole('combobox', { name: 'Sort' })).toHaveValue('severity');
    expect((await appState(win)).issues).toMatchObject({ sev: 2, sort: 'severity' });

    const shown = shownIn(reply);
    expect(shown).toBeGreaterThan(0);
    await expect(issueRows(win)).toHaveCount(shown);
    const codes = await issueRows(win).locator('.iid').allInnerTexts();
    expect(codes).toContain('F01');
    expect(codes).not.toContain('F04');
    for (const code of codes) expect(farm.byCode(code).severity).toBe(2);

    // the card of the selected finding is open beside the list, and nothing scrolls sideways
    await expect(win.locator('.issues-screen .ic-body')).toBeVisible();
    expect(await sidewaysScrollers(win)).toEqual([]);

    // the chip is the Media chip: same look, an x to hit, inside its row
    const look = await chipLook(chip);
    expectUsable(look);
    expect(look.look).toEqual(mediaChip);
    await shot(win, 'agent-show-07-issues-chip');
    await chip.getByRole('button', { name: `Clear the filter On ${AREA}` }).click();
    await expect(chip).toHaveCount(0);
    expect((await appState(win)).issues.scope).toBeNull();
    // the level stays: every Moderate finding of the project now
    await expect(issueRows(win)).toHaveCount(farm.issues.filter((i) => i.severity === 2).length);
  });

  test('the worst finding in an area: the answer names the asset', async () => {
    await onScreen(win, 'issues');
    const reply = await ask(
      win,
      `take me to the most severe point on the tank #tool show_issue {"where":"${AREA}"}`,
    );
    await onScreen(win, 'scene');
    // F01, Moderate: the worst open finding on the tank (F04, Severe, is on the pipe rack)
    const f01 = farm.byCode('F01');
    expect(reply).toContain('"code":"F01"');
    expect(reply).toContain('"severityLabel":"Moderate"');
    expect(reply).toMatch(/"asset":"T-101 [^"]+"/);
    expect(reply).toContain(`"area":"${AREA}"`);
    const now = await appState(win);
    expect(now.selection).toEqual({ kind: 'issue', id: f01.id });
    expect(now.evidence).toEqual({ issueId: f01.id, kind: 'photo' });
    await expect
      .poll(() => lookingAt(win, farm.point('F01')), { timeout: 15_000 })
      .toBeLessThan(0.5);
  });

  test('another project: an empty conversation, no chip, and its own assets', async () => {
    // both chips on, the column open on Media
    await ask(win, `findings of the tank #tool show_issues {"where":"${AREA}"}`);
    await expect(win.getByTestId('issue-scope-chip')).toHaveText(`On ${AREA}`);
    await ask(win, `photos of the tank #tool show_photos {"where":"${AREA}"}`);
    await onScreen(win, 'media');
    await expect(win.getByTestId('media-scope-chip')).toHaveText(`On ${AREA}`);
    await expect(dock(win)).toBeVisible();
    const before = await appState(win);
    expect(before.media.scope?.label).toBe(`On ${AREA}`);
    expect(before.issues.scope?.label).toBe(`On ${AREA}`);
    expect(await requests(win).count()).toBeGreaterThan(0);

    await openChangeDemo(win);
    const now = await appState(win);
    expect(now.project).toBe(CHANGE_DEMO.id);
    expect(now.media).toMatchObject({ scope: null, severity: null });
    expect(now.issues).toMatchObject({ scope: null, sev: null, text: '' });
    expect(now.evidence).toBeNull();
    // a fresh conversation, wherever the panel is
    await expect(agent(win)).toBeVisible();
    await expect(agent(win).locator('.ag-msg')).toHaveCount(0);

    // the bounds of this project's assets are measured while its model shows
    const change = demoManifest(CHANGE_DEMO.id);
    const tags = change.layers.flatMap((l) => (l.kind === 'mesh' ? (l.tags ?? []) : []));
    const tank = tags.find((t) => t.tag === 'T-201');
    if (!tank) throw new Error('the change demo has no asset T-201');
    await visitScene(win, tank.node, SCENE_VISIT_MS);
    await expect(win.getByTestId('media-scope-chip')).toHaveCount(0);
    await expect(dock(win)).toBeVisible();
    await expect(agent(win).locator('.ag-msg')).toHaveCount(0);

    // an area of the tank farm is no place here: nothing of the old project answers. The first
    // question about an asset also waits for the bounds measured while Scene showed the model
    const old = await askOnMediaOnceMeasured(
      win,
      tank.node,
      `photos of the old tank #tool show_photos {"where":"${AREA}"}`,
    );
    expect(old).toContain('No place matches');
    expect(old).not.toContain(`On ${AREA}`);
    await expect(win.getByTestId('media-scope-chip').filter({ hasText: AREA })).toHaveCount(0);
    const areas = await ask(win, 'which areas #tool list_assets {"by":"area"}');
    const areasHere = [...new Set(tags.flatMap((t) => (t.area ? [t.area] : [])))];
    expect(areasHere.some((a) => areas.includes(`"name":"${a}"`))).toBe(true);
    for (const gone of [AREA, 'Tank T-102', 'Pipe rack', 'Bund'])
      expect(areas).not.toContain(`"name":"${gone}"`);

    // an asset of this project, asked on Media: its own findings
    const reply = await ask(win, 'findings on T-201 #tool show_issues {"where":"T-201"}');
    await onScreen(win, 'issues');
    await expect(win.getByTestId('issue-scope-chip')).toHaveText('On T-201');
    const shown = shownIn(reply);
    expect(shown).toBeGreaterThan(0);
    await expect(issueRows(win)).toHaveCount(shown);
    for (const title of await issueRows(win).locator('.it').allInnerTexts())
      expect(title).toContain('T-201');
  });
});

test.describe('the agent column in the smallest window', () => {
  let run: Run;

  test.afterEach(async () => {
    await stop(run);
  });

  /** The title bar, measured as connection.spec.ts measures it, with the Agent chip in it. */
  const titleBar = (win: Page) =>
    win.evaluate(() => {
      const box = (sel: string) => document.querySelector(sel)?.getBoundingClientRect();
      const bar = document.querySelector('.titlebar');
      const pad = bar ? parseFloat(getComputedStyle(bar).paddingRight) : 0;
      const search = box('.search-btn');
      const help = box('.help-btn');
      const status = box('.tb-status');
      const chip = box('[data-testid="agent-toggle"]');
      return {
        // where the window's own buttons begin
        room: window.innerWidth - pad,
        statusRight: status?.right ?? 0,
        searchWidth: search?.width ?? 0,
        searchBeforeHelp: (search?.right ?? 0) <= (help?.left ?? 0),
        helpBeforeStatus: (help?.right ?? 0) <= (status?.left ?? 0),
        sideways: document.documentElement.scrollWidth > window.innerWidth,
        chip: chip
          ? { left: chip.left, right: chip.right, top: chip.top, bottom: chip.bottom }
          : null,
        height: window.innerHeight,
      };
    });

  /**
   * The Agent chip as drawn, and the last breadcrumb (the name of the screen) with how much of it
   * its row cuts off.
   */
  const chipAndCrumb = (win: Page) =>
    win.evaluate(() => {
      const chip = document.querySelector('[data-testid="agent-toggle"]');
      const label = chip?.querySelector('.lbl')?.getBoundingClientRect();
      const crumbs = document.querySelector('.crumbs');
      const last = crumbs?.querySelector('b');
      const row = crumbs?.getBoundingClientRect();
      const name = last?.getBoundingClientRect();
      return {
        width: window.innerWidth,
        chipWidth: chip?.getBoundingClientRect().width ?? 0,
        // the label is in the button at every width; drawn in a pixel it shows nothing
        labelWidth: label?.width ?? 0,
        icon: chip?.querySelector('svg')?.getBoundingClientRect().width ?? 0,
        crumb: last?.textContent ?? '',
        crumbCut: row && name ? Math.max(0, name.right - row.right, row.left - name.left) : -1,
        crumbEllipsis: last ? getComputedStyle(last).textOverflow === 'ellipsis' : false,
      };
    });

  /**
   * Below 1280 px the chip is its icon alone, still named "Agent", and the breadcrumbs keep the
   * name of the screen: whole, or ending in an ellipsis, never cut mid letter.
   */
  async function expectNarrowChip(win: Page, screen?: string) {
    await expect(toggle(win)).toHaveAccessibleName('Agent');
    await expect(toggle(win)).toHaveAttribute('title', 'Show or hide the agent');
    await expect(toggle(win)).toHaveAttribute('aria-controls', 'agent-dock');
    const now = await chipAndCrumb(win);
    expect(now.width).toBeLessThan(1280);
    expect(now.labelWidth).toBeLessThanOrEqual(1);
    expect(now.icon).toBeGreaterThanOrEqual(12);
    expect(now.chipWidth).toBeLessThanOrEqual(32);
    if (screen === undefined) return;
    expect(now.crumb).toBe(screen);
    if (!now.crumbEllipsis) expect(now.crumbCut, `"${screen}" is cut off`).toBeLessThanOrEqual(0.5);
  }

  /**
   * Give the page an exact width (as connection.spec.ts does for its smallest window): the window
   * itself lands some pixels off the size asked for on a scaled display, and the chip changes at
   * one exact width.
   */
  async function setWidth(win: Page, width: number) {
    await win.setViewportSize({ width, height: 700 });
    await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(width);
  }

  async function expectTitleBarFits(win: Page, screen?: string) {
    if ((await win.evaluate(() => innerWidth)) < 1280) await expectNarrowChip(win, screen);
    const bar = await titleBar(win);
    expect(bar.statusRight).toBeLessThanOrEqual(bar.room + 0.5);
    expect(bar.searchWidth).toBeGreaterThanOrEqual(140);
    expect(bar.searchBeforeHelp).toBe(true);
    expect(bar.helpBeforeStatus).toBe(true);
    expect(bar.sideways).toBe(false);
    // the Agent chip is whole, left of the window's own buttons
    expect(bar.chip).not.toBeNull();
    expect(bar.chip?.left ?? -1).toBeGreaterThanOrEqual(0);
    expect(bar.chip?.right ?? Infinity).toBeLessThanOrEqual(bar.room + 0.5);
    expect(bar.chip?.top ?? -1).toBeGreaterThanOrEqual(0);
    expect(bar.chip?.bottom ?? Infinity).toBeLessThanOrEqual(bar.height);
    // and a click on it reaches it
    const reached = await toggle(win).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit !== null && el.contains(hit);
    });
    expect(reached).toBe(true);
  }

  /** The column takes at most a third of the window, and nothing scrolls sideways. */
  async function expectRoom(win: Page) {
    const m = await win.evaluate(() => {
      const column = document.querySelector('#agent-dock')?.getBoundingClientRect();
      const screen = document.querySelector('.main > .screen')?.getBoundingClientRect();
      return {
        scrollWidth: document.documentElement.scrollWidth,
        width: window.innerWidth,
        column: column ? { left: column.left, right: column.right, width: column.width } : null,
        screenRight: screen?.right ?? 0,
      };
    });
    expect(m.scrollWidth).toBeLessThanOrEqual(m.width);
    expect(m.column).not.toBeNull();
    expect(m.column?.width ?? Infinity).toBeLessThanOrEqual(m.width / 3 + 0.5);
    expect(m.column?.right ?? Infinity).toBeLessThanOrEqual(m.width + 0.5);
    // the screen ends where the column begins: nothing of it lies under the column
    expect(m.screenRight).toBeLessThanOrEqual((m.column?.left ?? 0) + 0.5);
  }

  /** Run a command of the command search by its exact title (as connection.spec.ts does). */
  async function command(win: Page, title: string) {
    await win.keyboard.press('Control+K');
    const palette = win.getByRole('dialog', { name: 'Command search' });
    await expect(palette).toBeVisible();
    await win.keyboard.type(title);
    await expect(palette.getByRole('option').first()).toHaveText(new RegExp(`^${title}`));
    await win.keyboard.press('Enter');
    await expect(palette).toBeHidden();
  }

  /** Every one of `parts` lies whole inside the screen beside the column, at least `min` wide. */
  async function expectInside(win: Page, parts: Record<string, string>, min: number) {
    const boxes = await win.evaluate((sel) => {
      const edge = document.querySelector('#agent-dock')?.getBoundingClientRect().left ?? 0;
      return Object.entries(sel).map(([name, s]) => {
        const r = document.querySelector(s)?.getBoundingClientRect();
        return { name, found: Boolean(r), left: r?.left ?? 0, right: r?.right ?? 0, edge };
      });
    }, parts);
    for (const b of boxes) {
      expect(b.found, `${b.name} is on the screen`).toBe(true);
      expect(b.right - b.left, `${b.name} is wide enough`).toBeGreaterThanOrEqual(min);
      expect(b.left, `${b.name} starts in the window`).toBeGreaterThanOrEqual(0);
      expect(b.right, `${b.name} ends before the column`).toBeLessThanOrEqual(b.edge + 0.5);
    }
  }

  test('Media, Issues, Detections and Reports stay usable beside the open column, and the title bar fits', async () => {
    run = await start({ QUADRION_WINDOW_SIZE: '1100x700' });
    const { win } = run;
    // the window is the smallest one (within a pixel or two: display scaling rounds)
    const [w, h] = await win.evaluate(() => [innerWidth, innerHeight]);
    expect(Math.abs(w - 1100), `window width ${String(w)}`).toBeLessThanOrEqual(2);
    expect(Math.abs(h - 700), `window height ${String(h)}`).toBeLessThanOrEqual(2);

    // Media: folded first (nothing moves for people who do not use the agent), then open
    await goTo(win, 'Media');
    await expect(dock(win)).toBeHidden();
    await expect(photoCards(win).first()).toBeVisible();
    await expectTitleBarFits(win, 'Media');
    await unfold(win);
    await expectTitleBarFits(win, 'Media');
    await expectRoom(win);
    expect(await sidewaysScrollers(win)).toEqual([]);
    const card = await photoCards(win).first().boundingBox();
    expect(card?.width ?? 0).toBeGreaterThanOrEqual(120);
    await expectInside(
      win,
      { 'the first photo': '.media-main .m-card.sq[data-photo]', 'the filters': '.m-tools' },
      120,
    );
    await shot(win, 'agent-show-08-small-media');

    // with a photo open in the viewer beside the list: three panes
    await photoCards(win).first().click();
    await expect(win.locator('.media.with-viewer')).toBeVisible();
    await expectRoom(win);
    await expectTitleBarFits(win, 'Media');
    const list = await mediaOverflow(win);
    expect(list.out, `the Media list is ${String(list.width)} px wide`).toEqual([]);
    expect(await sidewaysScrollers(win)).toEqual([]);
    expect((await photoCards(win).first().boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(120);
    await shot(win, 'agent-show-08-small-media-viewer');

    // Issues: the list, then the card of a finding beside it
    await goTo(win, 'Issues');
    await expect(dock(win)).toBeVisible();
    await expect(issueRows(win).first()).toBeVisible();
    await expectRoom(win);
    await expectTitleBarFits(win, 'Issues');
    await expectInside(
      win,
      { 'the first finding': '.issues-screen [data-issue-list] .ann-row' },
      200,
    );
    expect(await sidewaysScrollers(win)).toEqual([]);
    await shot(win, 'agent-show-08-small-issues');
    await issueRows(win).first().click();
    await expect(win.locator('.issues-screen .ic-body')).toBeVisible();
    await expect(win.locator('.issues-screen .ic-video .btn').first()).toBeVisible();
    expect(await sidewaysScrollers(win)).toEqual([]);
    await expectRoom(win);
    await shot(win, 'agent-show-08-small-issues-card');

    // Media with that finding's card in the viewer, as after "show the photos" on a finding
    await goTo(win, 'Media');
    await expect(win.locator('.media.with-viewer .ic-body')).toBeVisible();
    expect(await sidewaysScrollers(win)).toEqual([]);
    expect((await mediaOverflow(win)).out).toEqual([]);

    // Detections
    await goTo(win, 'Detections');
    await expect(dock(win)).toBeVisible();
    await expectRoom(win);
    await expectTitleBarFits(win, 'Detections');
    await expectInside(win, { 'the detections screen': '.det-body' }, 400);
    expect(await sidewaysScrollers(win)).toEqual([]);
    await shot(win, 'agent-show-08-small-detections');

    // Reports: the controls keep their width, the preview has what is left
    await goTo(win, 'Reports');
    await expect(dock(win)).toBeVisible();
    await expect(win.locator('.rep-side-in')).toBeVisible();
    await expectRoom(win);
    await expectTitleBarFits(win, 'Reports');
    await expectInside(
      win,
      { 'the report controls': '.rep-side', 'the preview': '.rep-view' },
      150,
    );
    expect(await sidewaysScrollers(win)).toEqual([]);
    await shot(win, 'agent-show-08-small-reports');

    // the connection pair in its longest wording, "Offline only" and "Cloud AI blocked", beside
    // the Agent chip, the Processing chip and the project's Share chip
    await command(win, 'Turn cloud AI on');
    await command(win, 'Work offline only');
    await expect(win.getByTestId('connection-chip')).toHaveText('Offline only');
    await expect(win.getByTestId('cloud-chip')).toHaveText('Cloud AI blocked');
    await expect(win.getByTestId('sync-chip')).toBeVisible();
    await expect(dock(win)).toBeVisible();
    await expectTitleBarFits(win);
    await shot(win, 'agent-show-08-small-longest-title-bar');

    // folded again, the title bar still fits and the screen has the whole width
    await fold(win);
    await expectTitleBarFits(win);
    expect(await sidewaysScrollers(win)).toEqual([]);
    expect(
      await win.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    // from 1280 px the chip reads "Agent" beside its icon
    await setWidth(win, 1280);
    await expect(toggle(win)).toHaveText('Agent');
    await expect(toggle(win)).toHaveAccessibleName('Agent');
    const wide = await chipAndCrumb(win);
    expect(wide.labelWidth).toBeGreaterThan(20);
    expect(wide.chipWidth).toBeGreaterThan(50);
    expect(wide.crumb).toBe('Reports');
    await expectTitleBarFits(win);
    await shot(win, 'agent-show-09-chip-at-1280');
    // and one pixel narrower it is the icon again
    await setWidth(win, 1279);
    await expectNarrowChip(win);
  });
});
