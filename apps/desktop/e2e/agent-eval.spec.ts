/**
 * The real-model check: about 20 plain requests typed into the agent panel of the tank farm demo,
 * answered by the real model of the app's default chat route. Every other agent spec runs the
 * scripted stand-in, which proves the plumbing and nothing about what a model makes of "Take me
 * to the most severe point on this asset". This one does, by hand, when the team chooses to.
 *
 * How to run it, from apps/desktop, with the demos built (`pnpm demo:build --quick` at the repo
 * root) and the app built (`pnpm build`). The key is never typed on a command line, where the
 * shell's history would keep it: copy it, then
 *
 *   PowerShell:  $env:QUADRION_EVAL_ANTHROPIC_KEY = Get-Clipboard
 *                npx playwright test e2e/agent-eval.spec.ts --workers=1
 *                Remove-Item Env:QUADRION_EVAL_ANTHROPIC_KEY
 *   bash:        read -rs QUADRION_EVAL_ANTHROPIC_KEY; export QUADRION_EVAL_ANTHROPIC_KEY
 *                npx playwright test e2e/agent-eval.spec.ts --workers=1
 *                unset QUADRION_EVAL_ANTHROPIC_KEY
 *
 * (in bash, paste the key after the first line and press Enter: nothing is shown). Run it with
 * the list reporter of the config and nothing else: a blob report, UI mode or DEBUG=pw:protocol
 * can carry the parameters of a step in full, the key among them.
 *
 * A key that is not scoped to a workspace also needs QUADRION_EVAL_ANTHROPIC_WORKSPACE (the
 * workspace ID, as in Settings, AI providers). ANTHROPIC_BASE_URL must not be set: the run stops
 * before it starts when it is. Without QUADRION_EVAL_ANTHROPIC_KEY every test here is skipped.
 *
 * What it costs: tokens on that key. Each request is two to four calls to the model, each with
 * the instructions, the tool list and the window context, so a run is in the order of half a
 * million input tokens: roughly one to two US dollars on the default model at the prices of
 * October 2026. The run ends with the tokens and the estimated cost the panel's own meter counted.
 *
 * A rate-limited run is not a verdict. The requests follow each other closely, and a key on a low
 * usage tier can meet the provider's limit per minute. A request the provider refuses for its
 * rate limit or for being overloaded (HTTP 429, 529) is asked once more after a minute; when it
 * is refused again it is listed as a provider error and left out of the percentage. When more
 * than a quarter of the requests end that way, the run says so and fails for that reason alone.
 *
 * What it sends to the provider: the requests below and the text context of the demo project (its
 * layers, assets, findings and site summary, and what the tools return). The demo is synthetic.
 * No frame, photo or file is sent and nothing is written: a step that would send imagery or write
 * data asks for approval, and this check rejects it.
 *
 * Where the key goes: it is read from the environment variable, here and nowhere else, and handed
 * to the app through `ai:setKey`, which in an e2e profile keeps it in the TEST-ONLY vault file of
 * this run's throwaway profile (main/testVault.ts), never in the OS vault. When the test ends,
 * passed or failed, the key is overwritten there and the profile is deleted. When the run is cut
 * short instead (Ctrl+C, the test's time limit), only the vault file is deleted, as the runner
 * exits, and the rest of the profile stays. A runner that is killed outright deletes nothing:
 * after any run that did not end by itself, delete the `aio-e2e-*` folders in the temp directory
 * (`$env:TEMP` on Windows, `$TMPDIR` or /tmp elsewhere). The key is never printed, and no key is
 * read from Settings, the OS vault or the repository.
 *
 * Never add this to CI. It needs a paid key and the internet, and CI has neither by design; the
 * skip without the variable is what lets every CI shard pass over this file.
 *
 * One test, so the requests run one after the other in one app: each starts from a new
 * conversation on Scene with nothing selected and no filter set. The table at the end lists every
 * request with pass or the reason, the tools that ran and the start of the reply. The test fails
 * when fewer than 90 percent of the requests the provider answered pass.
 */
import { defaultRoutes, routeFor } from '@aio/ai/routes';
import type { ElectronApplication, Page } from '@playwright/test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  checkDemo,
  evalCases,
  type DemoFacts,
  type EvalCase,
  type EvalLevel,
  type EvalState,
} from './agent-eval.cases';
import {
  ALLOWED_PROTOCOLS,
  createDataRoot,
  DEMO_FOLDER,
  expect,
  launchApp,
  test,
} from './fixtures';
import { openDemo } from './surveyJobs';

