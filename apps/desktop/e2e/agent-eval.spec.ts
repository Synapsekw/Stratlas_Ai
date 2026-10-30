/**
 * The agent eval: plain requests typed into the agent panel of the synthetic demos and answered
 * by a real model, graded on what the app shows afterwards and the tools that ran. Every other
 * agent spec runs the scripted stand-in, which proves the plumbing and nothing about what a model
 * makes of "Take me to the most severe point on this asset". This one does, on demand.
 *
 * Suites (QUADRION_EVAL_SUITES, comma separated, all by default):
 * - `tank-farm`: the founder's plain requests (agent-eval.cases.ts), with the 90 percent bar, and
 *   `tank-farm-more`: follow-ups in one conversation and requests on a wrong premise
 *   (agent-eval.suites.ts), reported without a bar.
 * - `change`: survey dates, what changed, the stockpile fill, dates that do not exist.
 * - `quarry`: stockpile volumes and tonnes over three surveys. It needs the pipeline Python (the
 *   surfaces are prepared on open) and builds the survey demos on first use.
 * Cases marked `gap` (A1, A2) are expected to fail until that roadmap item lands: they are listed
 * as known gaps, or as closed when they pass every time, and never counted in the pass rate.
 *
 * Profiles (QUADRION_EVAL_PROFILE; without one, the variables below pick it):
 * - `anthropic`: QUADRION_EVAL_ANTHROPIC_KEY (and QUADRION_EVAL_ANTHROPIC_WORKSPACE for a key not
 *   scoped to a workspace). The model is QUADRION_EVAL_MODEL, `claude-haiku-5-5` by default.
 * - `local`: an OpenAI-compatible server on this machine, QUADRION_EVAL_LOCAL_URL (for example
 *   http://localhost:11434/v1) and QUADRION_EVAL_LOCAL_MODEL; QUADRION_EVAL_LOCAL_KIND `ollama`
 *   or `openai-compatible` (default), QUADRION_EVAL_LOCAL_TOOLS `compact` or `full`. The
 *   zero-network guard lets through that address only, so it must be on this machine.
 * - `scripted`: the keyword stand-in model of the other specs. No key, no network, no cost. Its
 *   verdicts say nothing about a model; it proves the harness (turns, traces, pass^k) runs.
 * Without a profile every test here is skipped, and in CI always.
 *
 * Other variables: QUADRION_EVAL_K repeats each case k times from a known start (pass^k, default
 * 1); QUADRION_EVAL_CASES runs only the cases whose id or request contains one of its comma-separated texts;
 * QUADRION_EVAL_OUT moves the traces (default `.agent-eval/` at the repository root, git-ignored).
 *
 * How to run it, at the repository root, with the demos built (`pnpm demo:build --quick` and
 * `pnpm demo:change --quick`) and the app built (`pnpm build`): `pnpm eval:agent`. Each run writes
 * one trace file per suite into its own folder; `pnpm eval:agent:compare` compares the two newest
 * runs (per case: fixed, broke, tool sequence changed) and `--summary` prints one run's table.
 *
 * The key is never typed on a command line, where the shell's history would keep it: copy it, then
 *
 *   PowerShell:  $env:QUADRION_EVAL_ANTHROPIC_KEY = Get-Clipboard
 *                pnpm eval:agent
 *                Remove-Item Env:QUADRION_EVAL_ANTHROPIC_KEY
 *   bash:        read -rs QUADRION_EVAL_ANTHROPIC_KEY; export QUADRION_EVAL_ANTHROPIC_KEY
 *                pnpm eval:agent
 *                unset QUADRION_EVAL_ANTHROPIC_KEY
 *
 * (in bash, paste the key after the first line and press Enter: nothing is shown). Run it with
 * the list reporter of the config and nothing else: a blob report, UI mode or DEBUG=pw:protocol
 * can carry the parameters of a step in full, the key among them.
 *
 * ANTHROPIC_BASE_URL must not be set: the run stops before it starts when it is.
 *
 * What it costs: tokens on that key. Each request is two to four calls to the model, each with
 * the instructions, the tool list and the window context. On `claude-haiku-5-5` a full run of the
 * three suites is in the order of cents; on the app's default chat model, `claude-sonnet-5-5`, in
 * the order of one to three US dollars at the prices of October 2026, times k. Each suite ends
 * with the tokens and the estimated cost the panel's own meter counted.
 *
 * A rate-limited run is not a verdict. The requests follow each other closely, and a key on a low
 * usage tier can meet the provider's limit per minute. A request the provider refuses for its
 * rate limit or for being overloaded (HTTP 429, 529) is asked once more after a minute; when it
 * is refused again it is listed as a provider error and left out of the percentage. When more
 * than a quarter of the requests end that way, the run says so and fails for that reason alone.
 *
 * What it sends to the provider: the requests and the text context of the demo project (its
 * layers, assets, findings and site summary, and what the tools return). The demos are synthetic.
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
 * (`$env:TEMP` on Windows, `$TMPDIR` or /tmp elsewhere). The key is never printed or written to a
 * trace, and no key is read from Settings, the OS vault or the repository.
 *
 * Never add the real-model profiles to CI. They need a paid key or a model server, and CI has
 * neither by design; the skip without a profile is what lets every CI shard pass over this file.
 *
 * One test per demo, so the requests run one after the other in one app: each starts from a new
 * conversation on Scene with nothing selected and no filter set, and its follow-ups are typed in
 * that conversation. The table at the end of each suite lists every case with its verdict, the
 * tools that ran and why it failed.
 */
