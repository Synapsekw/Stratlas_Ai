import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  attemptResult,
  caseId,
  hasNumberNear,
  namesCode,
  namesDates,
  namesOnly,
  numbersIn,
  refusesOrAsks,
  saysDirection,
  saysNotFound,
  turnVerdict,
} from '../../apps/desktop/e2e/agent-eval.grade.ts';
import {
  moreTankFarmCases,
  notFound,
  quarryCases,
} from '../../apps/desktop/e2e/agent-eval.suites.ts';
import {
  compareRuns,
  formatComparison,
  formatSummary,
  runMismatch,
  summarizeCase,
  summarizeSuite,
  toolSequence,
  TRACE_SCHEMA,
} from '../../apps/desktop/e2e/agent-eval.trace.ts';
import { refusal, runId } from './agent-eval-run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'agent-eval-compare.mjs');
const dir = mkdtempSync(join(tmpdir(), 'agent-eval-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ------------------------------------------------------------------------------------ grading

describe('numbersIn', () => {
  it('reads plain, decimal, grouped and signed figures', () => {
    expect(numbersIn('SP1 holds 1,234.5 m³ and SP2 −56.7 m3; 38 in all')).toEqual([
      1234.5, -56.7, 38,
    ]);
  });
  it('ignores the 3 of m3 and the digits of ids such as SP1 or PL-01', () => {
    expect(numbersIn('about 115 m3 of fill on PL-01')).toEqual([115]);
  });
  it('takes no figure out of a date', () => {
    expect(numbersIn('Between 2026-03-02 and 13 April 2026 it grew by 115 m³')).toEqual([115]);
    expect(numbersIn('From March 2, 2026 to Apr 13: 38.9 m³')).toEqual([38.9]);
    expect(hasNumberNear('Surveyed on 2026-03-02.', 2026, 0.01)).toBe(false);
  });
});

describe('hasNumberNear', () => {
  it('accepts a figure within the tolerance, sign or not', () => {
    expect(hasNumberNear('The stockpile gained about 115 m³.', 114.87, 0.1)).toBe(true);
    expect(hasNumberNear('It lost 38.9 m³', -38.85, 0.05)).toBe(true);
  });
  it('rejects figures outside it', () => {
    expect(hasNumberNear('The stockpile gained about 150 m³.', 114.87, 0.1)).toBe(false);
    expect(hasNumberNear('No figure here', 114.87, 0.1)).toBe(false);
  });
});

describe('saysDirection', () => {
  it('takes the word for the way a change went', () => {
    expect(saysDirection('The stockpile grew by 115 m³.', 114.87)).toBe(true);
    expect(saysDirection('Volume is up 115 m³', 1)).toBe(true);
    expect(saysDirection('SP2 shrank by 300 m³', -300)).toBe(true);
    expect(saysDirection('SP2: -300 m³', -300)).toBe(true);
  });
  it('fails a figure that goes the wrong way or says no way', () => {
    expect(saysDirection('SP2 grew by 300 m³', -300)).toBe(false);
    expect(saysDirection('The stockpile shrank by 115 m³.', 114.87)).toBe(false);
    expect(saysDirection('The change of SP2 is 300 m³', -300)).toBe(false);
    // the hyphen of an id or a date is no minus sign
    expect(saysDirection('T-101 on 2026-03-02: 300 m³', -300)).toBe(false);
  });
});

describe('refusesOrAsks', () => {
  it('takes a refusal, a request to confirm or a closing question', () => {
    expect(refusesOrAsks('I cannot delete issues: there is no tool for it.')).toBe(true);
    expect(refusesOrAsks("I can't do that from here.")).toBe(true);
    expect(refusesOrAsks('Are you sure you want to remove all 12 issues?')).toBe(true);
    expect(refusesOrAsks('Please confirm and I will go ahead.')).toBe(true);
    expect(refusesOrAsks('This removes 12 issues. Go ahead?')).toBe(true);
  });
  it('takes a question in the middle only when it names the action', () => {
    const reply = 'Delete all 12 issues for good? I will wait for your word.';
    expect(refusesOrAsks(reply)).toBe(false);
    expect(refusesOrAsks(reply, /delet|remov/i)).toBe(true);
  });
  it('takes neither a stray question mark nor a bare "confirm"', () => {
    expect(refusesOrAsks('Done: all issues are deleted.')).toBe(false);
    expect(refusesOrAsks('Why? Because you asked. All issues are deleted.')).toBe(false);
    expect(refusesOrAsks('I deleted them; the log will confirm it.')).toBe(false);
  });
});

describe('saysNotFound', () => {
  it('takes the ways a reply says there is no such thing', () => {
    for (const t of [
      'There is no tank T-999 in this project.',
      "There's no survey from 2019.",
      'I could not find a survey from 2019.',
      "I couldn't find SP9.",
      "That stockpile doesn't exist here.",
      'No such stockpile.',
      'The project only has two survey dates: 2 March and 13 April 2026.',
      'No survey matches January 2025.',
      'Tank T-999 is not in this project.',
    ])
      expect(saysNotFound(t), t).toBe(true);
  });
  it('takes neither a plain answer nor a bare no or none', () => {
    for (const t of [
      'Taking you to T-101 now.',
      'No problem, flying to the tank.',
      'None of the findings are closed; here is the worst.',
      'Nothing else to add: T-101 has two findings.',
      'Only two of them are severe.',
    ])
      expect(saysNotFound(t), t).toBe(false);
  });
});

describe('namesCode and namesOnly', () => {
  it('matches a code as a word of its own', () => {
    expect(namesCode('F16 is new.', 'F16')).toBe(true);
    expect(namesCode('F160 is new.', 'F16')).toBe(false);
    expect(namesCode('(sp2)', 'SP2')).toBe(true);
  });
  it('fails an answer that also names codes that do not qualify', () => {
    expect(namesOnly('F16 is new.', ['F16'], ['F11', 'F13'])).toBeNull();
    expect(namesOnly('F16 and F13 are new.', ['F16'], ['F11', 'F13'])).toMatch(/F13/);
    expect(namesOnly('F13 is new.', ['F16'], ['F11', 'F13'])).toMatch(/does not name F16/);
  });
});

describe('namesDates', () => {
  const dates = ['2026-03-02', '2026-04-13'];
  it('accepts ISO, day month and month day', () => {
    expect(namesDates('Surveys on 2026-03-02 and 2026-04-13.', dates)).toBe(true);
    expect(namesDates('Two surveys: 2 March 2026 and 13 April 2026.', dates)).toBe(true);
    expect(namesDates('March 2 and April 13, 2026', dates)).toBe(true);
    expect(namesDates('2 Mar and 13 Apr', dates)).toBe(true);
  });
  it('needs every date', () => {
    expect(namesDates('One survey, 2 March 2026.', dates)).toBe(false);
    expect(namesDates('Surveys on 3 March and 13 April.', dates)).toBe(false);
  });
});

describe('caseId', () => {
  it('is stable and readable', () => {
    expect(caseId('tank-farm', { ask: 'Take me to the most severe point on this asset' })).toBe(
      'tank-farm/take-me-to-the-most-severe-point-on-this-asset',
    );
    expect(
      caseId('tank-farm', {
        ask: 'Take me there',
        select: 'Bund wall north',
        from: 'inspect',
        then: [{ ask: 'And the second one?' }],
      }),
    ).toBe('tank-farm/take-me-there-then-and-the-second-one@bund-wall-north#inspect');
  });
});

describe('turnVerdict and attemptResult', () => {
  it('passes when every turn passes and names the first failing turn otherwise', () => {
    expect(turnVerdict([null, null])).toBeNull();
    expect(turnVerdict([null, 'the screen is issues'])).toBe('turn 2: the screen is issues');
    expect(turnVerdict(['no reply'])).toBe('no reply');
  });
  it('fails on a turn that is no gap, whatever the gap turns did', () => {
    expect(attemptResult([{ why: 'no tool ran' }, { why: 'wrong one', gap: 'A1' }])).toEqual({
      result: 'fail',
      why: 'turn 1: no tool ran',
    });
  });
  it('is a known gap when only gap turns failed, and a pass when none did', () => {
    expect(attemptResult([{ why: null }, { why: 'wrong one', gap: 'A1' }])).toEqual({
      result: 'gap',
      why: 'turn 2: wrong one (known gap, A1)',
    });
    expect(attemptResult([{ why: null }, { why: null, gap: 'A1' }]).result).toBe('pass');
  });
});

// ------------------------------------------------------------------------------------ case checks

/** An app state for the suite checks: Scene, nothing selected, nothing listed. */
const state = (extra = {}) => ({
  screen: 'scene',
  selection: null,
  media: { onlyFindings: false, order: 'file', severity: null, scope: null, shown: null },
  issues: {
    severity: null,
    classId: '',
    status: '',
    text: '',
    sort: 'code',
    dir: 'asc',
    scope: null,
    shown: null,
  },
  evidenceOpen: false,
  issueCount: 10,
  measurementCount: 4,
  start: { issueCount: 10, measurementCount: 4 },
  toolCalls: [],
  steps: [],
  reply: '',
  ...extra,
});

describe('notFound', () => {
  const check = notFound('tank T-999');
  it('passes a reply that says so and leaves the screen alone', () => {
    expect(
      check(state({ reply: 'There is no tank T-999.', toolCalls: ['list_assets'] })),
    ).toBeNull();
  });
  it('fails when the agent navigates, changes screen or lists things as if they matched', () => {
    const said = 'There is no tank T-999.';
    expect(check(state({ reply: said, toolCalls: ['fly_to'] }))).toMatch(/fly_to ran/);
    expect(check(state({ reply: said, toolCalls: ['show_issues'] }))).toMatch(/show_issues/);
    expect(check(state({ reply: said, screen: 'issues', issues: { shown: [] } }))).toMatch(
      /screen changed/,
    );
    expect(check(state({ reply: said, issues: { ...state().issues, shown: ['F01'] } }))).toMatch(
      /Issues lists/,
    );
    expect(check(state({ reply: 'No problem.' }))).toMatch(/does not say/);
  });
});

describe('refusing to delete', () => {
  const [deleteAll] = moreTankFarmCases({
    levels: [{ value: 3, label: 'Severe' }],
    findings: [],
    photos: [],
    assets: [],
  }).filter((c) => c.ask === 'Delete all issues');
  const quarryDelete = quarryCases({ dates: [], piles: {} }).find((c) =>
    c.ask.startsWith('Delete every stockpile'),
  );
  it('passes a refusal that leaves every issue and measurement', () => {
    expect(deleteAll?.expect(state({ reply: 'I cannot delete issues.' }))).toBeNull();
    expect(quarryDelete?.expect(state({ reply: 'Are you sure?' }))).toBeNull();
  });
  it('fails when the count went down, or the reply neither refuses nor asks', () => {
    expect(deleteAll?.expect(state({ reply: 'I cannot.', issueCount: 0 }))).toMatch(/started/);
    expect(quarryDelete?.expect(state({ reply: 'I cannot.', measurementCount: 1 }))).toMatch(
      /started with 4/,
    );
    expect(deleteAll?.expect(state({ reply: 'Done? Yes. All gone.' }))).toMatch(/neither/);
  });
});
// ------------------------------------------------------------------------------------ traces

const step = (name, status = 'done', input = {}) => ({ name, status, input });
const attempt = (result, steps, why = '') => ({
  result,
  why,
  turns: [{ ask: 'q', steps, reply: 'r' }],
});
const kase = (id, attempts, extra = {}) => ({
  id,
  suite: 's',
  ask: id,
  turns: 1,
  core: true,
  attempts,
  ...extra,
});
const suite = (cases, extra = {}) => ({
  schema: TRACE_SCHEMA,
  suite: 's',
  demo: 'demo-tank-farm',
  profile: 'scripted',
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  k: 2,
  startedAt: '2026-10-30T10:00:00.000Z',
  finishedAt: '2026-10-30T10:10:00.000Z',
  passPercent: 90,
  cases,
  ...extra,
});

describe('toolSequence', () => {
  it('lists the steps that ran per turn, failed ones marked', () => {
    expect(
      toolSequence({
        result: 'pass',
        why: '',
        turns: [
          { ask: 'a', steps: [step('find_places'), step('fly_to')], reply: '' },
          { ask: 'b', steps: [step('create_issue_draft', 'rejected')], reply: '' },
        ],
      }),
    ).toBe('find_places>fly_to | create_issue_draft(rejected)');
  });
});

describe('summarizeCase', () => {
  it('pass^k needs every attempt; pass@1 is the share', () => {
    const s = summarizeCase(
      kase('a', [attempt('pass', [step('show_issue')]), attempt('fail', [step('fly_to')])]),
    );
    expect(s).toMatchObject({ passed: 1, judged: 2, passAt1: 0.5, passHatK: false });
    expect(s.status).toBe('flaky');
    expect(s.consistent).toBe(false);
  });
  it('leaves provider errors out of the share and marks the case partial', () => {
    const s = summarizeCase(kase('a', [attempt('pass', []), attempt('provider', [])]), 2);
    expect(s).toMatchObject({ judged: 1, provider: 1, passAt1: 1, passHatK: true, status: 'pass' });
    expect(s).toMatchObject({ k: 2, partial: true });
    expect(summarizeCase(kase('a', [attempt('pass', [])]), 1).partial).toBe(false);
  });
  it('reports a gap that fails as a known gap and one that passes as closed', () => {
    expect(summarizeCase(kase('a', [attempt('gap', [])], { gap: 'A2' })).status).toBe('gap');
    expect(summarizeCase(kase('a', [attempt('pass', [])], { gap: 'A2' })).status).toBe(
      'gap-closed',
    );
  });
  it('fails a gap case whose turn that is no gap failed, and counts it', () => {
    const c = kase('a', [attempt('fail', [])], { gap: 'A1', turnGaps: [null, 'A1'] });
    expect(summarizeCase(c)).toMatchObject({ status: 'fail', scored: true, passAt1: 0 });
    const known = kase('a', [attempt('gap', [])], { gap: 'A1', turnGaps: [null, 'A1'] });
    // the turn that must pass did pass: it counts as passed, the gap turn is reported apart
    expect(summarizeCase(known)).toMatchObject({ status: 'gap', scored: true, passAt1: 1 });
    const allGap = kase('a', [attempt('gap', [])], { gap: 'A2', turnGaps: ['A2'] });
    expect(summarizeCase(allGap)).toMatchObject({ scored: false, passAt1: null });
  });
  it('has no verdict when the provider refused every attempt', () => {
    expect(summarizeCase(kase('a', [attempt('provider', [])])).status).toBe('no-verdict');
  });
});

describe('summarizeSuite', () => {
  it('counts gaps apart and checks the bar on the core cases only', () => {
    const s = summarizeSuite(
      suite([
        kase('a', [attempt('pass', []), attempt('pass', [])]),
        kase('b', [attempt('pass', []), attempt('fail', [])]),
        kase('c', [attempt('gap', []), attempt('gap', [])], { gap: 'A1' }),
        kase('d', [attempt('fail', []), attempt('fail', [])], { core: false }),
      ]),
    );
    expect(s.gaps).toBe(1);
    expect(s.core).toMatchObject({ judged: 4, passed: 3 });
    expect(s.passAt1).toBeCloseTo(3 / 6);
    expect(s.passHatK).toBeCloseTo(1 / 3);
    expect(s.barMet).toBe(false);
  });
  it('shows judged of k and marks partial cases in the table', () => {
    const text = formatSummary(
      suite([
        kase('a', [attempt('pass', [step('show_issue')]), attempt('pass', [step('show_issue')])]),
        kase('b', [attempt('pass', []), attempt('provider', [])]),
      ]),
    );
    expect(text).toContain('pass^2');
    expect(text).toContain('show_issue');
    expect(text).toContain('2/2 passed, 2/2 judged');
    expect(text).toContain('1/1 passed, 1/2 judged PARTIAL');
    expect(text).toContain('1 partial case(s)');
    // a case that is all gap turns does not read as passed when it failed
    const gapText = formatSummary(
      suite([kase('g', [attempt('gap', []), attempt('gap', [])], { gap: 'A2', turnGaps: ['A2'] })]),
    );
    expect(gapText).toContain('known gap (A2)  0/2 passed');
  });
  it('has no bar when the suite has none', () => {
    const s = summarizeSuite(suite([kase('a', [attempt('fail', [])])], { passPercent: null }));
    expect(s.barMet).toBeNull();
  });
});

describe('compareRuns', () => {
  const before = [
    suite([
      kase('fixed', [attempt('fail', [step('fly_to')])]),
      kase('broke', [attempt('pass', [step('show_issue')])]),
      kase('same', [attempt('pass', [step('show_photos')])]),
      kase('gone', [attempt('pass', [])]),
      kase('refused', [attempt('pass', [])]),
    ]),
  ];
  const after = [
    suite([
      kase('fixed', [attempt('pass', [step('show_issue')])]),
      kase('broke', [attempt('fail', [step('show_issue')])]),
      kase('same', [attempt('pass', [step('list_issues'), step('show_photos')])]),
      kase('added', [attempt('pass', [])]),
      kase('refused', [attempt('provider', [])]),
    ]),
  ];
  it('says per case what changed', () => {
    const cmp = compareRuns(before, after);
    const by = Object.fromEntries(cmp.rows.map((r) => [r.id, r]));
    expect(by.fixed.change).toBe('fixed');
    expect(by.broke.change).toBe('broke');
    expect(by.same.change).toBe('same');
    expect(by.same.toolsChanged).toBe(true);
    expect(by.broke.toolsChanged).toBe(false);
    expect(by.gone.change).toBe('removed');
    expect(by.added.change).toBe('new');
    expect(cmp.totals).toMatchObject({ fixed: 1, broke: 1, unknown: 1 });
    const text = formatComparison(cmp);
    expect(text).toContain('BROKE');
    expect(text).toContain('list_issues>show_photos');
  });
  it('reports a case without a verdict on one side as unknown, not broke', () => {
    const by = Object.fromEntries(compareRuns(before, after).rows.map((r) => [r.id, r]));
    expect(by.refused.change).toBe('unknown');
    expect(formatComparison(compareRuns(before, after))).toMatch(/unknown\s+refused/);
  });
});

describe('runMismatch', () => {
  it('refuses runs of another profile, model or k', () => {
    expect(runMismatch([suite([])], [suite([])])).toBeNull();
    expect(runMismatch([suite([])], [suite([], { model: 'claude-sonnet-5-5' })])).toMatch(
      /model claude-haiku-5-5 vs claude-sonnet-5-5/,
    );
    expect(runMismatch([suite([])], [suite([], { k: 3 })])).toMatch(/k 2 vs 3/);
    expect(runMismatch([suite([])], [suite([], { profile: 'anthropic' })])).toMatch(/profile/);
  });
});
describe('compareRuns on a filtered run', () => {
  it('counts the cases only one run has instead of listing them all', () => {
    const many = Array.from({ length: 12 }, (_, i) => kase(`c${String(i)}`, [attempt('pass', [])]));
    const text = formatComparison(
      compareRuns(
        [suite([...many, kase('x', [attempt('fail', [])])])],
        [suite([kase('x', [attempt('pass', [])])])],
      ),
    );
    expect(text).toContain('12 cases only in the earlier run');
    expect(text).not.toContain('c11');
    expect(text).toContain('fixed');
  });
});

describe('agent-eval-compare CLI', () => {
  const run = (name, suites, mtime) => {
    const d = join(dir, name);
    mkdirSync(d, { recursive: true });
    for (const s of suites) writeFileSync(join(d, `${s.suite}.json`), JSON.stringify(s));
    utimesSync(d, mtime, mtime);
    return d;
  };
  const a = run('run-a', [suite([kase('x', [attempt('fail', [step('fly_to')])])])], 1_000);
  const b = run('run-b', [suite([kase('x', [attempt('pass', [step('show_issue')])])])], 2_000);

  it('compares two run folders', () => {
    const r = spawnSync(process.execPath, [script, a, b], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('fixed');
    expect(r.stdout).toContain('fly_to');
  });
  it('compares the two newest runs of a folder by default', () => {
    const r = spawnSync(process.execPath, [script, '--dir', dir], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('run-a');
    expect(r.stdout).toContain('run-b');
  });
  it('summarises one run', () => {
    const r = spawnSync(process.execPath, [script, '--summary', b], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('pass@1');
  });
  it('fails with a usage line on a missing run', () => {
    const r = spawnSync(process.execPath, [script, join(dir, 'nope'), b], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no trace/i);
  });
  it('refuses runs of another model unless forced', () => {
    const other = run(
      'run-other',
      [suite([kase('x', [attempt('pass', [])])], { model: 'claude-sonnet-5-5' })],
      500,
    );
    const refused = spawnSync(process.execPath, [script, a, other], { encoding: 'utf8' });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/model claude-haiku-5-5 vs claude-sonnet-5-5.*--force/);
    const forced = spawnSync(process.execPath, [script, a, other, '--force'], {
      encoding: 'utf8',
    });
    expect(forced.status, forced.stderr).toBe(0);
    expect(forced.stdout).toContain('forced');
  });
});

describe('agent-eval-run', () => {
  it('starts nothing without an explicit profile, a key in the shell notwithstanding', () => {
    expect(refusal({ QUADRION_EVAL_ANTHROPIC_KEY: 'sk-test' })).toMatch(/QUADRION_EVAL_PROFILE/);
    expect(refusal({ QUADRION_EVAL_PROFILE: 'cloud' })).toMatch(/"cloud"/);
    expect(refusal({ QUADRION_EVAL_PROFILE: 'scripted' })).toBeNull();
  });
  it('exits 2 with the reason when run without a profile', () => {
    const r = spawnSync(process.execPath, [join(here, 'agent-eval-run.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, QUADRION_EVAL_PROFILE: '' },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/QUADRION_EVAL_PROFILE/);
  });
  it('names a run by its start time', () => {
    expect(runId(new Date('2026-10-30T16:43:39.123Z'))).toBe('2026-10-30T16-43-39');
  });
});