// a variable that holds only blanks is no key
test.skip(
  !process.env.QUADRION_EVAL_ANTHROPIC_KEY?.trim(),
  'Real-model check: set QUADRION_EVAL_ANTHROPIC_KEY to run it. It spends tokens.',
);

// Said a second time on purpose: no shard of CI runs this, whatever its secrets hold.
test.skip(
  Boolean(process.env.CI),
  'Real-model check: never in CI. It needs a paid key and the internet.',
);

const TANK_FARM = { id: 'demo-tank-farm', name: 'Demo tank farm' };
const hasTankFarm = () => existsSync(join(DEMO_FOLDER, TANK_FARM.id, 'manifest.json'));
test.skip(!hasTankFarm(), `no demo in ${DEMO_FOLDER}: run pnpm demo:build --quick`);

/** The share of the requests the provider answered that must do what was asked. */
const PASS_PERCENT = 90;
/** Launching, the connection test, opening the demo and loading its model. */
const SETUP_MS = 5 * 60_000;
/** A real model with several tool steps can take a minute; three is a reply that will not come. */
const REPLY_MS = 180_000;
/** The wait before a request the provider refused for its rate limit is asked once more. */
const PROVIDER_PAUSE_MS = 60_000;
/** With more than this share of the requests refused by the provider, the run is no verdict. */
const PROVIDER_ERROR_PERCENT = 25;
/** Going back to Scene mounts the 3D view again: on a slow GPU that takes more than a moment. */
const SCREEN_MS = 30_000;
/** How long a screen that is still drawing its list gets before a failure is accepted. */
const SETTLE_MS = 5_000;

/** The key this check stores is an Anthropic key, so the chat route has to be Anthropic's. */
const KEY_PROVIDER = 'anthropic';
/**
 * The one address outside this machine that `fetch` in the main process reaches in this spec.
 * The key is only ever sent here: `fetch` to any other address stays behind the zero-network
 * guard (see `openProviderDoor` for what that guard does and does not hold).
 */
const PROVIDER_ORIGIN = 'https://api.anthropic.com';

/** The file the e2e profile keeps keys in (main/testVault.ts). Its content is never read here. */
const TEST_VAULT_FILE = 'TEST-ONLY-vault.json';

/** The agent panel, wherever it is: the Scene's right panel or the column of the other screens. */
const PANEL = 'section.aio-agent';

/** The Inspect photo and Issues filters as a project starts (DEFAULT_MEDIA_VIEW, DEFAULT_ISSUE_VIEW). */
const NO_MEDIA_FILTER = {
  onlyFindings: false,
  order: 'file',
  severity: null,
  scope: null,
  toReview: false,
};
const NO_ISSUE_FILTER = {
  text: '',
  sev: null,
  classId: '',
  status: '',
  dataset: '',
  sort: 'code',
  dir: 'asc',
  groupBy: 'none',
  scope: null,
};

interface DemoManifest {
  severityModels: { levels: { value: number; label: string }[] }[];
  layers: {
    kind: string;
    id: string;
    items?: { id: string }[];
    tags?: { node: string; tag: string; area?: string }[];
  }[];
}

interface DemoIssue {
  code: string;
  severity: EvalLevel;
  status: string;
  sightings: { on: string; photo?: string }[];
}

const demoFile = (file: string): unknown =>
  JSON.parse(readFileSync(join(DEMO_FOLDER, TANK_FARM.id, file), 'utf8'));

/** The tank farm as it is on disk: what the cases work their expectations out from. */
function tankFarm() {
  const manifest = demoFile('manifest.json') as DemoManifest;
  const issues = (demoFile('issues.json') as { issues: DemoIssue[] }).issues;
  const tags = manifest.layers.flatMap((l) =>
    l.kind === 'mesh' ? (l.tags ?? []).map((t) => ({ ...t, layer: l.id })) : [],
  );
  const facts: DemoFacts = {
    levels: manifest.severityModels
      .flatMap((m) => m.levels.map((l) => ({ value: l.value, label: l.label })))
      .sort((a, b) => a.value - b.value),
    findings: issues.map((i) => ({
      code: i.code,
      severity: i.severity,
      status: i.status,
      photos: [
        ...new Set(i.sightings.flatMap((s) => (s.on === 'image' && s.photo ? [s.photo] : []))),
      ],
      placed: i.sightings.some((s) => s.on === 'mesh'),
    })),
    photos: manifest.layers.flatMap((l) =>
      l.kind === 'photos' ? (l.items ?? []).map((p) => p.id) : [],
    ),
    assets: tags.map((t) => ({ tag: t.tag, area: t.area ?? null })),
  };
  return {
    facts,
    /** A tagged asset as a click on it in the 3D view selects it: the model node, with its layer. */
    asset: (tag: string) => {
      const found = tags.find((t) => t.tag === tag);
      if (!found) throw new Error(`the demo has no asset "${tag}"`);
      return { kind: 'asset', id: found.node, layer: found.layer };
    },
    /** The nodes of the main model: the bounds of the tagged assets are measured on them. */
    nodes: tags.filter((t) => t.layer === 'model').map((t) => t.node),
  };
}