import { defaultRoutes, offlineRoutes, type ModelRoute } from '@aio/ai/routes';
import type { ElectronApplication, Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
import { caseId, turnVerdict } from './agent-eval.grade';
import {
  changeCases,
  checkChangeDemo,
  checkQuarry,
  moreTankFarmCases,
  quarryCases,
  type ChangeFacts,
  type QuarryFacts,
} from './agent-eval.suites';
import {
  formatSummary,
  summarizeSuite,
  TRACE_SCHEMA,
  type AttemptTrace,
  type CaseTrace,
  type StepTrace,
  type SuiteTrace,
  type TurnTrace,
} from './agent-eval.trace';
import {
  ALLOWED_PROTOCOLS,
  createDataRoot,
  DEMO_FOLDER,
  expect,
  hasChangeDemo,
  hasPipelinePython,
  launchApp,
  NetworkGuard,
  openChangeDemo,
  PIPELINE_ENV,
  test,
  VENV_PYTHON,
  type DataRoot,
} from './fixtures';
import { volumesView } from './island';
import { createSurveyProject, SURVEY_DEMOS, surveyDemoFolder } from './surveyFixtures';
import { openDemo } from './surveyJobs';

// ------------------------------------------------------------------------------ how it is run

type ProfileKind = 'anthropic' | 'local' | 'scripted';

interface Profile {
  kind: ProfileKind;
  /** The provider of the chat route. */
  provider: 'anthropic' | 'local';
  model: string;
  /** local: the server's address and how to treat it. */
  local?: {
    baseUrl: string;
    origin: string;
    kind: 'ollama' | 'openai-compatible';
    tools: 'compact' | 'full';
  };
}

/** The cheap default: the requests are many and short, the cost is per token. */
const DEFAULT_MODEL = 'claude-haiku-5-5';

const env = (name: string): string => (process.env[name] ?? '').trim();

/** The profile the variables ask for, or why there is none. */
function pickProfile(): Profile | string {
  const asked = env('QUADRION_EVAL_PROFILE').toLowerCase();
  const kind: ProfileKind | '' =
    asked === 'anthropic' || asked === 'local' || asked === 'scripted'
      ? asked
      : asked
        ? ''
        : env('QUADRION_EVAL_ANTHROPIC_KEY')
          ? 'anthropic'
          : env('QUADRION_EVAL_LOCAL_URL')
            ? 'local'
            : '';
  if (asked && !kind)
    return `QUADRION_EVAL_PROFILE is "${asked}": use anthropic, local or scripted`;
  if (!kind)
    return 'Agent eval: set QUADRION_EVAL_ANTHROPIC_KEY, QUADRION_EVAL_LOCAL_URL or QUADRION_EVAL_PROFILE=scripted to run it. A real model spends tokens.';
  if (kind === 'anthropic') {
    if (!env('QUADRION_EVAL_ANTHROPIC_KEY'))
      return 'Agent eval: the anthropic profile needs QUADRION_EVAL_ANTHROPIC_KEY.';
    return { kind, provider: 'anthropic', model: env('QUADRION_EVAL_MODEL') || DEFAULT_MODEL };
  }
  if (kind === 'scripted')
    return { kind, provider: 'anthropic', model: env('QUADRION_EVAL_MODEL') || DEFAULT_MODEL };
  const baseUrl = env('QUADRION_EVAL_LOCAL_URL');
  const model = env('QUADRION_EVAL_LOCAL_MODEL') || env('QUADRION_EVAL_MODEL');
  if (!baseUrl || !model)
    return 'Agent eval: the local profile needs QUADRION_EVAL_LOCAL_URL and QUADRION_EVAL_LOCAL_MODEL.';
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return `Agent eval: QUADRION_EVAL_LOCAL_URL is no address (${baseUrl}).`;
  }
  const host = new URL(baseUrl).hostname;
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) && !host.startsWith('127.'))
    return `Agent eval: the local profile takes a server on this machine only, not ${host} (the zero-network guard admits loopback addresses alone).`;
  return {
    kind,
    provider: 'local',
    model,
    local: {
      baseUrl,
      origin,
      kind: env('QUADRION_EVAL_LOCAL_KIND') === 'ollama' ? 'ollama' : 'openai-compatible',
      tools: env('QUADRION_EVAL_LOCAL_TOOLS') === 'full' ? 'full' : 'compact',
    },
  };
}

const PROFILE = pickProfile();

// Said first: no shard of CI runs this, whatever its secrets hold.
test.skip(
  Boolean(process.env.CI),
  'Agent eval: never in CI. The real-model profiles need a paid key or a model server.',
);
test.skip(typeof PROFILE === 'string', typeof PROFILE === 'string' ? PROFILE : '');

