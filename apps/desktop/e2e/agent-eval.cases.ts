/**
 * The plain requests of the real-model check (`agent-eval.spec.ts`) and what each must leave on
 * the screen. A real model words its answer differently every time, so a case reads the state of
 * the app and the tools that ran. The reply is read only where the request is answered in words:
 * a severity level by its name, or that nothing matched.
 *
 * The requests are about the tank farm demo (tools/demo/build-demo.mjs, synthetic). What a case
 * expects is worked out from the demo's own files (`DemoFacts`, read by the spec) wherever the
 * files say it. Which finding sits on which asset is not in the files: the app works that out
 * from positions, so the places below are pinned from the generator, and `checkDemo` says before
 * any token is spent when the demo no longer matches them.
 */

/** A severity as a finding carries it. */
export type EvalLevel = number | 'uncertain';

/** The app after a reply: read from `window.__stratlas` and the steps of the agent panel. */
export interface EvalState {
  /** The screen that shows: scene, issues, inspect, reports. */
  screen: string;
  /** What is selected; `code` is the finding's code when a finding is selected. */
  selection: { kind: string; id: string; code: string | null } | null;
  /** The Inspect photo filter. `shown` is the photos Inspect lists, in order; null on another screen. */
  media: {
    onlyFindings: boolean;
    order: string;
    severity: EvalLevel | null;
    scope: { label: string; photos: string[] } | null;
    shown: string[] | null;
  };
  /** The Issues filter. `shown` is the codes the register lists, in order; null on another screen. */
  issues: {
    severity: EvalLevel | null;
    classId: string;
    status: string;
    text: string;
    sort: string;
    dir: string;
    scope: { label: string; codes: string[] } | null;
    shown: string[] | null;
  };
  /** A finding's photo is open beside the 3D view. */
  evidenceOpen: boolean;
  /** The tools that ran to the end, in order. A step that failed or was rejected is not here. */
  toolCalls: string[];
  /** What the agent said. */
  reply: string;
}

export interface EvalCase {
  /** What the person types. */
  ask: string;
  /** The tag of an asset that is selected when the request is typed. */
  select?: string;
  /** The screen the request is typed on; Scene when left out. */
  from?: 'inspect' | 'issues';
  /** Null when the app did what was asked, else the reason it did not, in a few words. */
  expect: (state: EvalState) => string | null;
  /** A remark for the table whatever the verdict, such as whether the photo opened. */
  note?: (state: EvalState) => string;
}

export interface DemoFinding {
  code: string;
  severity: EvalLevel;
  status: string;
  /** Ids of the photos it is marked on. */
  photos: string[];
  /** It has a place on the 3D model. */
  placed: boolean;
}

/** The tank farm as its files have it (manifest.json, issues.json). */
export interface DemoFacts {
  /** The severity levels, lowest first. */
  levels: { value: number; label: string }[];
  findings: DemoFinding[];
  /** Ids of every photo. */
  photos: string[];
  /** The tagged assets with their area. */
  assets: { tag: string; area: string | null }[];
}

/**
 * Where the generator puts the findings (tools/demo/scene.mjs). The app links a finding to the
 * smallest tagged asset around its position, which the demo's files do not record.
 */
const PLACES: {
  asset: { tag: string; codes: readonly string[] };
  areaOfAsset: { name: string; said: string; codes: readonly string[] };
  area: { name: string; codes: readonly string[] };
  bare: { tag: string; said: string };
} = {
  /** One asset with one finding, which is not the project's worst. */
  asset: { tag: 'Bund wall north', codes: ['F03'] },
  /** The area of that asset, with the same one finding. */
  areaOfAsset: { name: 'Bund', said: 'the bund', codes: ['F03'] },
  /** An area with two findings, neither of them the project's worst. */
  area: { name: 'Tank T-101', codes: ['F01', 'F02'] },
  /** An asset with no finding on it or near it. */
  bare: { tag: 'Control building', said: 'the control building' },
};

/** The founder's two requests, word for word. */
const TAKE_ME = 'Take me to the most severe point on this asset';
const OPEN_IMAGES = 'Open up images with the highest level of severity';

/**
 * The tools that only read (`risk: 'read'` in packages/ai/src/tools.ts, show-tool-specs.ts,
 * change-tool-specs.ts and collab-tool-specs.ts). A question is answered with one of these and
 * leaves the screen alone.
 */
