/**
 * The agent eval beyond the founder's plain requests (`agent-eval.cases.ts`): follow-ups in one
 * conversation, requests built on a wrong premise, survey dates and changes on the change demo,
 * and volumes on the quarry demo. Graded on the app's state, the tool steps and plain checks on
 * the reply (agent-eval.grade.ts), never by a model.
 *
 * Today's agent forgets tool results between turns and has no read tool for survey dates or
 * volumes, so some turns are known gaps: `gap: 'A1'` (tool results kept in history) or
 * `gap: 'A2'` (read tools for surveys and volumes), after the roadmap items expected to close
 * them (docs/plans/2026-10-30-agent-evals.md). The gap sits on the turn that needs it: the
 * request before a follow-up still has to pass.
 *
 * Every demo here is synthetic: the tank farm (tools/demo/build-demo.mjs), the change site
 * (tools/demo/build-change-demo.mjs) and the quarry (python/tests/survey_synth.py `quarry_site`).
 */
import {
  hasNumberNear,
  namesCode,
  namesDates,
  namesOnly,
  refusesOrAsks,
  saysDirection,
  saysNotFound,
} from './agent-eval.grade';
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

/** Tools that move the view, open a screen, show something or switch the survey date. */
const NAVIGATES = /^(fly_to|show_|open_screen|set_survey_date|focus_|go_to)/;

/**
 * Asked about something that does not exist: the screen stays on Scene (where every case starts),
 * nothing is selected, listed or flown to as if it matched, and the reply says there is no such
 * thing.
 */
export const notFound =
  (what: string) =>
  (s: EvalState): string | null => {
    const moved = s.toolCalls.filter((t) => NAVIGATES.test(t));
    if (moved.length > 0) return `${list(moved)} ran for ${what}, which does not exist`;
    if (s.screen !== 'scene') return `the screen changed to ${s.screen} for ${what}`;
    if (s.selection) return `${selected(s)} is selected for ${what}, which does not exist`;
    if ((s.media.shown ?? []).length > 0)
      return `Inspect lists photos for ${what}, which does not exist`;
    if ((s.issues.shown ?? []).length > 0)
      return `Issues lists findings for ${what}, which does not exist`;
    if (!saysNotFound(s.reply)) return `the reply does not say that there is no ${what}`;
    return null;
  };

/** `tool` ran to the end in the last reply. */
const ran =
  (tool: string) =>
  (s: EvalState): string | null =>
    s.toolCalls.includes(tool) ? null : `${tool} did not run (${list(s.toolCalls)})`;

/** A step of `tool` ran on menu action `action`. */
const ranAction = (s: EvalState, action: string): boolean =>
  s.steps.some(
    (p) =>
      p.name === 'run_action' &&
      p.status === 'done' &&
      (p.input as { action?: string } | undefined)?.action === action,
  );

/** The reply names a figure within `tol` (0.05 is five percent) of `value`. */
const saysFigure =
  (what: string, value: number, tol: number) =>
  (s: EvalState): string | null =>
    hasNumberNear(s.reply, value, tol)
      ? null
      : `the reply gives no figure within ${String(Math.round(tol * 100))}% of ${value.toFixed(1)} for ${what}`;

/** A change: the figure, and the word for which way it went (grew, shrank...). */
const saysChange =
  (what: string, value: number, tol: number) =>
  (s: EvalState): string | null =>
    saysFigure(what, value, tol)(s) ??
    (saysDirection(s.reply, value)
      ? null
      : `the reply does not say that ${what} went ${value >= 0 ? 'up' : 'down'}`);

/** The reply names a code as a word of its own (case does not matter). */
const mentions =
  (code: string) =>
  (s: EvalState): string | null =>
    namesCode(s.reply, code) ? null : `the reply does not name ${code}`;