/** Each case is asked this many times from a known start (pass^k). */
const K = Math.min(10, Math.max(1, Number.parseInt(env('QUADRION_EVAL_K') || '1', 10) || 1));
const SUITES = (env('QUADRION_EVAL_SUITES') || 'tank-farm,change,quarry')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
/** Texts a case's id or request must contain (any of them), comma separated. */
const CASE_FILTER = env('QUADRION_EVAL_CASES').toLowerCase();
const CASE_WORDS = CASE_FILTER.split(',')
  .map((w) => w.trim())
  .filter(Boolean);

const REPO = join(import.meta.dirname, '..', '..', '..');
const OUT = env('QUADRION_EVAL_OUT') || join(REPO, '.agent-eval');

const TANK_FARM = { id: 'demo-tank-farm', name: 'Demo tank farm' };
const CHANGE_SITE = { id: 'demo-change-site' };
const hasTankFarm = () => existsSync(join(DEMO_FOLDER, TANK_FARM.id, 'manifest.json'));

/** The share of the requests the provider answered that must do what was asked (tank farm). */
const PASS_PERCENT = 90;
/** Launching, the connection test, opening the demo and loading its model. */
const SETUP_MS = 5 * 60_000;
/** The quarry's three surveys are prepared on open: the surfaces take minutes. */
const SURVEYS_MS = 6 * 60_000;
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

/**
 * The one address outside this machine that `fetch` in the main process reaches in the anthropic
 * profile. The key is only ever sent here: `fetch` to any other address stays behind the
 * zero-network guard (see `openProviderDoor` for what that guard does and does not hold).
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
  // a demo without tagged assets has none to wait for
  if (names.length === 0) return;
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

interface TurnRead {
  /** Requests in the conversation. */
  asked: number;
  /** A reply is under way. */
  busy: boolean;
  /** The last message is the agent's, not the person's. */
  replied: boolean;
  /** The tool steps of the reply to the last request, with how they ended and their input. */
  steps: StepTrace[];
  /** The text of the reply to the last request, without its steps. */
  reply: string;
  /** Why that reply failed, or empty. */
  error: string;
}

/**
 * The reply to the last request as the panel shows it: every agent message after the last of the
 * person's. Read from the page, not through roles: the panel may be in a folded column, and for a
 * moment in no screen at all while the agent changes screen. A step's input is the JSON the panel
 * keeps in its title.
 */
const readTurn = (win: Page) =>
  win.evaluate((sel): TurnRead => {
    const panel = document.querySelector(sel);
    const msgs = [...(panel?.querySelectorAll('.ag-msg') ?? [])];
    const lastUser = msgs.map((m) => m.classList.contains('user')).lastIndexOf(true);
    const reply = msgs.slice(lastUser + 1);
    const parse = (text: string | null): unknown => {
      try {
        return text ? (JSON.parse(text) as unknown) : undefined;
      } catch {
        return text;
      }
    };
    return {
      asked: msgs.filter((m) => m.classList.contains('user')).length,
      busy: panel?.querySelector('.ag-log')?.getAttribute('aria-busy') === 'true',
      replied: reply.length > 0,
      steps: reply.flatMap((m) =>
        [...m.querySelectorAll('.step')].map((el) => {
          const code = el.querySelector('code');
          return {
            name: code?.textContent ?? '',
            status: el.className.replace(/\bstep\b/, '').trim(),
            input: parse(code?.getAttribute('title') ?? null),
          };
        }),
      ),
      // a reply is its text and its steps side by side: the text is the spans
      reply: reply
        .flatMap((m) => [...m.children])
        .filter((el) => el.tagName === 'SPAN' && !el.classList.contains('typing'))
        .map((el) => el.textContent)
        .join('')
        .trim(),
      error: reply
        .map((m) => m.querySelector('.ag-err')?.textContent ?? '')
        .join(' ')
        .trim(),
    };
  }, PANEL);

/** What the app shows now: the part of `EvalState` that is not the conversation. */
const appState = (win: Page) =>
  win.evaluate((): Omit<EvalState, 'toolCalls' | 'steps' | 'reply'> => {
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
      issueCount: ws.issues.length,
    };
  });

/** The project as it opened: what every request starts from. */
interface Home {
  /** The stage mode (3D, map, split). */
  mode: string;
  /** The nodes of the main model (none for a demo without tagged assets). */
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
 * Type a request and wait for the whole reply: `n` is which request of the conversation this is.
 * The first send in a project stops at the preview of what leaves the machine; a step that asks
 * for approval (it would write data or send a frame) is rejected. False when no reply came in time.
 */
async function ask(win: Page, text: string, n: number): Promise<boolean> {
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
        const turn = await readTurn(win);
        return turn.asked >= n && turn.replied && !turn.busy;
      },
      { timeout: REPLY_MS, intervals: [500] },
    )
    .toBe(true)
    .then(
      () => true,
      () => false,
    );
}

/**
 * The provider refused for its rate limit or for being overloaded: the app's words for HTTP 429
 * and 529 (packages/ai/src/errors.ts), and the provider's own when it says so in mid reply.
 */
const PROVIDER_BUSY = /\(HTTP (429|529)\)|rate.?limit|overloaded/i;

/** One line of the run's log. */
const say = (line: string) => process.stdout.write(`[eval] ${line}\n`);

