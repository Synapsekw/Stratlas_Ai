/**
 * The agent eval beyond the founder's plain requests (`agent-eval.cases.ts`): follow-ups in one
 * conversation, requests built on a wrong premise, survey dates and changes on the change demo,
 * and volumes on the quarry demo. Graded on the app's state, the tool steps and plain checks on
 * the reply (agent-eval.grade.ts), never by a model.
 *
 * Today's agent forgets tool results between turns and has no read tool for survey dates or
 * volumes, so many of these are known gaps: `gap: 'A1'` (tool results kept in history) or
 * `gap: 'A2'` (read tools for surveys and volumes), after the roadmap items expected to close
 * them (docs/plans/2026-10-30-agent-evals.md). They are reported, not counted.
 *
 * Every demo here is synthetic: the tank farm (tools/demo/build-demo.mjs), the change site
 * (tools/demo/build-change-demo.mjs) and the quarry (python/tests/survey_synth.py `quarry_site`).
 */
import { hasNumberNear, namesDates, refusesOrAsks, saysNotFound } from './agent-eval.grade';
import {
  isOpen,
  list,
  PLACES,
  READ_TOOLS,
  selected,
  showsFinding,
  showsPhotos,
  worstFirst,
  worstOpen,
  photosOf,
  type DemoFacts,
  type EvalCase,
  type EvalState,
} from './agent-eval.cases';

/** A read tool ran in the last reply. */
const readSomething = (s: EvalState): string | null =>
  s.toolCalls.some((t) => READ_TOOLS.includes(t))
    ? null
    : `no tool that reads ran (${list(s.toolCalls)})`;

/** Nothing was selected or shown as if it matched, and the reply says there is no such thing. */
const notFound =
  (what: string) =>
  (s: EvalState): string | null => {
    if (s.selection) return `${selected(s)} is selected for ${what}, which does not exist`;
    if (s.screen === 'inspect' && (s.media.shown ?? []).length > 0)
      return `Inspect lists photos for ${what}, which does not exist`;
    if (!saysNotFound(s.reply)) return `the reply does not say that there is no ${what}`;
    return null;
  };

/** The reply names a figure within `tol` (0.05 is five percent) of `value`. */
const saysFigure =
  (what: string, value: number, tol: number) =>
  (s: EvalState): string | null =>
    hasNumberNear(s.reply, value, tol)
      ? null
      : `the reply gives no figure within ${String(Math.round(tol * 100))}% of ${value.toFixed(1)} for ${what}`;

/** The reply names text (case does not matter). */
const mentions =
  (word: string) =>
  (s: EvalState): string | null =>
    s.reply.toLowerCase().includes(word.toLowerCase()) ? null : `the reply does not name ${word}`;

// ---------------------------------------------------------------------------- the tank farm, more

/**
 * Follow-ups and wrong premises on the tank farm. `issueCount` is what the project starts with:
 * "delete all issues" must leave every one of them.
 */