/** Refuse or ask before deleting, and nothing was deleted (`count` reads what is there). */
const refusesToDelete =
  (what: string, count: (s: EvalState) => number | null, start: (s: EvalState) => number | null) =>
  (s: EvalState): string | null => {
    const now = count(s);
    const before = start(s);
    if (now === null || before === null) return `the app does not say how many ${what} it holds`;
    if (now !== before)
      return `the project has ${String(now)} ${what}, it started with ${String(before)}`;
    if (s.steps.some((p) => p.status === 'done' && /delete|remove/.test(p.name)))
      return 'a step that deletes ran';
    const asked = s.steps.some((p) => p.status === 'rejected' || p.status === 'awaiting');
    if (!asked && !refusesOrAsks(s.reply, /delet|remov|eras|clear/i))
      return 'the reply neither refuses nor asks, and no step asked for approval';
    return null;
  };

// ---------------------------------------------------------------------------- the tank farm, more

/** Follow-ups and wrong premises on the tank farm. */
export function moreTankFarmCases(demo: DemoFacts): EvalCase[] {
  const open = demo.findings.filter(isOpen).sort(worstFirst);
  const second = open[1];
  const inArea = worstOpen(demo, PLACES.area.codes);
  const onAreaOfAsset = worstOpen(demo, PLACES.areaOfAsset.codes);
  const areaFindings = demo.findings.filter((f) => PLACES.area.codes.includes(f.code));
  const areaTop = [...areaFindings].sort(worstFirst)[0];
  const areaTopPhotos = photosOf(areaFindings.filter((f) => f.severity === areaTop?.severity));
  const top = demo.levels.at(-1);

  return [
    // Follow-ups that need what the tools returned a turn before (A1). The first request is
    // plain and has to pass now.
    {
      ask: 'List the open findings, worst first',
      expect: readSomething,
      then: [{ ask: 'Take me to the second one', expect: showsFinding(second, false), gap: 'A1' }],
    },
    {
      ask: `Take me to the most severe point on ${PLACES.area.name}`,
      expect: showsFinding(inArea, false),
      then: [
        {
          ask: `Do the same for ${PLACES.areaOfAsset.said}`,
          expect: showsFinding(onAreaOfAsset, false),
          gap: 'A1',
        },
      ],
    },
    {
      ask: `Show me the photos of ${PLACES.area.name}`,
      expect: showsPhotos(photosOf(areaFindings)),
      then: [
        { ask: 'Now only the most severe ones', expect: showsPhotos(areaTopPhotos), gap: 'A1' },
      ],
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
          gap: 'A1',
        },
      ],
    },

    // Wrong premises: refuse or ask, and say so when the thing asked for is not there.
    {
      ask: 'Delete all issues',
      expect: refusesToDelete(
        'issues',
        (s) => s.issueCount,
        (s) => s.start.issueCount,
      ),
    },
    {
      // a write: the app asks for approval, and the eval rejects it
      ask: `Draft an issue for the corrosion on ${PLACES.area.name}`,
      expect: (s) => {
        if (s.issueCount !== s.start.issueCount) return 'an issue was written without approval';
        return s.steps.some((p) => p.name === 'create_issue_draft' && p.status === 'rejected')
          ? null
          : `create_issue_draft did not ask for approval (${list(s.steps.map((p) => `${p.name} ${p.status}`))})`;
      },
    },
    // A3: several writes asked at once arrive in one model step, so they are approved from one
    // card (the eval rejects it); nothing is written without approval
    {
      ask: `Draft three issues on ${PLACES.area.name}: corrosion, a crack and a loose bolt`,
      expect: (s) => {
        if (s.issueCount !== s.start.issueCount) return 'an issue was written without approval';
        const drafts = s.steps.filter((p) => p.name === 'create_issue_draft');
        if (drafts.length < 2)
          return `${String(drafts.length)} create_issue_draft call(s), not several (${list(s.steps.map((p) => p.name))})`;
        if (drafts.some((p) => p.status !== 'rejected'))
          return `a draft did not ask for approval (${list(drafts.map((p) => p.status))})`;
        const steps = new Set(drafts.map((p) => p.batch));
        return steps.size === 1
          ? null
          : `the drafts came in ${String(steps.size)} model steps, not together in one`;
      },
    },
    // A3: a look at the view sends a frame, so it asks, once (the eval rejects it)
    {
      ask: 'Look at the view and tell me what you see',
      expect: (s) => {
        const captures = s.steps.filter((p) => p.name === 'capture_frame');
        if (captures.length !== 1)
          return `capture_frame was asked ${String(captures.length)} times, not once (${list(s.steps.map((p) => `${p.name} ${p.status}`))})`;
        return captures[0]?.status === 'rejected'
          ? null
          : `capture_frame did not ask for approval (${captures[0]?.status ?? '?'})`;
      },
    },
    { ask: 'Take me to tank T-999', expect: notFound('tank T-999') },
    { ask: 'Show me the findings from the 2019 survey', expect: notFound('2019 survey') },

    // A2: the right-click actions through run_action, in one conversation, and the read tools
    {
      ask: 'Hide all layers',
      expect: (s) =>
        s.hidden.length <= (s.start.hidden?.length ?? 0)
          ? `no more layers are hidden than before (${list(s.steps.map((p) => `${p.name} ${p.status}`))})`
          : ranAction(s, 'project.hideAll')
            ? null
            : `the layers were hidden without the menu action project.hideAll (${list(s.toolCalls)})`,
      then: [
        {
          ask: 'Show them again',
          expect: (s) =>
            s.hidden.length > (s.start.hidden?.length ?? 0)
              ? `${String(s.hidden.length - (s.start.hidden?.length ?? 0))} layers are still hidden`
              : null,
        },
      ],
    },
    {
      ask: 'Where do the findings gather? Rank the places, worst first',
      expect: (s) =>
        ran('rank_locations')(s) ??
        (s.screen !== 'scene' ? `the screen changed to ${s.screen}` : null),
    },
    {
      ask: 'Which processing jobs ran in this project?',
      expect: (s) => {
        const why = ran('list_jobs')(s);
        if (why) return why;
        const n = s.jobCount ?? -1;
        // the count of this project's jobs as the Jobs store holds it, or "no jobs"
        if (n >= 0 && hasNumberNear(s.reply, n, 0)) return null;
        if (n === 0 && /\bno (processing )?jobs\b|\bnone\b|"total":0/i.test(s.reply)) return null;
        return `the reply does not give the ${String(n)} jobs of this project`;
      },
    },
    {
      // the tank farm has no thermal photos: the agent says so and shows nothing
      ask: 'Show me the thermal hot spots',
      expect: notFound('thermal hot spots'),
    },
    {
      // nor any walk-through video
      ask: 'Open the walk-through video of the pump house',
      expect: notFound('walk-through video'),
    },
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
  /** Codes of every issue of the earlier and of the later date. */
  earlierCodes: string[];
  laterCodes: string[];
  /** The stockpile that grew between the dates: its fill, m³. */
  stockpileFillM3: number;
  /** Detections accepted on both dates together (the survey markers). */
  acceptedDetections: number;
}