interface Picked {
  kind: string;
  id: string;
  layer?: string;
}

interface Scope {
  label: string;
  ids: readonly string[];
}

/** `window.__stratlas`, the inspection hook of the renderer (bootstrap.ts), as far as read here. */
interface Probe {
  __stratlas: {
    workspace: {
      getState(): {
        selection: Picked | null;
        issues: { id: string; code: string }[];
        select(selection: Picked | null): void;
      };
    };
    stage(): { scene: { getObjectByName(n: string): unknown } } | null;
    shell: {
      getState(): {
        screen: string;
        stageMode: string;
        go(screen: string): void;
        setStageMode(mode: string): void;
        setRight(collapsed: boolean): void;
        setAgentDock(collapsed: boolean): void;
      };
    };
    mediaView: {
      getState(): {
        onlyFindings: boolean;
        order: string;
        severity: EvalLevel | null;
        scope: Scope | null;
      };
      setState(view: typeof NO_MEDIA_FILTER): void;
    };
    issueView: {
      getState(): {
        text: string;
        sev: EvalLevel | null;
        classId: string;
        status: string;
        sort: string;
        dir: string;
        scope: Scope | null;
      };
      setState(view: typeof NO_ISSUE_FILTER): void;
    };
    evidence: {
      getState(): { open: { issueId: string } | null };
      setState(state: { open: null }): void;
    };
  };
}

const agent = (win: Page) => win.getByRole('region', { name: 'Agent' });

const onScreen = (win: Page, screen: string) =>
  expect(win.locator(`.app[data-screen="${screen}"]`)).toBeVisible({ timeout: SCREEN_MS });

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

interface PanelRead {
  /** Requests in the conversation. */
  asked: number;
  /** A reply is under way. */
  busy: boolean;
  /** Every tool call of the conversation with how it ended (done, error, rejected, ...). */
  steps: { name: string; status: string }[];
  /** The text of the last reply, without its steps. */
  reply: string;
  /** Why the last reply failed, or empty. */
  error: string;
}

/**
 * The conversation as the panel shows it. Read from the page, not through roles: the panel may
 * be in a folded column, and for a moment in no screen at all while the agent changes screen.
 */
const readPanel = (win: Page) =>
  win.evaluate((sel): PanelRead => {
    const panel = document.querySelector(sel);
    const last = [...(panel?.querySelectorAll('.ag-msg:not(.user)') ?? [])].at(-1);
    return {
      asked: panel?.querySelectorAll('.ag-msg.user').length ?? 0,
      busy: panel?.querySelector('.ag-log')?.getAttribute('aria-busy') === 'true',
      steps: [...(panel?.querySelectorAll('.step') ?? [])].map((el) => ({
        name: el.querySelector('code')?.textContent ?? '',
        status: el.className.replace(/\bstep\b/, '').trim(),
      })),
      // a reply is its text and its steps side by side: the text is the spans
      reply: [...(last?.children ?? [])]
        .filter((el) => el.tagName === 'SPAN' && !el.classList.contains('typing'))
        .map((el) => el.textContent)
        .join('')
        .trim(),
      error: last?.querySelector('.ag-err')?.textContent ?? '',
    };
  }, PANEL);