const READ_TOOLS: readonly string[] = [
  'list_layers',
  'list_clips',
  'find_clips_near',
  'find_places',
  'list_issues',
  'summarize_issues',
  'compare_captures',
  'measure_distance',
  'summarize_by_zone',
  'summarize_by_class',
  'find_issues_near',
  'list_sites',
  'accuracy_summary',
  'list_changes',
  'list_my_work',
  'list_assets',
];

const rank = (s: EvalLevel): number => (s === 'uncertain' ? -1 : s);

/** Codes in the order the issue register lists them: the prefix, then the number. */
function byCode(a: string, b: string): number {
  const pa = /^([A-Z]*)(\d*)$/.exec(a);
  const pb = /^([A-Z]*)(\d*)$/.exec(b);
  const prefixA = pa?.[1] ?? a;
  const prefixB = pb?.[1] ?? b;
  if (prefixA !== prefixB) return prefixA < prefixB ? -1 : 1;
  return Number(pa?.[2] ?? 0) - Number(pb?.[2] ?? 0);
}

/** Worst first, findings of one level in code order: the pick the app makes, the same every time. */
const worstFirst = (a: DemoFinding, b: DemoFinding): number =>
  rank(b.severity) - rank(a.severity) || byCode(a.code, b.code);

const isOpen = (f: DemoFinding): boolean => f.status !== 'closed';

/** The most severe open finding, of the whole project or among `codes`. */
function worstOpen(demo: DemoFacts, codes?: readonly string[]): DemoFinding | undefined {
  return demo.findings
    .filter((f) => isOpen(f) && (!codes || codes.includes(f.code)))
    .sort(worstFirst)[0];
}

const photosOf = (findings: readonly DemoFinding[]): string[] => [
  ...new Set(findings.flatMap((f) => f.photos)),
];

/**
 * The highest level on the photos and the photos that carry it. Inspect counts every finding marked
 * on a photo, closed ones too, so this does as well.
 */
