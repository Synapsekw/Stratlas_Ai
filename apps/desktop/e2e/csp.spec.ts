import { join } from 'node:path';
import { APP_CSP } from '../src/main/csp';
import { createTwoDateProject, expect, launchApp, test } from './fixtures';

/**
 * The built pages load from file://, where main's CSP header never applies; the build writes the
 * app policy into each page as a <meta> (src/main/csp.ts, electron.vite.config.ts `cspMeta`).
 */

const RENDERER = join(import.meta.dirname, '../out/renderer');

interface Probe {
  url: string;
  meta: string | null;
  /** What `eval('1')` and `new Function` did: 'allowed' or the error. */
  eval: string;
  fn: string;
  /** Whether an injected inline script ran. */
  inline: boolean;
  /**
   * `securitypolicyviolation` events the probe raised, distinct (Chromium dispatches each one
   * twice), and the policies that raised them.
   */
  violations: string[];
  policies: string[];
}

/**
 * Run in the page by main's `webContents.executeJavaScript`, like page code. Not through
 * Playwright's `page.evaluate`: DevTools evaluation is exempt from a page's eval policy
 * (CDP `allowUnsafeEvalBlockedByCSP` defaults to true), so `eval` would pass there.
 */
const PROBE = `(async () => {
  const violations = [];
  const policies = [];
  const seen = (e) => {
    violations.push(e.disposition + ' ' + e.effectiveDirective + ' ' + e.blockedURI);
    policies.push(e.originalPolicy);
  };
  document.addEventListener('securitypolicyviolation', seen);
  const run = (f) => {
    try { f(); return 'allowed'; } catch (e) { return e.name + ': ' + e.message; }
  };
  const result = {
    url: location.href,
    meta:
      document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? null,
    eval: run(() => eval('1')),
    fn: run(() => new Function('return 1')),
  };
  const s = document.createElement('script');
  s.textContent = 'window.__cspInline = true;';
  document.head.append(s);
  s.remove();
  await new Promise((r) => setTimeout(r, 100));
  document.removeEventListener('securitypolicyviolation', seen);
  return {
    ...result,
    inline: window.__cspInline === true,
    violations: [...new Set(violations)],
    policies: [...new Set(policies)],
  };
})()`;

const REFUSED = /^EvalError: .*Content Security Policy/;

function expectEnforced(probe: Probe, page: string): void {
  expect(probe.url, page).toMatch(/^file:/);
  expect(probe.meta, page).toBe(APP_CSP);
  expect(probe.eval, page).toMatch(REFUSED);
  expect(probe.fn, page).toMatch(REFUSED);
  expect(probe.inline, page).toBe(false);
  expect(probe.violations, page).toEqual([
    'enforce script-src eval',
    'enforce script-src-elem inline',
  ]);
  // the meta is the one policy in force
  expect(probe.policies, page).toEqual([APP_CSP]);
}

test('the main window enforces the app policy: no eval, no inline script', async ({ app, win }) => {
  await expect(win.locator('.wordmark')).toBeVisible();
  const probe = await app.evaluate(async ({ BrowserWindow }, script) => {
    const main = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().endsWith('/renderer/index.html'),
    );
    if (!main) throw new Error('no main window');
    return (await main.webContents.executeJavaScript(script)) as Probe;
  }, PROBE);
  expectEnforced(probe, 'index.html');
});

test('the report and guide pages carry the same policy', async ({ app }) => {
  for (const page of ['report.html', 'house.html', 'guide.html']) {
    const probe = await app.evaluate(
      async ({ BrowserWindow }, { file, script }) => {
        // hidden, never shown: the report windows print the same way (exports/reportWindow.ts)
        const w = new BrowserWindow({
          show: false,
          webPreferences: { sandbox: true, contextIsolation: true },
        });
        try {
          await w.loadFile(file);
          return (await w.webContents.executeJavaScript(script)) as Probe;
        } finally {
          w.destroy();
        }
      },
      { file: join(RENDERER, page), script: PROBE },
    );
    expectEnforced(probe, page);
  }
});

test('the 3D scene and the map run under the policy without a violation', async ({
  dataRoot,
  network,
}) => {
  await createTwoDateProject(dataRoot);
  const app = await launchApp(dataRoot);
  await network.attach(app);
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    const refused: string[] = [];
    win.on('console', (m) => {
      if (/Content Security Policy/i.test(m.text())) refused.push(m.text());
    });
    await win.evaluate(() => {
      const w = window as { __cspSeen?: string[] };
      w.__cspSeen = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        w.__cspSeen?.push(`${e.effectiveDirective} ${e.blockedURI} ${e.sourceFile}`);
      });
    });

    await win.getByTestId('project-card').filter({ hasText: 'E2E two dates' }).first().click();
    await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
    const gl = await win.evaluate(() => {
      const c = document.querySelector('[data-scene-view] canvas');
      if (!(c instanceof HTMLCanvasElement)) return false;
      return (c.getContext('webgl2') ?? c.getContext('webgl')) !== null;
    });
    expect(gl).toBe(true);

    const bar = win.getByRole('toolbar', { name: 'Stage tools' });
    await bar.getByRole('button', { name: 'Map' }).click();
    await expect(win.locator('.maplibregl-canvas').first()).toBeVisible();
    // loaded: the style and the vector sources went through MapLibre's workers
    await expect
      .poll(
        () =>
          win.evaluate(() => {
            const host = [...document.querySelectorAll('div')].find((d) => '__aioMap' in d) as
              (HTMLElement & { __aioMap: { loaded(): boolean } }) | undefined;
            return host?.__aioMap.loaded() ?? false;
          }),
        { timeout: 20_000 },
      )
      .toBe(true);
    await bar.getByRole('button', { name: '3D' }).click();
    await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();

    expect(await win.evaluate(() => (window as { __cspSeen?: string[] }).__cspSeen)).toEqual([]);
    expect(refused).toEqual([]);
  } finally {
    await app.close();
  }
});