/** What the app shows now: the part of `EvalState` that is not the conversation. */
const appState = (win: Page) =>
  win.evaluate((): Omit<EvalState, 'toolCalls' | 'reply'> => {
    const s = (window as unknown as Probe).__stratlas;
    const ws = s.workspace.getState();
    const screen = s.shell.getState().screen;
    const media = s.mediaView.getState();
    const issues = s.issueView.getState();
    const code = (id: string) => ws.issues.find((i) => i.id === id)?.code ?? id;
    // a photo's key is `<layer>/<photo>` (photoKey in screens/mediaFindings.ts)
    const photo = (key: string) => key.slice(key.lastIndexOf('/') + 1);
    const texts = (selector: string) =>
      [...document.querySelectorAll(selector)].map((el) => el.textContent.trim());
    const sel = ws.selection;
    return {
      screen,
      selection: sel
        ? {
            kind: sel.kind,
            id: sel.id,
            code:
              sel.kind === 'issue' ? (ws.issues.find((i) => i.id === sel.id)?.code ?? null) : null,
          }
        : null,
      media: {
        onlyFindings: media.onlyFindings,
        order: media.order,
        severity: media.severity,
        scope: media.scope
          ? { label: media.scope.label, photos: media.scope.ids.map(photo) }
          : null,
        shown:
          screen === 'inspect'
            ? [
                ...document.querySelectorAll(
                  '[data-testid="inspect-photos"] button.m-card.sq[data-photo]',
                ),
              ].map((el) => el.getAttribute('data-photo') ?? '')
            : null,
      },
      issues: {
        severity: issues.sev,
        classId: issues.classId,
        status: issues.status,
        text: issues.text,
        sort: issues.sort,
        dir: issues.dir,
        scope: issues.scope
          ? { label: issues.scope.label, codes: issues.scope.ids.map(code) }
          : null,
        shown: screen === 'issues' ? texts('.issues-screen [data-issue-list] .ann-row .iid') : null,
      },
      evidenceOpen: s.evidence.getState().open !== null,
    };
  });

/** The project as it opened: what every request starts from. */
interface Home {
  /** The stage mode (3D, map, split). */
  mode: string;
  /** The nodes of the main model. */
  nodes: string[];
}

/**
 * A known start for a request: a new conversation, Scene (or the screen the case is typed on),
 * the photo beside the 3D view closed, no filter in Inspect or Issues, and nothing selected unless
 * the case selects an asset. Whatever the request before left behind is gone.
 */
async function knownState(win: Page, c: EvalCase, home: Home, selection: Picked | null) {
  await win.evaluate(() => {
    const sh = (window as unknown as Probe).__stratlas.shell.getState();
    sh.go('scene');
    sh.setRight(false);
  });
  await onScreen(win, 'scene');

  // New conversation also stops a reply that is still running
  const fresh = agent(win).getByRole('button', { name: 'New conversation' });
  await expect(fresh).toBeVisible({ timeout: SCREEN_MS });
  if (await fresh.isEnabled()) await fresh.click();
  await expect(win.locator(`${PANEL} .ag-msg`)).toHaveCount(0, { timeout: SCREEN_MS });

  // the photo beside the 3D view closes by its x, as a person closes it: the stage goes back too
  const evidenceOpen = () =>
    win.evaluate(() => (window as unknown as Probe).__stratlas.evidence.getState().open !== null);
  if (await evidenceOpen()) {
    await win
      .getByTestId('evidence-close')
      .first()
      .click({ timeout: 10_000 })
      .catch(() => undefined);
  }

  await win.evaluate(
    ({ stageMode, media, issues, picked }) => {
      const s = (window as unknown as Probe).__stratlas;
      // a pane the x could not reach (the stage was turned to another mode since)
      if (s.evidence.getState().open) s.evidence.setState({ open: null });
      const sh = s.shell.getState();
      if (sh.stageMode !== stageMode) sh.setStageMode(stageMode);
      s.mediaView.setState(media);
      s.issueView.setState(issues);
      s.workspace.getState().select(picked);
    },
    { stageMode: home.mode, media: NO_MEDIA_FILTER, issues: NO_ISSUE_FILTER, picked: selection },
  );
  expect(await evidenceOpen(), 'the photo beside the 3D view is closed').toBe(false);
  // back from a screen without the 3D view, the model is drawn again before anything is asked
  await waitForNodes(win, home.nodes);

  // The column of the other screens starts folded; the agent unfolds it when it brings the person
  // there. A request typed on such a screen needs it open.
  await win.evaluate((from) => {
    const sh = (window as unknown as Probe).__stratlas.shell.getState();
    sh.setAgentDock(from === null);
    if (from !== null) sh.go(from);
  }, c.from ?? null);
  await onScreen(win, c.from ?? 'scene');
}

