/**
 * The tool-calling check of a local model (intelligence review Wave 3, A3; agent.md 4.8): a short
 * scripted set of requests sent with the agent's compact profile (the compact system prompt, the
 * compact tool list and a window context like the app's), each graded on the first tool call the
 * model makes. The bundled Analytics model may run the offline agent only once it passes.
 *
 * Nothing runs a tool: the model answers one step per case and the call it makes is graded. A
 * call is valid when it names an offered tool and its arguments fit that tool's schema (after
 * the same repair the agent runs on a local model). Main process only (the AI SDK).
 */
import type { AgentFacts, WindowKind } from '@aio/schema';
import { generateText, type LanguageModel, type ToolSet } from 'ai';
import { contextBlock, systemPrompt } from './prompt';
import { createToolCallRepair } from './repair';
import { toolsForWindow } from './tools';

/** Share of the cases a model must get right to run the offline agent. */
export const TOOL_CHECK_PASS_SHARE = 0.8;
/** One case may take this long (the first one includes loading the model). */
const CASE_TIMEOUT_MS = 120_000;

export interface ToolCheckCase {
  id: string;
  ask: string;
  /** Tool names that count as the right first call; empty: the right answer is text, no tool. */
  expect: readonly string[];
  /** Further check of the arguments of the right call; a string is why it failed. */
  args?: (input: Record<string, unknown>) => string | null;
}

/** The window context every case is sent with: a tank farm in the 3D window, two survey dates. */
export const TOOL_CHECK_CONTEXT: Record<string, unknown> = {
  project: { name: 'Tank farm demo', crs: 'EPSG:32633' },
  selection: null,
  layers: [
    { id: 'L1', name: 'Site model', kind: 'mesh', visible: true },
    { id: 'L2', name: 'Point cloud', kind: 'pointcloud', visible: true },
    { id: 'L3', name: 'Inspection photos', kind: 'photos', visible: true },
  ],
  counts: {
    issues: 12,
    open: 9,
    photos: 140,
    clips: 2,
    openIssuesBySeverity: { 1: 4, 2: 3, 3: 2 },
  },
  severityLevels: [
    {
      model: 'default',
      levels: [
        { value: 1, label: 'Minor' },
        { value: 2, label: 'Major' },
        { value: 3, label: 'Critical' },
      ],
    },
  ],
  surveys: { dates: ['2024-03-12', '2024-09-04'], focused: '2024-09-04' },
  places: ['Tank 1', 'Tank 2', 'Tank 3', 'Pump house', 'Stockpile A'],
};

/** What the check's project has: two dates, photos, clips, a cloud, volumes; no model, as a demo. */
export const TOOL_CHECK_FACTS: AgentFacts = {
  captures: 2,
  photos: true,
  clips: true,
  pointClouds: true,
  models: false,
  measurements: true,
  volumes: true,
  detections: true,
  thermal: false,
  walks: false,
};

const has = (input: Record<string, unknown>, re: RegExp) => re.test(JSON.stringify(input));

/** Twelve requests in the 3D window: navigation, layers, issues, dates, volumes, a draft, text. */
export const TOOL_CHECK_CASES: readonly ToolCheckCase[] = [
  {
    id: 'fly-to-place',
    ask: 'Fly to tank 3.',
    expect: ['find_places', 'fly_to'],
    args: (i) => (has(i, /tank\s*3|T-?3/i) ? null : 'does not name tank 3'),
  },
  { id: 'whole-site', ask: 'Show me the whole site.', expect: ['frame_all', 'set_view'] },
  {
    id: 'top-view',
    ask: 'Switch to the top view.',
    expect: ['set_view'],
    args: (i) => (has(i, /top/i) ? null : 'not the top view'),
  },
  {
    id: 'hide-layer',
    ask: 'Hide the point cloud layer.',
    expect: ['set_layer_visible', 'list_layers', 'run_action'],
  },
  {
    id: 'count-issues',
    ask: 'How many issues are there of each severity?',
    expect: ['summarize_issues', 'list_issues'],
  },
  { id: 'survey-dates', ask: 'What are the survey dates?', expect: ['list_surveys'] },
  {
    id: 'volume',
    ask: 'What is the volume of Stockpile A on each survey?',
    expect: ['get_volume', 'find_places'],
  },
  {
    id: 'worst-finding',
    ask: 'Show me the most severe finding.',
    expect: ['show_issue', 'list_issues', 'show_issues'],
  },
  {
    id: 'critical-photos',
    ask: 'Open the photos with critical findings.',
    expect: ['show_photos'],
    // Critical is level 3 in the context, or the highest level present
    args: (i) =>
      i.severity === 3 || i.severity === 'highest' ? null : 'does not filter on critical',
  },
  {
    id: 'draft-issue',
    ask: 'Create a draft issue: corrosion on the roof of tank 2.',
    expect: ['create_issue_draft', 'find_places'],
  },
  {
    id: 'open-issues-list',
    ask: 'List the open issues.',
    expect: ['list_issues', 'show_issues'],
  },
  { id: 'thanks', ask: 'Thanks, that is all for now.', expect: [] },
];

export type ToolCheckOutcome = 'ok' | 'text-only' | 'wrong-tool' | 'invalid-call' | 'bad-args';

export interface ToolCheckCaseResult {
  id: string;
  ok: boolean;
  outcome: ToolCheckOutcome;
  /** The tool the model called first, if any. */
  tool?: string;
  /** Why it failed, for the log and the note. */
  reason?: string;
  latencyMs: number;
}