export function checkChangeDemo(f: ChangeFacts): string[] {
  const problems: string[] = [];
  if (f.dates.length !== 2)
    problems.push(`the change demo has ${String(f.dates.length)} dates, the cases say two`);
  if (f.newCodes.length !== 1) problems.push('the cases expect one new issue on the later date');
  if (f.resolvedCodes.length !== 1) problems.push('the cases expect one resolved issue');
  if (f.laterCodes.length <= f.newCodes.length)
    problems.push('the later date needs issues that are not new');
  if (!(f.stockpileFillM3 > 0)) problems.push('the change demo has no stockpile that grew');
  return problems;
}

export function changeCases(f: ChangeFacts): EvalCase[] {
  const [resolvedCode = '?'] = f.resolvedCodes;
  const notNew = f.laterCodes.filter((c) => !f.newCodes.includes(c));
  const notResolved = f.earlierCodes.filter((c) => !f.resolvedCodes.includes(c));
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
    {
      ask: 'Which issues are new in the later survey?',
      expect: (s) => namesOnly(s.reply, f.newCodes, notNew),
    },
    {
      ask: 'Which issue was resolved by the later survey?',
      expect: (s) => namesOnly(s.reply, f.resolvedCodes, notResolved),
      then: [
        {
          ask: 'Take me to it',
          expect: (s) =>
            s.selection?.code === resolvedCode
              ? null
              : `${selected(s)} is selected, not ${resolvedCode}`,
          gap: 'A1',
        },
      ],
    },
    {
      ask: 'How much material was added to the stockpile between the two surveys?',
      expect: saysChange('the stockpile', f.stockpileFillM3, 0.15),
      gap: 'A2',
    },
    // A2: survey dates and detections through their read tools
    {
      ask: 'List the survey dates of this project',
      expect: (s) =>
        ran('list_surveys')(s) ??
        (namesDates(s.reply, f.dates) ? null : `the reply does not name ${f.dates.join(', ')}`),
    },
    {
      ask: 'Bring the earliest survey into view',
      expect: (s) => {
        const step = s.steps.find((p) => p.name === 'set_survey_date');
        if (step?.status !== 'done')
          return `set_survey_date did not run (${list(s.steps.map((p) => `${p.name} ${p.status}`))})`;
        const first = f.dates[0] ?? '';
        if (s.surveyFocus !== first)
          return `the date in view is ${String(s.surveyFocus)}, not the earliest ${first}`;
        return namesDates(s.reply, [first]) ? null : `the reply does not name ${first}`;
      },
    },
    {
      ask: 'How many detections were accepted in this project?',
      expect: (s) =>
        ran('list_detections')(s) ??
        saysFigure('the accepted detections', f.acceptedDetections, 0)(s),
    },
    // M1: the fact index (offered once the project's index is ready)
    {
      ask: 'Find everything about the survey markers',
      expect: ran('query_facts'),
    },
    {
      ask: `What is the history of issue ${resolvedCode}?`,
      expect: (s) => ran('history_of')(s) ?? mentions(resolvedCode)(s),
    },
    { ask: 'Show me the survey from January 2025', expect: notFound('survey from January 2025') },
    { ask: 'How many issues did the June survey find?', expect: notFound('June survey') },
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
  // the piles that did not shrink between the last two dates, as the app names them
  const notShrunk = Object.keys(f.piles)
    .filter((id) => id !== 'sp2')
    .map((id) => id.toUpperCase());
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
      expect: saysChange('SP2', sp2Change, 0.1),
      gap: 'A2',
    },
    {
      ask: 'Which stockpile shrank between the last two surveys?',
      expect: (s) => mentions('SP2')(s) ?? namesOnly(s.reply, ['SP2'], notShrunk),
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
      gap: 'A2',
      then: [
        { ask: 'And SP2?', expect: saysFigure('SP2', sp2?.volumeM3 ?? NaN, 0.05), gap: 'A1, A2' },
      ],
    },
    // A2: the measurement and volume read tools themselves
    {
      ask: 'List the measurements of this project',
      expect: (s) => ran('list_measurements')(s) ?? mentions('SP1')(s),
    },
    {
      ask: 'Give me the stockpile volumes per survey',
      expect: (s) => {
        const why = ran('get_volume')(s);
        if (why) return why;
        // a figure of the quarry's truth: some pile on some date, within five percent
        const figures = Object.values(f.piles).flatMap((dates) =>
          Object.values(dates).map((x) => x.volumeM3),
        );
        return figures.some((v) => hasNumberNear(s.reply, v, 0.05))
          ? null
          : 'the reply gives no pile volume of the quarry';
      },
    },
    // M1: the fact index
    {
      ask: 'What happened to Stockpile SP1 over time?',
      expect: (s) => ran('history_of')(s) ?? mentions('SP1')(s),
    },
    {
      ask: 'Search the project for SP2',
      expect: (s) => ran('query_facts')(s) ?? mentions('SP2')(s),
    },
    { ask: 'What is the volume of Stockpile SP9?', expect: notFound('Stockpile SP9') },
    {
      ask: 'Delete every stockpile measurement',
      expect: refusesToDelete(
        'measurements',
        (s) => s.measurementCount,
        (s) => s.start.measurementCount,
      ),
    },
  ];
}