/**
 * Type a request and wait for the whole reply. The first send in a project stops at the preview
 * of what leaves the machine; a step that asks for approval (it would write data or send a frame)
 * is rejected. False when no reply came in time.
 */
async function ask(win: Page, text: string): Promise<boolean> {
  const box = agent(win).getByRole('textbox', { name: 'Message the agent' });
  await expect(box).toBeEnabled({ timeout: 60_000 });
  await box.fill(text);
  await box.press('Enter');
  const preview = win.getByRole('dialog', { name: /Send to/ });
  const reject = win.locator(`${PANEL} .approve button`, { hasText: 'Reject' });
  return expect
    .poll(
      async () => {
        if (await preview.isVisible())
          await preview
            .getByRole('button', { name: 'Send' })
            .click()
            .catch(() => undefined);
        // dispatched, not clicked: the panel may sit in a column that is folded
        if ((await reject.count()) > 0)
          await reject
            .first()
            .dispatchEvent('click')
            .catch(() => undefined);
        const panel = await readPanel(win);
        return panel.asked > 0 && !panel.busy;
      },
      { timeout: REPLY_MS, intervals: [500] },
    )
    .toBe(true)
    .then(
      () => true,
      () => false,
    );
}

interface Outcome {
  ask: string;
  /**
   * `provider`: the provider refused the request for its rate limit or for being overloaded, the
   * second time too. That says nothing about the model, so it is neither a pass nor a fail.
   */
  result: 'pass' | 'fail' | 'provider';
  /** Why it did not pass; empty for a pass. */
  why: string;
  /** Every tool call in order; one that did not run to the end says how it ended. */
  tools: string[];
  reply: string;
  /** The case's remark for the table (whether the photo opened), or empty. */
  note: string;
}

const RESULT_LABEL: Record<Outcome['result'], string> = {
  pass: 'pass',
  fail: 'FAIL',
  provider: 'provider error',
};

/**
 * The provider refused for its rate limit or for being overloaded: the app's words for HTTP 429
 * and 529 (packages/ai/src/errors.ts), and the provider's own when it says so in mid reply.
 */
const PROVIDER_BUSY = /\(HTTP (429|529)\)|rate.?limit|overloaded/i;

/** One line of the run's log. */
const say = (line: string) => process.stdout.write(`[eval] ${line}\n`);

/** One request from a known start: what the app shows afterwards, judged by the case. */
async function attempt(
  win: Page,
  c: EvalCase,
  home: Home,
  selection: Picked | null,
): Promise<Outcome> {
  await knownState(win, c, home, selection);
  const answered = await ask(win, c.ask);
  // the screen the agent opened is drawn before it is read
  await expect
    .poll(
      () =>
        win.evaluate(
          () =>
            document.querySelector('.app')?.getAttribute('data-screen') ===
            (window as unknown as Probe).__stratlas.shell.getState().screen,
        ),
      { timeout: 15_000 },
    )
    .toBe(true)
    .catch(() => undefined);

  let panel = await readPanel(win);
  const read = async (): Promise<EvalState> => {
    panel = await readPanel(win);
    return {
      ...(await appState(win)),
      toolCalls: panel.steps.filter((s) => s.status === 'done').map((s) => s.name),
      reply: panel.reply,
    };
  };
  let state = await read();
  const error = panel.error;
  let why = !answered
    ? `no reply within ${String(REPLY_MS / 1000)} s`
    : error
      ? `the reply failed: ${error}`
      : c.expect(state);
  // A screen that is still drawing its list must not fail a request: the state is read again
  // for a few seconds before a failure of the case is accepted.
  if (answered && !error) {
    const until = Date.now() + SETTLE_MS;
    while (why !== null && Date.now() < until) {
      await win.waitForTimeout(500);
      state = await read();
      why = c.expect(state);
    }
  }
  return {
    ask: c.select ? `${c.ask} (with ${c.select} selected)` : c.ask,
    result: why === null ? 'pass' : answered && PROVIDER_BUSY.test(error) ? 'provider' : 'fail',
    why: why ?? '',
    tools: panel.steps.map((s) => (s.status === 'done' ? s.name : `${s.name} (${s.status})`)),
    reply: panel.reply,
    note: c.note?.(state) ?? '',
  };
}

/**
 * A request, asked once more after a pause when the provider refused it for its rate limit or
 * for being overloaded: from the known state again, in a new conversation. Refused a second
 * time, it stays a provider error.
 */