function worstOnPhotos(demo: DemoFacts): { level: EvalLevel | null; photos: string[] } {
  const marked = demo.findings.filter((f) => f.photos.length > 0);
  const top = [...marked].sort(worstFirst)[0];
  if (!top) return { level: null, photos: [] };
  return {
    level: top.severity,
    photos: photosOf(marked.filter((f) => f.severity === top.severity)),
  };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

const list = (items: readonly string[]): string => (items.length > 0 ? items.join(', ') : 'none');

const selected = (s: EvalState): string =>
  s.selection ? (s.selection.code ?? `${s.selection.kind} ${s.selection.id}`) : 'nothing';

const names = (reply: string, word: string): boolean =>
  word !== '' && reply.toLowerCase().includes(word.toLowerCase());

/** Words that say there is nothing to show: "no photos", "none", "0 findings", "does not have any". */
const SAYS_NOTHING =
  /\b(no|none|nothing|zero|0|without)\b|n['’]t (any|have|find|see|show)|\bnot (any|find|found|have|show)/i;

/**
 * The pinned places and levels against the demo as it is now. Every line is a reason not to
 * start: a case would then fail for the demo's sake, not for the model's.
 */
export function checkDemo(demo: DemoFacts): string[] {
  const problems: string[] = [];
  const worst = worstOpen(demo);
  if (!worst) return ['the demo has no open finding'];
  if (worst.photos.length === 0 || !worst.placed)
    problems.push(`${worst.code}, the worst finding, needs a photo and a place on the model`);
  if (demo.photos.length === 0) problems.push('the demo has no photos');

  const top = demo.levels.at(-1);
  if (top?.label !== 'Severe')
    problems.push(`the highest level is ${top?.label ?? 'missing'}, the requests say "severe"`);
  if (demo.levels.some((l) => l.label.toLowerCase() === 'critical'))
    problems.push('a level is named Critical, so "critical" is no longer an unknown word');
  if (worst.severity !== top?.value)
    problems.push(`${worst.code}, the worst finding, is not at the highest level`);

  const onPhotos = worstOnPhotos(demo);
  if (onPhotos.level !== top?.value)
    problems.push('the highest level on the photos is not the highest level of the project');
  const withFindings = photosOf(demo.findings);
  if (onPhotos.photos.length === 0 || onPhotos.photos.length >= withFindings.length)
    problems.push('the photos at the highest level must be some, not all, of those with findings');

  for (const place of [PLACES.asset, PLACES.areaOfAsset, PLACES.area]) {
    const where = 'tag' in place ? place.tag : place.name;
    for (const code of place.codes) {
      if (!demo.findings.some((f) => f.code === code))
        problems.push(`the demo has no finding ${code} (pinned on ${where})`);
    }
    const here = worstOpen(demo, place.codes);
    if (!here) problems.push(`${where} has no open finding`);
    else if (here.code === worst.code)
      problems.push(
        `the worst finding on ${where} is the project's worst: the case proves nothing`,
      );
  }
  if (photosOf(demo.findings.filter((f) => PLACES.area.codes.includes(f.code))).length === 0)
    problems.push(`the findings on ${PLACES.area.name} have no photos`);

  for (const tag of [PLACES.asset.tag, PLACES.bare.tag]) {
    if (!demo.assets.some((a) => a.tag === tag)) problems.push(`the demo has no asset "${tag}"`);
  }
  for (const area of [PLACES.area.name, PLACES.areaOfAsset.name]) {
    if (!demo.assets.some((a) => a.area === area)) problems.push(`the demo has no area "${area}"`);
  }
  return problems;
}

/** About 20 plain requests on the tank farm, each with what the app must show afterwards. */
export function evalCases(demo: DemoFacts): EvalCase[] {
  const worst = worstOpen(demo);
  const onAsset = worstOpen(demo, PLACES.asset.codes);
  const inArea = worstOpen(demo, PLACES.area.codes);
  const top = demo.levels.at(-1);
  const topCodes = demo.findings
    .filter((f) => isOpen(f) && f.severity === top?.value)
    .map((f) => f.code);
  const topLabel = top?.label ?? '';
  const onPhotos = worstOnPhotos(demo);
  const areaPhotos = photosOf(demo.findings.filter((f) => PLACES.area.codes.includes(f.code)));

  /** Show a finding: it is selected on Scene, with its photo open beside the 3D view or not. */
  const showsFinding =
    (finding: DemoFinding | undefined, withPhoto: boolean) =>
    (s: EvalState): string | null => {
      if (!finding) return 'the demo has no such finding';
      if (s.screen !== 'scene') return `the screen is ${s.screen}, not scene`;
      if (s.selection?.code !== finding.code)
        return `${selected(s)} is selected, not ${finding.code}`;
      if (!withPhoto) return null;
      if (!s.evidenceOpen) return `the photo of ${finding.code} is not open beside the 3D view`;
      if (!s.toolCalls.includes('show_issue')) return 'show_issue did not run';
      return null;
    };
  const photoOpened = (s: EvalState): string => `photo opened: ${s.evidenceOpen ? 'yes' : 'no'}`;
  /**
   * The founder's own sentence: the finding is selected on Scene and its photo is open beside the
   * 3D view, as the design has it. Only `show_issue` does that.
   */
  const takesTo = (finding: DemoFinding | undefined) => ({
    expect: showsFinding(finding, true),
    note: photoOpened,
  });
  /**
   * Another way to say it: the right finding selected on Scene is the answer, however the model
   * got there. Whether its photo opened is in the table, not in the verdict.
   */
  const pointsAt = (finding: DemoFinding | undefined) => ({
    expect: showsFinding(finding, false),
    note: photoOpened,
  });

  /** Show photos: Inspect lists exactly these, however the model named them. */
  const showsPhotos =
    (photos: readonly string[], level?: EvalLevel | null) =>
    (s: EvalState): string | null => {
      if (s.screen !== 'inspect') return `the screen is ${s.screen}, not inspect`;
      const shown = s.media.shown ?? [];
      if (!sameSet(shown, photos)) return `Inspect lists ${list(shown)}, not ${list(photos)}`;
      if (level !== undefined && s.media.severity !== level)
        return `the Severity filter of Inspect is ${String(s.media.severity)}, not ${String(level)}`;
      if (!s.toolCalls.includes('show_photos')) return 'show_photos did not run';
      return null;
    };

  return [
    // The founder's first request and four other ways to say it.
    { ask: TAKE_ME, ...takesTo(worst) },
    { ask: 'Show me the worst defect', ...pointsAt(worst) },
    { ask: 'Jump to the most critical finding', ...pointsAt(worst) },
    { ask: 'Where is the most serious damage? Take me there.', ...pointsAt(worst) },
    { ask: 'Fly to the worst finding and show it to me', ...pointsAt(worst) },

    // "This asset" with an asset selected, and the same sentence with an area named in it.
    { ask: TAKE_ME, select: PLACES.asset.tag, ...takesTo(onAsset) },
    { ask: `Take me to the most severe point on ${PLACES.area.name}`, ...takesTo(inArea) },

    // The founder's second request and four other ways to say it.
    { ask: OPEN_IMAGES, expect: showsPhotos(onPhotos.photos, onPhotos.level) },
    { ask: 'Which photos show the most serious problems?', expect: showsPhotos(onPhotos.photos) },
    { ask: 'Pull up the pictures of the severe findings', expect: showsPhotos(onPhotos.photos) },
    { ask: 'Show me the images of the worst findings', expect: showsPhotos(onPhotos.photos) },
    { ask: 'Filter the photos to the highest severity', expect: showsPhotos(onPhotos.photos) },

    // Photos of an area: a filter that shows as a chip.
    {
      ask: `Show me the photos of ${PLACES.area.name}`,
      expect: (s) =>
        showsPhotos(areaPhotos)(s) ??
        (s.media.scope ? null : 'Inspect has no chip that names the area'),
    },

    // A question: answered from a read, and the screen stays.
    {
      ask: `What is wrong with ${PLACES.area.name}?`,
      expect: (s) => {
        if (!s.toolCalls.some((t) => READ_TOOLS.includes(t)))
          return `no tool that reads ran (${list(s.toolCalls)})`;
        if (s.screen !== 'scene') return `the screen changed to ${s.screen}`;
        return null;
      },
    },
    {
      ask: 'Which asset is in the worst shape?',
      expect: (s) =>
        s.toolCalls.includes('list_assets')
          ? null
          : `list_assets did not run (${list(s.toolCalls)})`,
    },

    // A severity word that is no level of this project: the highest present, said by its name.
    {
      ask: 'Show me the critical findings',
      expect: (s) => {
        const listed = s.screen === 'issues' && s.issues.severity === top?.value;
        const shown = s.screen === 'scene' && topCodes.includes(s.selection?.code ?? '');
        if (!listed && !shown) {
          return s.screen === 'issues'
            ? `Issues is filtered to level ${String(s.issues.severity)}, not ${topLabel}`
            : `the screen is ${s.screen} with ${selected(s)} selected, not the ${topLabel} findings`;
        }
        if (!names(s.reply, topLabel)) return `the reply does not name ${topLabel}`;
        return null;
      },
    },

    // Findings as a list: sorted, not filtered, and the findings of one area.
    {
      ask: 'Open the issues list with the worst first',
      expect: (s) => {
        if (s.screen !== 'issues') return `the screen is ${s.screen}, not issues`;
        if (s.issues.severity !== null)
          return `Issues is filtered to level ${String(s.issues.severity)} instead of sorted`;
        // "asc" is the natural order of a key: for severity, the highest first
        if (s.issues.sort !== 'severity' || s.issues.dir !== 'asc')
          return `Issues is sorted by ${s.issues.sort} ${s.issues.dir}, not worst first`;
        const shown = s.issues.shown ?? [];
        if (shown.length < 2 || shown[0] !== worst?.code)
          return `Issues lists ${list(shown)}: ${worst?.code ?? 'the worst'} is not first of all`;
        return null;
      },
    },
    {
      ask: `Show me the findings in ${PLACES.areaOfAsset.said}`,
      expect: (s) => {
        const codes = PLACES.areaOfAsset.codes;
        if (s.screen === 'issues') {
          const shown = s.issues.shown ?? [];
          return sameSet(shown, codes) ? null : `Issues lists ${list(shown)}, not ${list(codes)}`;
        }
        // one finding only: showing that finding is the same answer
        if (s.screen === 'scene' && codes.length === 1 && s.selection?.code === codes[0])
          return null;
        return `the screen is ${s.screen} with ${selected(s)} selected, not ${list(codes)}`;
      },
    },

    // Back from another screen.
    {
      ask: 'Go back to the 3D view',
      from: 'inspect',
      expect: (s) => (s.screen === 'scene' ? null : `the screen is ${s.screen}, not scene`),
    },

    // Photos where there are none: the agent says so and shows no photo as if it matched.
    {
      ask: `Show me the photos of the findings on ${PLACES.bare.said}`,
      expect: (s) => {
        const shown = s.media.shown ?? [];
        if (s.screen === 'inspect' && shown.length > 0)
          return `Inspect lists ${list(shown)} for an asset without findings`;
        if (s.toolCalls.length === 0) return 'no tool ran to the end: the answer was not looked up';
        if (!SAYS_NOTHING.test(s.reply)) return 'the reply does not say that nothing matched';
        return null;
      },
    },
  ];
}