export interface ToolCheckResult {
  passed: boolean;
  total: number;
  correct: number;
  /** Correct cases needed to pass. */
  needed: number;
  /** Calls whose name or arguments the SDK could not use, even after repair. */
  invalidCalls: number;
  meanLatencyMs: number;
  /** Prompt tokens of one case, as the server counted them (the compact profile's size). */
  promptTokens?: number;
  cases: ToolCheckCaseResult[];
}

export interface ToolCheckOptions {
  model: LanguageModel;
  window?: WindowKind;
  cases?: readonly ToolCheckCase[];
  /** What the project has (the tool list follows it); a demo project by default. */
  facts?: AgentFacts;
  /** Output tokens per case. */
  maxOutputTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  /** After each case, for a progress line. */
  onCase?: (r: ToolCheckCaseResult, index: number, total: number) => void;
}

/** Correct cases needed out of `total`. */
export function neededFor(total: number): number {
  return Math.ceil(total * TOOL_CHECK_PASS_SHARE);
}

/** The compact tools of `window`, without executors: the model's call is graded, never run. */
function compactTools(window: WindowKind, facts: AgentFacts): ToolSet {
  const set: ToolSet = {};
  for (const spec of toolsForWindow(window, 'compact', { facts, task: 'chat' })) {
    set[spec.meta.name] = { description: spec.meta.description, inputSchema: spec.input };
  }
  return set;
}

/** Grade one case's first tool call (or its text answer). */
export function gradeCase(
  c: ToolCheckCase,
  call: { toolName: string; input: unknown; invalid?: boolean | undefined } | undefined,
): Pick<ToolCheckCaseResult, 'ok' | 'outcome' | 'tool' | 'reason'> {
  if (!call) {
    return c.expect.length === 0
      ? { ok: true, outcome: 'ok' }
      : { ok: false, outcome: 'text-only', reason: 'answered in text, no tool call' };
  }
  const tool = call.toolName;
  if (call.invalid) {
    return { ok: false, outcome: 'invalid-call', tool, reason: 'name or arguments did not fit' };
  }
  if (!c.expect.includes(tool)) {
    return {
      ok: false,
      outcome: 'wrong-tool',
      tool,
      reason: c.expect.length === 0 ? 'called a tool for a text answer' : `called ${tool}`,
    };
  }
  const input =
    typeof call.input === 'object' && call.input !== null
      ? (call.input as Record<string, unknown>)
      : {};
  // the argument check applies to the case's first expected tool (the direct one)
  const why = tool === c.expect[0] ? (c.args?.(input) ?? null) : null;
  if (why) return { ok: false, outcome: 'bad-args', tool, reason: why };
  return { ok: true, outcome: 'ok', tool };
}

/**
 * Run the check: each case once, with the compact prompt and tools, graded on the first call.
 * Throws when the server cannot be reached at all (the first case's error), so a check that
 * never ran is not recorded as a failure of the model.
 */
export async function runToolCheck(opts: ToolCheckOptions): Promise<ToolCheckResult> {
  const window = opts.window ?? 'scene3d';
  const cases = opts.cases ?? TOOL_CHECK_CASES;
  const now = opts.now ?? Date.now;
  const tools = compactTools(window, opts.facts ?? TOOL_CHECK_FACTS);
  const instructions = systemPrompt(window, 'compact');
  const results: ToolCheckCaseResult[] = [];
  let invalidCalls = 0;
  let promptTokens: number | undefined;
  let lastFailed = false;
  let lastError: unknown;
  for (const [index, c] of cases.entries()) {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? CASE_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const start = now();
    let r: Awaited<ReturnType<typeof generateText>>;
    try {
      r = await generateText({
        model: opts.model,
        instructions,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: contextBlock(window, TOOL_CHECK_CONTEXT) },
              { type: 'text', text: c.ask },
            ],
          },
        ],
        tools,
        maxOutputTokens: opts.maxOutputTokens ?? 1024,
        maxRetries: 0,
        repairToolCall: createToolCallRepair({ model: opts.model, abortSignal: signal }),
        providerOptions: { openai: { parallelToolCalls: false } },
        abortSignal: signal,
      });
    } catch (e) {
      // nothing answered, or the server went away (two failed requests in a row): not a verdict
      // on the model, so no failed check is recorded that would block it
      if (results.length === 0 || lastFailed) throw e;
      lastFailed = true;
      lastError = e;
      const result: ToolCheckCaseResult = {
        id: c.id,
        ok: false,
        outcome: 'text-only',
        reason: e instanceof Error ? e.message.slice(0, 200) : 'request failed',
        latencyMs: Math.max(0, now() - start),
      };
      results.push(result);
      opts.onCase?.(result, index, cases.length);
      continue;
    }
    lastFailed = false;
    promptTokens ??= r.usage.inputTokens;
    const first = r.toolCalls[0];
    if (first && 'invalid' in first && first.invalid) invalidCalls += 1;
    const graded = gradeCase(c, first);
    const result: ToolCheckCaseResult = {
      id: c.id,
      ...graded,
      latencyMs: Math.max(0, now() - start),
    };
    results.push(result);
    opts.onCase?.(result, index, cases.length);
  }
  // the last request failed: the server may have gone away, so no verdict either
  if (lastFailed) throw lastError;
  const correct = results.filter((r) => r.ok).length;
  const needed = neededFor(cases.length);
  const meanLatencyMs =
    results.length === 0 ? 0 : results.reduce((s, r) => s + r.latencyMs, 0) / results.length;
  return {
    passed: correct >= needed,
    total: cases.length,
    correct,
    needed,
    invalidCalls,
    meanLatencyMs: Math.round(meanLatencyMs),
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    cases: results,
  };
}