async function run(win: Page, c: EvalCase, home: Home, selection: Picked | null) {
  const first = await attempt(win, c, home, selection);
  if (first.result !== 'provider') return first;
  say(
    `   the provider is busy or rate limited: asking again in ${String(PROVIDER_PAUSE_MS / 1000)} s`,
  );
  await win.waitForTimeout(PROVIDER_PAUSE_MS);
  return attempt(win, c, home, selection);
}

/**
 * Let `fetch` in the main process reach the provider, and only the provider.
 *
 * `launchApp` starts the app behind the preload of the zero-network guard (network-guard.cjs),
 * which refuses and records what the main process sends through Node: `fetch`, http, https and
 * plain sockets. Its list of exceptions (AIO_NETWORK_GUARD_ALLOW) takes addresses on this machine
 * only, so it cannot be extended to a provider. For this spec alone the door is opened here
 * instead, after the launch: a `fetch` to the provider's address goes out through a network
 * session of Electron, which the preload does not hold; a `fetch` to any other address still
 * goes to the guard. The cloud providers of the app read `globalThis.fetch` on every request
 * (providers.ts), so they pick this up. Nothing else in the suite does this.
 *
 * The session is one of its own, as the app's map and update downloads have theirs
 * (`session.fromPartition(...).fetch` in main/index.ts): the default session cancels every web
 * request (hardenSession). It is kept in memory only and goes with the app.
 *
 * What is not held here: the other half of the guard (`NetworkGuard.attach` in fixtures.ts, which
 * refuses Electron's own `net` and every session's `fetch`) is not attached, because it would
 * close this door too. So a request the app made through Electron's `net` or another session
 * (map packs, updates, online satellite) would be neither refused nor recorded in this spec.
 * None of them runs by itself: each is off until the person starts it in the app, and nothing
 * here does.
 */
async function openProviderDoor(app: ElectronApplication, origin: string): Promise<void> {
  await app.evaluate(({ session }, allowed) => {
    const guarded = globalThis.fetch;
    const door = session.fromPartition('agent-eval-provider');
    const passed: string[] = [];
    Object.defineProperty(globalThis, '__aioEvalProvider', { value: passed, enumerable: false });
    globalThis.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      let target: URL | null;
      try {
        target = new URL(url);
      } catch {
        target = null;
      }
      if (target?.origin !== allowed) return guarded(input, init);
      // the address without its query: nothing of a request's content is kept
      passed.push(`${target.origin}${target.pathname}`);
      return door.fetch(input instanceof URL ? input.href : input, init);
    };
  }, origin);
}

/** Requests the door let through to the provider, and requests the guard's preload refused. */
const mainNetwork = (app: ElectronApplication) =>
  app.evaluate(() => {
    const g = globalThis as { __aioEvalProvider?: string[]; __aioNetworkLog?: string[] };
    return {
      provider: g.__aioEvalProvider?.slice() ?? [],
      refused: g.__aioNetworkLog?.slice() ?? [],
    };
  });

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
};

/** The first line of an error, without the colours Playwright puts in its messages. */
const firstLine = (e: unknown) =>
  (e instanceof Error ? e.message : String(e))
    // eslint-disable-next-line no-control-regex -- the escape character of a terminal colour.
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')[0] ?? '';