/** The screen the agent opened is drawn before it is read. */
const screenDrawn = (win: Page) =>
  expect
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

/**
 * One conversation from a known start: the case's request, then each follow-up after the reply
 * before it, each judged on what the app shows after its own reply.
 */
async function attempt(
  win: Page,
  c: EvalCase,
  home: Home,
  selection: Picked | null,
): Promise<AttemptTrace> {
  const started = Date.now();
  await knownState(win, c, home, selection);
  const turns = [{ ask: c.ask, expect: c.expect }, ...(c.then ?? [])];
  const reasons: (string | null)[] = [];
  const traces: TurnTrace[] = [];
  let busy = false;
  let last: EvalState | null = null;
  for (const [i, t] of turns.entries()) {
    const answered = await ask(win, t.ask, i + 1);
    await screenDrawn(win);
    let turn = await readTurn(win);
    const read = async (): Promise<EvalState> => {
      turn = await readTurn(win);
      return {
        ...(await appState(win)),
        toolCalls: turn.steps.filter((s) => s.status === 'done').map((s) => s.name),
        steps: turn.steps,
        reply: turn.reply,
      };
    };
    let state = await read();
    const error = turn.error;
    let why = !answered
      ? `no reply within ${String(REPLY_MS / 1000)} s`
      : error
        ? `the reply failed: ${error}`
        : t.expect(state);
    // A screen that is still drawing its list must not fail a request: the state is read again
    // for a few seconds before a failure of the case is accepted.
    if (answered && !error) {
      const until = Date.now() + SETTLE_MS;
      while (why !== null && Date.now() < until) {
        await win.waitForTimeout(500);
        state = await read();
        why = t.expect(state);
      }
    }
    if (answered && PROVIDER_BUSY.test(error)) busy = true;
    reasons.push(why);
    traces.push({
      ask: t.ask,
      steps: turn.steps,
      reply: turn.reply,
      ...(error ? { error } : {}),
    });
    last = state;
    // no reply: the conversation cannot go on
    if (!answered || busy) break;
  }
  const why = turnVerdict(reasons);
  const note = last && c.note ? c.note(last) : '';
  return {
    result: why === null ? 'pass' : busy ? 'provider' : 'fail',
    why: why ?? '',
    turns: traces,
    ...(note ? { note } : {}),
    ms: Date.now() - started,
  };
}

/**
 * A conversation, had once more after a pause when the provider refused it for its rate limit or
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

// ------------------------------------------------------------------------------ traces on disk

/**
 * This run's folder under `OUT`, the same for every test of the run: a worker that starts again
 * after a failed test finds it through a marker named after the runner's process.
 */