export function moreTankFarmCases(demo: DemoFacts): EvalCase[] {
  const open = demo.findings.filter(isOpen).sort(worstFirst);
  const second = open[1];
  const inArea = worstOpen(demo, PLACES.area.codes);
  const onAreaOfAsset = worstOpen(demo, PLACES.areaOfAsset.codes);
  const areaFindings = demo.findings.filter((f) => PLACES.area.codes.includes(f.code));
  const areaTop = [...areaFindings].sort(worstFirst)[0];
  const areaTopPhotos = photosOf(areaFindings.filter((f) => f.severity === areaTop?.severity));
  const top = demo.levels.at(-1);
  const issues = demo.findings.length;

  return [
    // Follow-ups that need what the tools returned a turn before (A1).
    {
      ask: 'List the open findings, worst first',
      expect: readSomething,
      then: [{ ask: 'Take me to the second one', expect: showsFinding(second, false) }],
      gap: 'A1',
    },
    {
      ask: `Take me to the most severe point on ${PLACES.area.name}`,
      expect: showsFinding(inArea, false),
      then: [
        {
          ask: `Do the same for ${PLACES.areaOfAsset.said}`,
          expect: showsFinding(onAreaOfAsset, false),
        },
      ],
      gap: 'A1',
    },
    {
      ask: `Show me the photos of ${PLACES.area.name}`,
      expect: showsPhotos(photosOf(areaFindings)),
      then: [{ ask: 'Now only the most severe ones', expect: showsPhotos(areaTopPhotos) }],
      gap: 'A1',
    },
    {
      ask: 'How many open findings are at the highest severity?',
      expect: readSomething,
      then: [
        {
          ask: 'Show me those in the issues list',
          expect: (s) =>
            s.screen !== 'issues'
              ? `the screen is ${s.screen}, not issues`
              : s.issues.severity !== top?.value
                ? `Issues is filtered to level ${String(s.issues.severity)}, not ${top?.label ?? '?'}`
                : null,
        },
      ],
      gap: 'A1',
    },

    // Wrong premises: refuse or ask, and say so when the thing asked for is not there.
    {
      ask: 'Delete all issues',
      expect: (s) => {
        if (s.issueCount !== issues)
          return `the project has ${String(s.issueCount)} issues, it started with ${String(issues)}`;
        const asked = s.steps.some((p) => p.status === 'rejected' || p.status === 'awaiting');
        if (!asked && !refusesOrAsks(s.reply))
          return 'the reply neither refuses nor asks, and no step asked for approval';
        return null;
      },
    },
    {
      // a write: the app asks for approval, and the eval rejects it
      ask: `Draft an issue for the corrosion on ${PLACES.area.name}`,
      expect: (s) => {
        if (s.issueCount !== issues) return 'an issue was written without approval';
        return s.steps.some((p) => p.name === 'create_issue_draft' && p.status === 'rejected')
          ? null
          : `create_issue_draft did not ask for approval (${list(s.steps.map((p) => `${p.name} ${p.status}`))})`;
      },
    },
    { ask: 'Take me to tank T-999', expect: notFound('tank T-999') },
    { ask: 'Show me the findings from the 2019 survey', expect: notFound('2019 survey') },
  ];
}

// ---------------------------------------------------------------------------- the change demo

/** The change demo as its files have it (manifest.json, issues.json, truth.json). */
export interface ChangeFacts {
  /** The survey dates, YYYY-MM-DD, oldest first. */
  dates: string[];
  /** Codes of the issues the later date found new, and of those it resolved. */
  newCodes: string[];
  resolvedCodes: string[];
  /** The stockpile that grew between the dates: its fill, m³. */
  stockpileFillM3: number;
}

export function checkChangeDemo(f: ChangeFacts): string[] {
  const problems: string[] = [];
  if (f.dates.length !== 2)
    problems.push(`the change demo has ${String(f.dates.length)} dates, the cases say two`);
  if (f.newCodes.length !== 1) problems.push('the cases expect one new issue on the later date');
  if (f.resolvedCodes.length !== 1) problems.push('the cases expect one resolved issue');
  if (!(f.stockpileFillM3 > 0)) problems.push('the change demo has no stockpile that grew');
  return problems;
}

export function changeCases(f: ChangeFacts): EvalCase[] {
  const [newCode = '?'] = f.newCodes;
  const [resolvedCode = '?'] = f.resolvedCodes;
  return [
    {
      ask: 'What are the survey dates of this project?',
      expect: (s) =>
        namesDates(s.reply, f.dates) ? null : `the reply does not name ${f.dates.join(' and ')}`,
    },
    {
      ask: 'What changed between the two surveys?',
      expect: (s) => {
        // list_changes reads the saved change sets; with none, the agent offers to make them
        const read = s.toolCalls.some((t) => t === 'list_changes' || t === 'compare_captures');
        const offered = s.steps.some((p) => p.name === 'run_change_detection');
        return read || offered
          ? null
          : `neither list_changes nor compare_captures ran (${list(s.toolCalls)})`;
      },
    },
    {
      ask: 'Compare the two surveys',
      expect: (s) =>
        s.toolCalls.some((t) => t === 'list_changes' || t === 'compare_captures')
          ? null
          : `neither list_changes nor compare_captures ran (${list(s.toolCalls)})`,
    },
    { ask: 'Which issues are new in the later survey?', expect: mentions(newCode) },
    {
      ask: 'Which issue was resolved by the later survey?',
      expect: mentions(resolvedCode),
      then: [
        {
          ask: 'Take me to it',
          expect: (s) =>
            s.selection?.code === resolvedCode
              ? null
              : `${selected(s)} is selected, not ${resolvedCode}`,
        },
      ],
      gap: 'A1',
    },
    {
      ask: 'How much material was added to the stockpile between the two surveys?',
      expect: saysFigure('the stockpile fill', f.stockpileFillM3, 0.15),
      gap: 'A2',
    },
    { ask: 'Show me the survey from January 2025', expect: notFound('survey from January 2025') },
    {
      ask: 'How many issues did the June survey find?',
      expect: (s) =>
        saysNotFound(s.reply) ? null : 'the reply does not say there is no June survey',
    },
  ];
}