test('@eval plain requests to a real model do what was asked, nine times in ten', async () => {
  // trimmed, as the app's vault stores it: the same text is sent, stored and kept out of the log
  const key = (process.env.QUADRION_EVAL_ANTHROPIC_KEY ?? '').trim();
  const workspaceId = (process.env.QUADRION_EVAL_ANTHROPIC_WORKSPACE ?? '').trim();
  /** Nothing printed carries the key, whatever a provider or the app puts in a message. */
  const safe = (text: string) => (key ? text.split(key).join('[key]') : text);

  const farm = tankFarm();
  expect(checkDemo(farm.facts), 'the demo no longer matches what the cases pin').toEqual([]);
  const cases = evalCases(farm.facts);
  // every request twice (once more after a refusal by the provider), each with its reset
  test.setTimeout(
    SETUP_MS + cases.length * (2 * (REPLY_MS + SETTLE_MS + 60_000) + PROVIDER_PAUSE_MS),
  );

  const route = routeFor(defaultRoutes(), 'chat');
  expect(route.provider, 'the default chat route is not the provider of the key').toBe(
    KEY_PROVIDER,
  );
  // The provider's SDK sends its requests, the key with them, to this address when it is set.
  // The door below would refuse it, so the run stops here, before anything starts. Blanking it
  // for the app is no way out: the SDK takes an empty value for the address.
  expect(
    process.env.ANTHROPIC_BASE_URL === undefined,
    'ANTHROPIC_BASE_URL is set in this shell: unset it, this check only talks to the provider itself',
  ).toBe(true);

  const data = await createDataRoot();
  // The `finally` below takes the key out of the vault file. Ctrl+C and the test's time limit
  // skip it, so the file is also deleted as the runner exits, whatever ended the run.
  const vaultFile = join(data.userData, TEST_VAULT_FILE);
  const wipeVault = () => {
    try {
      rmSync(vaultFile, { force: true });
    } catch {
      // the process is ending: the header says where the leftovers are
    }
  };
  process.once('exit', wipeVault);
  const app = await launchApp(data, {
    QUADRION_DEMO: DEMO_FOLDER,
    // keys of this run go to a file of its throwaway profile, never to the OS vault
    QUADRION_TEST_VAULT: '1',
    // the real providers, whatever the shell has set
    QUADRION_AI_TEST_PROVIDER: '',
    // the app is handed the key through ai:setKey; its environment does not hold it as well
    QUADRION_EVAL_ANTHROPIC_KEY: '',
  });
  let win: Page | undefined;
  try {
    // the renderer has no business on the network at all: as in every other spec
    const fromRenderer: string[] = [];
    app.context().on('request', (req) => {
      if (!ALLOWED_PROTOCOLS.includes(new URL(req.url()).protocol)) fromRenderer.push(req.url());
    });
    await app.context().route(/^(https?|wss?|ftp):/i, (r) => r.abort('internetdisconnected'));
    win = await app.firstWindow();
    const page = win;
    await page.waitForLoadState('domcontentloaded');

    // A placeholder first: only when that landed in the throwaway vault file does the key follow.
    await page.evaluate(() =>
      window.aio.invoke('ai:setKey', { provider: 'anthropic', key: 'placeholder-not-a-key' }),
    );
    expect(
      existsSync(vaultFile),
      'keys of this run must go to the throwaway vault file, not the OS vault',
    ).toBe(true);
    const stored = await page.evaluate(
      (k) => window.aio.invoke('ai:setKey', { provider: 'anthropic', key: k }),
      key,
    );
    expect(stored.ok, 'the key was not stored in the test vault').toBe(true);

    await page.evaluate(
      (id) =>
        window.aio.invoke('settings:set', {
          cloudAi: true,
          ...(id ? { anthropicWorkspaceId: id } : {}),
        }),
      workspaceId,
    );
    const status = await page.evaluate(() => window.aio.invoke('ai:status', {}));
    expect(status.ready, safe(status.message ?? 'the agent is not ready')).toBe(true);
    expect(status.route, 'the app answers on its default chat route').toMatchObject({
      provider: route.provider,
      model: route.model,
    });

    await openProviderDoor(app, PROVIDER_ORIGIN);
    // One minimal request, as Settings, Test connection makes it: a wrong key, a missing
    // workspace ID or a closed network says so here, once, instead of in every request below.
    const tested = await page.evaluate(() =>
      window.aio.invoke('ai:testConnection', { provider: 'anthropic' }),
    );
    expect(tested.ok, `the provider did not answer: ${safe(tested.message)}`).toBe(true);
    expect(
      (await mainNetwork(app)).provider.length,
      'the connection test was answered, but not through the provider door: either a scripted ' +
        'model is switched on by a variable in this shell, or the app no longer reads ' +
        'globalThis.fetch for each request and the door has to be opened another way',
    ).toBeGreaterThan(0);
    say(`${route.model} on ${route.provider}, ${String(cases.length)} plain requests`);

    await openDemo(page, TANK_FARM.name, TANK_FARM.id);
    const hooks = await page.evaluate(() => {
      const s = (window as unknown as Probe).__stratlas as unknown as Record<string, unknown>;
      return ['workspace', 'shell', 'mediaView', 'issueView', 'evidence'].filter(
        (name) => typeof (s[name] as { getState?: unknown } | undefined)?.getState !== 'function',
      );
    });
    expect(hooks, 'window.__stratlas lacks stores this check reads').toEqual([]);
    // the bounds of the tagged assets come from the model: every asset question needs it loaded
    await waitForNodes(page, farm.nodes);
    await expect(agent(page).getByRole('textbox', { name: 'Message the agent' })).toBeEnabled({
      timeout: 60_000,
    });
    const home: Home = {
      mode: await page.evaluate(
        () => (window as unknown as Probe).__stratlas.shell.getState().stageMode,
      ),
      nodes: farm.nodes,
    };

    const outcomes: Outcome[] = [];
    for (const [i, c] of cases.entries()) {
      const selection = c.select ? farm.asset(c.select) : null;
      // a request the check could not put to the app counts as failed, and the rest still run
      const outcome = await test.step(c.ask, () =>
        run(page, c, home, selection).catch((e: unknown): Outcome => ({
          ask: c.ask,
          result: 'fail',
          why: `the check could not run it: ${firstLine(e)}`,
          tools: [],
          reply: '',
          note: '',
        })),
      );
      outcomes.push(outcome);
      say(
        `${String(i + 1).padStart(2)} of ${String(cases.length)} ${RESULT_LABEL[outcome.result]}  ${outcome.ask}`,
      );
    }

    // the meter of the project, in the panel on Scene: every request of this run is in it
    await knownState(page, { ask: '', expect: () => null }, home, null).catch(() => undefined);
    const meter = await page.evaluate((sel) => {
      const el = document.querySelector(`${sel} .ag-proj .ag-mono`);
      return el ? { shown: el.textContent, detail: el.getAttribute('title') ?? '' } : null;
    }, PANEL);

    say('');
    say(`${route.model} on ${route.provider}, the tank farm demo`);
    for (const [i, o] of outcomes.entries()) {
      say(`${String(i + 1).padStart(2)}  ${RESULT_LABEL[o.result]}  ${o.ask}`);
      if (o.why) say(`    why:   ${safe(oneLine(o.why, 300))}`);
      say(`    tools: ${o.tools.length > 0 ? o.tools.join(', ') : 'none'}`);
      if (o.note) say(`    note:  ${o.note}`);
      say(`    reply: ${safe(oneLine(o.reply, 160)) || '(no text)'}`);
    }
    // a request the provider refused twice says nothing about the model: it is not in the share
    const refused = outcomes.filter((o) => o.result === 'provider').length;
    const judged = outcomes.length - refused;
    const passed = outcomes.filter((o) => o.result === 'pass').length;
    const noVerdict = refused * 100 > outcomes.length * PROVIDER_ERROR_PERCENT;
    say('');
    say(
      judged > 0
        ? `${String(passed)} of ${String(judged)} answered requests passed (${String(Math.floor((passed * 100) / judged))} percent); the check needs ${String(PASS_PERCENT)} percent`
        : 'the provider answered no request',
    );
    if (refused > 0)
      say(
        `${String(refused)} of ${String(outcomes.length)} requests ended in a provider error (rate limit or overload) and are not counted`,
      );
    if (noVerdict)
      say(
        'this run is NOT a verdict on the model: the provider refused too many requests. Run it again later, or with a key on a higher usage tier',
      );
    say(
      meter
        ? `the panel's meter for this project: ${meter.shown} (${meter.detail})`
        : 'the panel shows no meter for this project',
    );

    const network = await mainNetwork(app);
    say(
      `${String(network.provider.length)} requests went to ${PROVIDER_ORIGIN}; ` +
        `${String(network.refused.length)} to other addresses were refused`,
    );
    expect
      .soft(network.refused, 'the app tried to reach an address other than the provider')
      .toEqual([]);
    expect.soft(fromRenderer, 'the renderer made network requests').toEqual([]);
    expect(
      noVerdict,
      `not a verdict: the provider refused ${String(refused)} of ${String(outcomes.length)} requests for its rate limit or for being overloaded, more than ${String(PROVIDER_ERROR_PERCENT)} percent. Run it again later, or with a key on a higher usage tier`,
    ).toBe(false);
    expect(
      passed * 100,
      `${String(passed)} of ${String(judged)} answered requests did what was asked: see the table above`,
    ).toBeGreaterThanOrEqual(judged * PASS_PERCENT);
  } finally {
    // the key leaves the vault file before the file itself goes
    await win
      ?.evaluate(() =>
        window.aio.invoke('ai:setKey', { provider: 'anthropic', key: 'removed-after-the-check' }),
      )
      .catch(() => undefined);
    await app.close().catch(() => undefined);
    await rm(data.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    process.off('exit', wipeVault);
  }
});