function runFolder(profile: Profile): string {
  mkdirSync(OUT, { recursive: true });
  const marker = join(OUT, `.run-${String(process.ppid)}`);
  try {
    // a marker of an earlier run whose runner had the same process id is not this run's
    if (Date.now() - statSync(marker).mtimeMs < 24 * 3_600_000) {
      const dir = readFileSync(marker, 'utf8').trim();
      if (dir && existsSync(dir)) return dir;
    }
  } catch {
    // no marker yet: this is the run's first test
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `${stamp}-${profile.kind}-${profile.model.replace(/[^\w.-]+/g, '_')}`;
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(marker, dir);
  return dir;
}

function writeTrace(trace: SuiteTrace, dir: string, safe: (text: string) => string): void {
  writeFileSync(join(dir, `${trace.suite}.json`), safe(JSON.stringify(trace, null, 2)));
}

// ------------------------------------------------------------------------------ the app per profile

interface Session {
  page: Page;
  /** Nothing printed or written carries the key, whatever a provider or the app puts in a text. */
  safe: (text: string) => string;
  /** The checks of the profile's network, the key out of the vault, the app closed, the profile gone. */
  finish: () => Promise<void>;
}

/** The app's routes with the chat route on `model` of `provider`. */
const chatRoutes = (provider: 'anthropic', model: string): ModelRoute[] =>
  defaultRoutes().map((r) => (r.task === 'chat' ? { ...r, provider, model } : r));

/**
 * Let `fetch` in the main process reach the provider, and only the provider.
 *
 * `launchApp` starts the app behind the preload of the zero-network guard (network-guard.cjs),
 * which refuses and records what the main process sends through Node: `fetch`, http, https and
 * plain sockets. Its list of exceptions (AIO_NETWORK_GUARD_ALLOW) takes addresses on this machine
 * only, so it cannot be extended to a provider. For the anthropic profile alone the door is opened
 * here instead, after the launch: a `fetch` to the provider's address goes out through a network
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
 * (map packs, updates, online satellite) would be neither refused nor recorded in this profile.
 * None of them runs by itself: each is off until the person starts it in the app, and nothing
 * here does. The local and scripted profiles attach the whole guard.
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

/** The first line of an error, without the colours Playwright puts in its messages. */
const firstLine = (e: unknown) =>
  (e instanceof Error ? e.message : String(e))
    // eslint-disable-next-line no-control-regex -- the escape character of a terminal colour.
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')[0] ?? '';

async function firstWindow(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return page;
}

/** The anthropic profile: the key in the throwaway vault, the door to the provider open. */
async function anthropicSession(
  profile: Profile,
  data: DataRoot,
  extraEnv: Record<string, string>,
): Promise<Session> {
  // trimmed, as the app's vault stores it: the same text is sent, stored and kept out of the log
  const key = env('QUADRION_EVAL_ANTHROPIC_KEY');
  const workspaceId = env('QUADRION_EVAL_ANTHROPIC_WORKSPACE');
  const safe = (text: string) => (key ? text.split(key).join('[key]') : text);
  // The provider's SDK sends its requests, the key with them, to this address when it is set.
  // The door below would refuse it, so the run stops here, before anything starts. Blanking it
  // for the app is no way out: the SDK takes an empty value for the address.
  expect(
    process.env.ANTHROPIC_BASE_URL === undefined,
    'ANTHROPIC_BASE_URL is set in this shell: unset it, this check only talks to the provider itself',
  ).toBe(true);
  // The `finish` below takes the key out of the vault file. Ctrl+C and the test's time limit
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
    ...extraEnv,
    // keys of this run go to a file of its throwaway profile, never to the OS vault
    QUADRION_TEST_VAULT: '1',
    // the real providers, whatever the shell has set
    QUADRION_AI_TEST_PROVIDER: '',
    // the app is handed the key through ai:setKey; its environment does not hold it as well
    QUADRION_EVAL_ANTHROPIC_KEY: '',
  });
  // the renderer has no business on the network at all: as in every other spec
  const fromRenderer: string[] = [];
  app.context().on('request', (req) => {
    if (!ALLOWED_PROTOCOLS.includes(new URL(req.url()).protocol)) fromRenderer.push(req.url());
  });
  let page: Page | undefined;
  const finish = async () => {
    try {
      const network = await mainNetwork(app).catch(() => ({ provider: [], refused: [] }));
      say(
        `${String(network.provider.length)} requests went to ${PROVIDER_ORIGIN}; ` +
          `${String(network.refused.length)} to other addresses were refused`,
      );
      expect
        .soft(network.refused, 'the app tried to reach an address other than the provider')
        .toEqual([]);
      expect.soft(fromRenderer, 'the renderer made network requests').toEqual([]);
    } finally {
      // the key leaves the vault file before the file itself goes
      await page
        ?.evaluate(() =>
          window.aio.invoke('ai:setKey', { provider: 'anthropic', key: 'removed-after-the-check' }),
        )
        .catch(() => undefined);
      await app.close().catch(() => undefined);
      await rm(data.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      process.off('exit', wipeVault);
    }
  };
  try {
    await app.context().route(/^(https?|wss?|ftp):/i, (r) => r.abort('internetdisconnected'));
    page = await firstWindow(app);
    const win = page;
    // A placeholder first: only when that landed in the throwaway vault file does the key follow.
    await win.evaluate(() =>
      window.aio.invoke('ai:setKey', { provider: 'anthropic', key: 'placeholder-not-a-key' }),
    );
    expect(
      existsSync(vaultFile),
      'keys of this run must go to the throwaway vault file, not the OS vault',
    ).toBe(true);
    const stored = await win.evaluate(
      (k) => window.aio.invoke('ai:setKey', { provider: 'anthropic', key: k }),
      key,
    );
    expect(stored.ok, 'the key was not stored in the test vault').toBe(true);
    await win.evaluate(
      ({ id, routes }) =>
        window.aio.invoke('settings:set', {
          cloudAi: true,
          routes,
          ...(id ? { anthropicWorkspaceId: id } : {}),
        }),
      { id: workspaceId, routes: chatRoutes('anthropic', profile.model) },
    );
    const status = await win.evaluate(() => window.aio.invoke('ai:status', {}));
    expect(status.ready, safe(status.message ?? 'the agent is not ready')).toBe(true);
    expect(status.route, 'the app answers on the chat route of this run').toMatchObject({
      provider: 'anthropic',
      model: profile.model,
    });
    await openProviderDoor(app, PROVIDER_ORIGIN);
    // One minimal request, as Settings, Test connection makes it: a wrong key, a missing
    // workspace ID or a closed network says so here, once, instead of in every request below.
    const tested = await win.evaluate(() =>
      window.aio.invoke('ai:testConnection', { provider: 'anthropic' }),
    );
    expect(tested.ok, `the provider did not answer: ${safe(tested.message)}`).toBe(true);
    expect(
      (await mainNetwork(app)).provider.length,
      'the connection test was answered, but not through the provider door: either a scripted ' +
        'model is switched on by a variable in this shell, or the app no longer reads ' +
        'globalThis.fetch for each request and the door has to be opened another way',
    ).toBeGreaterThan(0);
    return { page: win, safe, finish };
  } catch (e) {
    await finish();
    throw e;
  }
}

/**
 * The local and scripted profiles: the whole zero-network guard, which lets through only the
 * local server's address (none for the scripted model).
 */