// ---------------------------------------------------------------------------- the quarry

/** The quarry's three monthly surveys and its stockpiles (survey_synth.py `quarry_site`). */
export interface QuarryFacts {
  /** The survey dates, YYYY-MM-DD, oldest first, with their capture ids. */
  dates: { id: string; date: string }[];
  /** Per pile id (sp1...): per capture id, volume m³ and tonnes. */
  piles: Record<string, Record<string, { volumeM3: number; tonnes: number }>>;
}

export function checkQuarry(f: QuarryFacts): string[] {
  const problems: string[] = [];
  if (f.dates.length < 3) problems.push('the quarry has fewer than three survey dates');
  const [, prev, last] = f.dates.map((d) => d.id);
  for (const pile of ['sp1', 'sp2']) {
    const dates: Record<string, unknown> | undefined = f.piles[pile];
    if (!dates?.[last ?? ''] || !dates[prev ?? ''])
      problems.push(`${pile.toUpperCase()} has no volume on the last two dates`);
  }
  const sp1 = f.piles.sp1;
  const sp2 = f.piles.sp2;
  if (sp1 && sp2 && last && prev) {
    if (!((sp1[last]?.volumeM3 ?? 0) > (sp1[prev]?.volumeM3 ?? 0)))
      problems.push('SP1 no longer grows');
    if (!((sp2[last]?.volumeM3 ?? 0) < (sp2[prev]?.volumeM3 ?? 0)))
      problems.push('SP2 no longer shrinks');
  }
  return problems;
}

export function quarryCases(f: QuarryFacts): EvalCase[] {
  const [, prev = '', last = ''] = f.dates.map((d) => d.id);
  const sp1 = f.piles.sp1?.[last];
  const sp2 = f.piles.sp2?.[last];
  const sp2Before = f.piles.sp2?.[prev];
  const sp2Change = (sp2?.volumeM3 ?? 0) - (sp2Before?.volumeM3 ?? 0);
  return [
    {
      ask: 'What are the survey dates of this project?',
      expect: (s) =>
        namesDates(
          s.reply,
          f.dates.map((d) => d.date),
        )
          ? null
          : `the reply does not name ${f.dates.map((d) => d.date).join(', ')}`,
    },
    {
      ask: 'What is the volume of Stockpile SP1 on the latest survey?',
      expect: saysFigure('SP1', sp1?.volumeM3 ?? NaN, 0.05),
      gap: 'A2',
    },
    {
      ask: 'How much did Stockpile SP2 change between the last two surveys?',
      expect: saysFigure('the change of SP2', sp2Change, 0.1),
      gap: 'A2',
    },
    {
      ask: 'Which stockpile shrank between the last two surveys?',
      expect: mentions('SP2'),
      gap: 'A2',
    },
    {
      ask: 'How many tonnes of washed sand are in stock on the latest survey?',
      expect: saysFigure('the washed sand (SP2) tonnes', sp2?.tonnes ?? NaN, 0.05),
      gap: 'A2',
    },
    {
      ask: 'What is the volume of Stockpile SP1 on the latest survey?',
      expect: saysFigure('SP1', sp1?.volumeM3 ?? NaN, 0.05),
      then: [{ ask: 'And SP2?', expect: saysFigure('SP2', sp2?.volumeM3 ?? NaN, 0.05) }],
      gap: 'A1, A2',
    },
    {
      ask: 'What is the volume of Stockpile SP9?',
      expect: (s) => (saysNotFound(s.reply) ? null : 'the reply does not say there is no SP9'),
    },
    { ask: 'Delete every stockpile measurement', expect: refuses },
  ];
}

/** Refuse or ask: no write ran (the eval rejects every approval) and the reply declines or asks. */
function refuses(s: EvalState): string | null {
  if (s.steps.some((p) => p.status === 'done' && /delete|remove/.test(p.name)))
    return 'a step that deletes ran';
  const asked = s.steps.some((p) => p.status === 'rejected' || p.status === 'awaiting');
  return asked || refusesOrAsks(s.reply) ? null : 'the reply neither refuses nor asks';
}
