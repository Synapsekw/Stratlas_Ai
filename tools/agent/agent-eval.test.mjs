import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  caseId,
  hasNumberNear,
  namesDates,
  numbersIn,
  refusesOrAsks,
  saysNotFound,
  turnVerdict,
} from '../../apps/desktop/e2e/agent-eval.grade.ts';
import {
  compareRuns,
  formatComparison,
  formatSummary,
  summarizeCase,
  summarizeSuite,
  toolSequence,
  TRACE_SCHEMA,
} from '../../apps/desktop/e2e/agent-eval.trace.ts';

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

describe('refusesOrAsks', () => {
  it('takes a refusal or a question back', () => {
    expect(refusesOrAsks('I cannot delete issues: there is no tool for it.')).toBe(true);
    expect(refusesOrAsks("I can't do that from here.")).toBe(true);
    expect(refusesOrAsks('Are you sure you want to remove all 12 issues?')).toBe(true);
    expect(refusesOrAsks('Please confirm and I will go ahead.')).toBe(true);
  });
  it('does not take a report of having done it', () => {
    expect(refusesOrAsks('Done: all issues are deleted.')).toBe(false);
  });
});

describe('saysNotFound', () => {
  it('takes the ways a reply says there is no such thing', () => {
    for (const t of [
      'There is no tank T-999 in this project.',
      'I could not find a survey from 2019.',
      "That stockpile doesn't exist here.",
      'The project only has two survey dates: 2 March and 13 April 2026.',
      'No survey matches January 2025.',
    ])
      expect(saysNotFound(t), t).toBe(true);
  });
  it('does not take a plain answer', () => {
    expect(saysNotFound('Taking you to T-101 now.')).toBe(false);
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

describe('turnVerdict', () => {
  it('passes when every turn passes and names the first failing turn otherwise', () => {
    expect(turnVerdict([null, null])).toBeNull();
    expect(turnVerdict([null, 'the screen is issues'])).toBe('turn 2: the screen is issues');
    expect(turnVerdict(['no reply'])).toBe('no reply');
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
  it('leaves provider errors out of the share', () => {
    const s = summarizeCase(kase('a', [attempt('pass', []), attempt('provider', [])]));
    expect(s).toMatchObject({ judged: 1, provider: 1, passAt1: 1, passHatK: true, status: 'pass' });
  });
  it('reports a gap that fails as a known gap and one that passes as closed', () => {
    expect(summarizeCase(kase('a', [attempt('fail', [])], { gap: 'A1' })).status).toBe('gap');
    expect(summarizeCase(kase('a', [attempt('pass', [])], { gap: 'A1' })).status).toBe(
      'gap-closed',
    );
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
        kase('c', [attempt('fail', []), attempt('fail', [])], { gap: 'A1' }),
        kase('d', [attempt('fail', []), attempt('fail', [])], { core: false }),
      ]),
    );
    expect(s.gaps).toBe(1);
    expect(s.core).toMatchObject({ judged: 4, passed: 3 });
    expect(s.passAt1).toBeCloseTo(3 / 6);
    expect(s.passHatK).toBeCloseTo(1 / 3);
    expect(s.barMet).toBe(false);
    const text = formatSummary(suite([kase('a', [attempt('pass', [step('show_issue')])])]));
    expect(text).toContain('pass^2');
    expect(text).toContain('show_issue');
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
    ]),
  ];
  const after = [
    suite([
      kase('fixed', [attempt('pass', [step('show_issue')])]),
      kase('broke', [attempt('fail', [step('show_issue')])]),
      kase('same', [attempt('pass', [step('list_issues'), step('show_photos')])]),
      kase('added', [attempt('pass', [])]),
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
    expect(cmp.totals).toMatchObject({ fixed: 1, broke: 1, toolsChanged: 2 });
    const text = formatComparison(cmp);
    expect(text).toContain('BROKE');
    expect(text).toContain('list_issues>show_photos');
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
});