async function guardedSession(
  profile: Profile,
  data: DataRoot,
  extraEnv: Record<string, string>,
): Promise<Session> {
  const allow = profile.local ? [profile.local.origin] : [];
  const app = await launchApp(data, {
    ...extraEnv,
    QUADRION_AI_TEST_PROVIDER: profile.kind === 'scripted' ? '1' : '',
    ...(profile.local ? { AIO_NETWORK_GUARD_ALLOW: profile.local.origin } : {}),
  });
  const network = new NetworkGuard(allow);
  const finish = async () => {
    try {
      const outbound = await network.outbound().catch(() => []);
      expect.soft(outbound, 'the app made requests other than to the model server').toEqual([]);
    } finally {
      await app.close().catch(() => undefined);
      await rm(data.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  };
  try {
    await network.attach(app);
    const page = await firstWindow(app);
    const local = profile.local;
    await page.evaluate(
      (settings) => window.aio.invoke('settings:set', settings),
      local
        ? {
            cloudAi: false,
            localModel: {
              enabled: true,
              baseUrl: local.baseUrl,
              model: profile.model,
              kind: local.kind,
              toolProfile: local.tools,
              // a model chosen for this check is one that calls tools
              capabilities: { tools: true, vision: false },
            },
            routes: offlineRoutes(profile.model),
          }
        : { cloudAi: true, routes: chatRoutes('anthropic', profile.model) },
    );
    const status = await page.evaluate(() => window.aio.invoke('ai:status', {}));
    expect(status.ready, status.message ?? 'the agent is not ready').toBe(true);
    expect(status.route, 'the app answers on the chat route of this run').toMatchObject({
      provider: profile.provider,
      model: profile.model,
    });
    return { page, safe: (text) => text, finish };
  } catch (e) {
    await finish();
    throw e;
  }
}

const startSession = (profile: Profile, data: DataRoot, extraEnv: Record<string, string>) =>
  profile.kind === 'anthropic'
    ? anthropicSession(profile, data, extraEnv)
    : guardedSession(profile, data, extraEnv);

// ------------------------------------------------------------------------------ suites

interface SuiteDef {
  suite: string;
  demo: string;
  cases: EvalCase[];
  /** The share of core attempts that must pass, or null: this suite reports only. */
  passPercent: number | null;
  /** Its cases count towards the bar. */
  core: boolean;
}

/** Only the cases QUADRION_EVAL_CASES names, when it is set. */
const picked = (suite: string, cases: EvalCase[]): EvalCase[] =>
  CASE_WORDS.length > 0
    ? cases.filter((c) =>
        CASE_WORDS.some((w) => caseId(suite, c).includes(w) || c.ask.toLowerCase().includes(w)),
      )
    : cases;

/** The longest the suites can take: every turn twice (once more after a refusal), k times. */
const budget = (suites: readonly SuiteDef[], extra = 0): number =>
  SETUP_MS +
  extra +
  suites
    .flatMap((s) => s.cases)
    .reduce(
      (ms, c) =>
        ms +
        (1 + (c.then?.length ?? 0)) * K * (2 * (REPLY_MS + SETTLE_MS + 60_000)) +
        PROVIDER_PAUSE_MS,
      0,
    );

/** Ask every case of a suite k times; the trace is written after each case. */
async function runSuite(
  page: Page,
  def: SuiteDef,
  home: Home,
  session: Session,
  profile: Profile,
  folder: string,
  select: (tag: string) => Picked = () => {
    throw new Error(`the ${def.demo} demo has no assets to select`);
  },
): Promise<SuiteTrace> {
  const trace: SuiteTrace = {
    schema: TRACE_SCHEMA,
    suite: def.suite,
    demo: def.demo,
    profile: profile.kind,
    provider: profile.provider,
    model: profile.model,
    k: K,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    passPercent: def.passPercent,
    cases: [],
  };
  say(
    `${def.suite}: ${String(def.cases.length)} case(s), each ${String(K)} time(s), ${profile.model} (${profile.kind})`,
  );
  for (const [i, c] of def.cases.entries()) {
    const id = caseId(def.suite, c);
    const asks = [c.ask, ...(c.then ?? []).map((t) => t.ask)];
    const entry: CaseTrace = {
      id,
      suite: def.suite,
      ask: (c.select ? [`${c.ask} (with ${c.select} selected)`, ...asks.slice(1)] : asks).join(
        ' / ',
      ),
      turns: asks.length,
      ...(c.gap ? { gap: c.gap } : {}),
      core: def.core,
      attempts: [],
    };
    trace.cases.push(entry);
    for (let k = 1; k <= K; k++) {
      const selection = c.select ? select(c.select) : null;
      // a request the check could not put to the app counts as failed, and the rest still run
      const outcome =
        await test.step(`${entry.ask}${K > 1 ? ` (${String(k)} of ${String(K)})` : ''}`, () =>
          run(page, c, home, selection).catch((e: unknown): AttemptTrace => ({
            result: 'fail',
            why: `the check could not run it: ${firstLine(e)}`,
            turns: [],
          })));
      entry.attempts.push(outcome);
      say(
        `${String(i + 1).padStart(2)} of ${String(def.cases.length)}${K > 1 ? ` #${String(k)}` : ''} ${outcome.result}${c.gap && outcome.result === 'fail' ? ` (known gap, ${c.gap})` : ''}  ${entry.ask}`,
      );
    }
    writeTrace(trace, folder, session.safe);
  }
  trace.finishedAt = new Date().toISOString();
  writeTrace(trace, folder, session.safe);
  say('');
  for (const line of formatSummary(trace).split('\n')) say(session.safe(line));
  say(`trace: ${join(folder, `${def.suite}.json`)}`);
  say('');
  return trace;
}

/** The meter of the project, in the panel on Scene: every request of the test is in it. */
async function sayMeter(page: Page, home: Home): Promise<void> {
  await knownState(page, { ask: '', expect: () => null }, home, null).catch(() => undefined);
  const meter = await page.evaluate((sel) => {
    const el = document.querySelector(`${sel} .ag-proj .ag-mono`);
    return el ? { shown: el.textContent, detail: el.getAttribute('title') ?? '' } : null;
  }, PANEL);
  say(
    meter
      ? `the panel's meter for this project: ${meter.shown} (${meter.detail})`
      : 'the panel shows no meter for this project',
  );
}

/**
 * The verdict of a test. The scripted model proves the harness only: every case was asked k
 * times and every follow-up typed. A real model must meet each suite's bar, unless the provider
 * refused too many requests for that to be a verdict.
 */
function judge(profile: Profile, traces: readonly SuiteTrace[]): void {
  if (profile.kind === 'scripted') {
    say('scripted stand-in model: the verdicts above say nothing about a real model');
    for (const t of traces)
      for (const c of t.cases) {
        expect.soft(c.attempts.length, `${c.id}: attempts`).toBe(K);
        for (const a of c.attempts)
          expect.soft(a.turns.length, `${c.id}: turns typed (${a.why})`).toBe(c.turns);
      }
    return;
  }
  for (const t of traces) {
    const s = summarizeSuite(t);
    const noVerdict = s.providerErrors * 100 > s.attempts * PROVIDER_ERROR_PERCENT;
    expect(
      noVerdict,
      `${t.suite}: not a verdict: the provider refused ${String(s.providerErrors)} of ${String(s.attempts)} requests for its rate limit or for being overloaded, more than ${String(PROVIDER_ERROR_PERCENT)} percent. Run it again later, or with a key on a higher usage tier`,
    ).toBe(false);
    expect
      .soft(
        s.barMet,
        `${t.suite}: ${String(s.core.passed)} of ${String(s.core.judged)} answered requests did what was asked, ${String(t.passPercent)} percent needed: see the table above`,
      )
      .not.toBe(false);
  }
}

// ------------------------------------------------------------------------------ the demos

const profileOf = (): Profile => {
  if (typeof PROFILE === 'string') throw new Error(PROFILE);
  return PROFILE;
};

/** The project as it opened, before any request. */
const homeOf = async (page: Page, nodes: string[]): Promise<Home> => ({
  mode: await page.evaluate(
    () => (window as unknown as Probe).__stratlas.shell.getState().stageMode,
  ),
  nodes,
});

/** The stores this check reads are there, and the agent takes a request. */
async function ready(page: Page): Promise<void> {
  const hooks = await page.evaluate(() => {
    const s = (window as unknown as Probe).__stratlas as unknown as Record<string, unknown>;
    return ['workspace', 'shell', 'mediaView', 'issueView', 'evidence'].filter(
      (name) => typeof (s[name] as { getState?: unknown } | undefined)?.getState !== 'function',
    );
  });
  expect(hooks, 'window.__stratlas lacks stores this check reads').toEqual([]);
  await expect(agent(page).getByRole('textbox', { name: 'Message the agent' })).toBeEnabled({
    timeout: 60_000,
  });
}

test('@eval tank farm: plain requests, follow-ups and wrong premises', async () => {
  test.skip(!SUITES.includes('tank-farm'), 'QUADRION_EVAL_SUITES leaves out tank-farm');
  test.skip(!hasTankFarm(), `no demo in ${DEMO_FOLDER}: run pnpm demo:build --quick`);
  const profile = profileOf();
  const farm = tankFarm();
  expect(checkDemo(farm.facts), 'the demo no longer matches what the cases pin').toEqual([]);
  const suites: SuiteDef[] = [
    {
      suite: 'tank-farm',
      demo: TANK_FARM.id,
      cases: picked('tank-farm', evalCases(farm.facts)),
      passPercent: PASS_PERCENT,
      core: true,
    },
    {
      suite: 'tank-farm-more',
      demo: TANK_FARM.id,
      cases: picked('tank-farm-more', moreTankFarmCases(farm.facts)),
      passPercent: null,
      core: false,
    },
  ].filter((s) => s.cases.length > 0);
  test.skip(suites.length === 0, `QUADRION_EVAL_CASES (${CASE_FILTER}) picks no tank farm case`);
  test.setTimeout(budget(suites));

  const folder = runFolder(profile);
  const session = await startSession(profile, await createDataRoot(), {
    QUADRION_DEMO: DEMO_FOLDER,
  });
  try {
    const { page } = session;
    await openDemo(page, TANK_FARM.name, TANK_FARM.id);
    await ready(page);
    // the bounds of the tagged assets come from the model: every asset question needs it loaded
    await waitForNodes(page, farm.nodes);
    const home = await homeOf(page, farm.nodes);
    const traces: SuiteTrace[] = [];
    for (const def of suites)
      traces.push(await runSuite(page, def, home, session, profile, folder, farm.asset));
    await sayMeter(page, home);
    judge(profile, traces);
  } finally {
    await session.finish();
  }
});

/** The change demo as its files have it. */
function changeFacts(): ChangeFacts {
  const dir = join(DEMO_FOLDER, CHANGE_SITE.id);
  const read = (file: string): unknown => JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const manifest = read('manifest.json') as { captures: { id: string; date: string }[] };
  const issues = (read('issues.json') as { issues: { id: string; code: string }[] }).issues;
  const truth = read('truth.json') as {
    changes: {
      issue: { items: { verdict: string; from?: string; to?: string }[] };
      surface: { regions: { what: string; volume: { fillM3: number } }[] };
    };
  };
  const code = (id: string | undefined) => issues.find((i) => i.id === id)?.code ?? String(id);
  const items = truth.changes.issue.items;
  return {
    dates: manifest.captures.map((c) => c.date).sort(),
    newCodes: items.filter((i) => i.verdict === 'new').map((i) => code(i.to)),
    resolvedCodes: items.filter((i) => i.verdict === 'resolved').map((i) => code(i.from)),
    stockpileFillM3:
      truth.changes.surface.regions.find((r) => /stockpile/i.test(r.what))?.volume.fillM3 ?? NaN,
  };
}

test('@eval change demo: survey dates, changes and a stockpile', async () => {
  test.skip(!SUITES.includes('change'), 'QUADRION_EVAL_SUITES leaves out change');
  test.skip(!hasChangeDemo(), `no change demo in ${DEMO_FOLDER}: run pnpm demo:change --quick`);
  const profile = profileOf();
  const facts = changeFacts();
  expect(checkChangeDemo(facts), 'the change demo no longer matches the cases').toEqual([]);
  const def: SuiteDef = {
    suite: 'change',
    demo: CHANGE_SITE.id,
    cases: picked('change', changeCases(facts)),
    passPercent: null,
    core: false,
  };
  test.skip(def.cases.length === 0, `QUADRION_EVAL_CASES (${CASE_FILTER}) picks no change case`);
  test.setTimeout(budget([def]));

  const folder = runFolder(profile);
  const session = await startSession(profile, await createDataRoot(), {
    QUADRION_DEMO: DEMO_FOLDER,
  });
  try {
    const { page } = session;
    await openChangeDemo(page);
    await expect(page.locator('[data-scene-view] canvas').first()).toBeVisible({
      timeout: SCREEN_MS,
    });
    await ready(page);
    const home = await homeOf(page, []);
    const trace = await runSuite(page, def, home, session, profile, folder);
    await sayMeter(page, home);
    judge(profile, [trace]);
  } finally {
    await session.finish();
  }
});

test('@eval quarry: stockpile volumes over three surveys', async () => {
  test.skip(!SUITES.includes('quarry'), 'QUADRION_EVAL_SUITES leaves out quarry');
  test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);
  const profile = profileOf();
  const built = surveyDemoFolder();
  test.skip(built.dir === null, built.reason);
  const data = await createDataRoot();
  const project = await createSurveyProject(data.root, built.dir ?? '', 'quarry');
  const manifest = JSON.parse(readFileSync(join(project.dir, 'manifest.json'), 'utf8')) as {
    captures: { id: string; date: string }[];
  };
  const stock = (project.truth.stockpiles ?? {}) as Record<
    string,
    { dates: Record<string, { volumeM3: number; tonnes: number }> }
  >;
  const facts: QuarryFacts = {
    dates: [...manifest.captures].sort((a, b) => a.date.localeCompare(b.date)),
    piles: Object.fromEntries(Object.entries(stock).map(([id, p]) => [id, p.dates])),
  };
  expect(checkQuarry(facts), 'the quarry demo no longer matches the cases').toEqual([]);
  const def: SuiteDef = {
    suite: 'quarry',
    demo: SURVEY_DEMOS.quarry.id,
    cases: picked('quarry', quarryCases(facts)),
    passPercent: null,
    core: false,
  };
  test.skip(def.cases.length === 0, `QUADRION_EVAL_CASES (${CASE_FILTER}) picks no quarry case`);
  test.setTimeout(budget([def], SURVEYS_MS));

  const folder = runFolder(profile);
  const session = await startSession(profile, data, PIPELINE_ENV);
  try {
    const { page } = session;
    await openDemo(page, project.name, project.id);
    await ready(page);
    // the surveys are prepared on open: the volumes are what the questions are about
    await volumesView(page);
    await expect(
      page
        .getByRole('region', { name: 'Survey dates chart' })
        .locator('[data-survey][data-state="ready"]'),
    )
      .toHaveCount(facts.dates.length, { timeout: SURVEYS_MS })
      .catch(() => {
        say('the surveys were not all prepared in time: the volume cases may fail for that');
      });
    const home = await homeOf(page, []);
    const trace = await runSuite(page, def, home, session, profile, folder);
    await sayMeter(page, home);
    judge(profile, [trace]);
  } finally {
    await session.finish();
  }
});
