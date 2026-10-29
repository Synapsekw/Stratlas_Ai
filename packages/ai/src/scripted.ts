/**
 * A scripted language model for end-to-end tests and offline demos. It never touches the network:
 * it reads the newest user message, answers with a fixed text or one tool call picked by keyword,
 * and after a tool result it reports what the tool returned. The desktop app registers it only
 * when an isolated test profile asks for it (QUADRION_AI_TEST_PROVIDER with QUADRION_USER_DATA);
 * QUADRION_AI_TEST_SCRIPT=workspace-400 makes its Anthropic answer the workspace 400 until Settings
 * has a workspace ID.
 */
import {
  APICallError,
  type LanguageModelV4,
  type LanguageModelV4Prompt,
  type LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import { ASK_MARKER } from './ask';
import { CORRECTION_PROMPT_LEAD } from './correctionPrompt';
import { DETECT_MARKER } from './detect';
import { ENGINEER_SYSTEM_LEAD } from './engineerPrompt';
import type { ModelProvider } from './providers';

/** Keyword (lower case, in the user's message) to the tool call the script makes. */
export const SCRIPT: readonly { when: string; tool: string; input: Record<string, unknown> }[] = [
  // engineering model corrections (e2e): "there are four flues, not three"
  { when: 'four flues', tool: 'set_count', input: { role: 'flue', count: 4 } },
  // fixed test heights, here in the scripted test model only (e2e on a synthetic chimney): a real
  // model works the heights out from the evidence, the product code has no default levels
  {
    when: 'intermediate warning lights',
    tool: 'set_levels',
    input: { role: 'light', levels: [25, 50, 75] },
  },
  {
    when: 'draft',
    tool: 'create_issue_draft',
    input: {
      title: 'Scripted draft issue',
      note: 'Created by the scripted test model.',
      severity: 3,
      at: { kind: 'point', p: [0.5, 0, -0.5] },
    },
  },
  {
    when: 'measure',
    tool: 'measure_distance',
    input: { from: { kind: 'point', p: [0, 0, 0] }, to: { kind: 'point', p: [3, 4, 0] } },
  },
  { when: 'export', tool: 'export_issues', input: {} },
  { when: 'compare', tool: 'compare_captures', input: {} },
  { when: 'zone', tool: 'summarize_by_zone', input: {} },
  { when: 'class', tool: 'summarize_by_class', input: {} },
  {
    when: 'near',
    tool: 'find_issues_near',
    input: { target: { kind: 'point', p: [0, 0, 0] }, radiusM: 50 },
  },
  { when: 'frame', tool: 'capture_frame', input: {} },
];

const USAGE = {
  inputTokens: { total: 1200, noCache: 1200, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 150, text: 150, reasoning: 0 },
};

function lastUserText(prompt: LanguageModelV4Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i];
    if (m?.role !== 'user') continue;
    const texts = m.content.filter((p) => p.type === 'text').map((p) => p.text);
    return texts.at(-1) ?? '';
  }
  return '';
}

function lastToolResult(prompt: LanguageModelV4Prompt): { name: string; output: string } | null {
  const m = prompt.at(-1);
  if (m?.role !== 'tool') return null;
  for (const r of m.content) {
    if (r.type === 'tool-result') {
      return { name: r.toolName, output: JSON.stringify(r.output).slice(0, 400) };
    }
  }
  return null;
}

/**
 * Explicit tool calls written into a message for end-to-end tests: `#tool <name> <json input>`,
 * any number in one message, made one after another (each after the previous result).
 */
export function scriptedDirectives(
  text: string,
): { tool: string; input: Record<string, unknown> }[] {
  const out: { tool: string; input: Record<string, unknown> }[] = [];
  for (const part of text.split('#tool ').slice(1)) {
    const m = /^([a-z_]+)\s*([\s\S]*)$/.exec(part.trim());
    if (!m?.[1]) continue;
    let input: Record<string, unknown> = {};
    try {
      const body = m[2]?.trim() ?? '';
      const parsed: unknown = JSON.parse(body === '' ? '{}' : body);
      if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown>;
    } catch {
      // a malformed input reaches the tool as {} and fails its schema there
    }
    out.push({ tool: m[1], input });
  }
  return out;
}

/** Tool results since the newest user message. */
function resultsSinceUser(prompt: LanguageModelV4Prompt): number {
  let n = 0;
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i];
    if (m?.role === 'user') break;
    if (m?.role === 'tool') n += m.content.filter((p) => p.type === 'tool-result').length;
  }
  return n;
}

/**
 * The scripted answer to a correction review (`correctionPrompt`): list the requests, then remove
 * the ladder for a request that asks for it. Null for other prompts or when there is nothing to do.
 */
export function scriptedCorrectionTurn(
  prompt: LanguageModelV4Prompt,
): { kind: 'tool'; tool: string; input: Record<string, unknown> } | null {
  const text = lastUserText(prompt);
  if (!text.startsWith(CORRECTION_PROMPT_LEAD)) return null;
  const turn = resultsSinceUser(prompt);
  if (turn === 0) return { kind: 'tool', tool: 'list_model_corrections', input: {} };
  if (turn !== 1) return null;
  const marker = 'Submitted review data:\n';
  const at = text.indexOf(marker);
  if (at < 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(text.slice(at + marker.length));
  } catch {
    return null;
  }
  const { requests, components } = (data ?? {}) as { requests?: unknown; components?: unknown };
  const request = (Array.isArray(requests) ? (requests as Record<string, unknown>[]) : []).find(
    (r) => typeof r.comment === 'string' && r.comment.includes('remove the ladder'),
  );
  const ladder = (Array.isArray(components) ? (components as Record<string, unknown>[]) : []).find(
    (c) => c.kind === 'ladder',
  );
  if (typeof request?.id !== 'string' || typeof ladder?.id !== 'string') return null;
  return {
    kind: 'tool',
    tool: 'propose_model_correction',
    input: {
      requestId: request.id,
      proposal: {
        explanation: 'Scripted: the ladder is removed as the reviewer asked.',
        patch: [{ op: 'remove', id: ladder.id }],
      },
    },
  };
}

/** What the script answers for a prompt. Exported for tests. */
export function scriptedTurn(
  prompt: LanguageModelV4Prompt,
): { kind: 'text'; text: string } | { kind: 'tool'; tool: string; input: Record<string, unknown> } {
  const correction = scriptedCorrectionTurn(prompt);
  if (correction) return correction;
  const directives = scriptedDirectives(lastUserText(prompt));
  const next = directives[resultsSinceUser(prompt)];
  if (next) return { kind: 'tool', tool: next.tool, input: next.input };
  const result = lastToolResult(prompt);
  if (result) return { kind: 'text', text: `Tool ${result.name} returned ${result.output}` };
  const text = lastUserText(prompt);
  const hit = SCRIPT.find((s) => text.toLowerCase().includes(s.when));
  if (hit) return { kind: 'tool', tool: hit.tool, input: hit.input };
  return { kind: 'text', text: `Scripted reply to: ${text.slice(0, 120)}` };
}

/**
 * Detection requests (`ai:detect`): one proposal per image, in the first class of the prompt,
 * at a box that moves with the image number, so tests can predict it. A hint containing
 * "nothing" returns no proposals; one containing "garbage" returns text that is not JSON.
 */
export function scriptedDetections(prompt: LanguageModelV4Prompt): string | null {
  const user = lastUserText(prompt);
  const marker = prompt.some(
    (m) =>
      m.role === 'user' &&
      m.content.some((p) => p.type === 'text' && p.text.includes(DETECT_MARKER)),
  );
  if (!marker) return null;
  const system = prompt.find((m) => m.role === 'system');
  const sysText = system?.role === 'system' ? system.content : '';
  const cls = /"id":"([^"]+)"/.exec(sysText)?.[1] ?? 'defect';
  const firstText =
    prompt
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content.filter((p) => p.type === 'text').map((p) => p.text))
      .find((t) => t.includes(DETECT_MARKER)) ?? user;
  if (/garbage/i.test(firstText)) return 'I could not do that.';
  const count = Number(/There are (\d+) images/.exec(firstText)?.[1] ?? '1');
  const empty = /nothing/i.test(firstText);
  const images = Array.from({ length: count }, (_, i) => ({
    image: i + 1,
    detections: empty
      ? []
      : [
          {
            class: cls,
            box: [0.2 + 0.05 * (i % 4), 0.3, 0.25, 0.2],
            confidence: 0.9 - 0.1 * (i % 4),
            severity: 2,
            uncertain: false,
            note: `Scripted proposal on image ${String(i + 1)}.`,
          },
        ],
  }));
  return JSON.stringify({ images });
}

/** The scripted value of one field from its slot in the prompt. */
function scriptedField(slot: string): number | string {
  if (slot.startsWith('<')) return slot.includes('as a number') ? 42.5 : 'scripted';
  const inner = slot.slice(1, -1);
  if (inner === 'yes|no|unknown') return 'yes';
  if (inner.startsWith('<') || !inner.includes('|')) return 'scripted';
  return inner.split('|')[0] ?? 'scripted';
}

/**
 * The scripted answer to a custom request prompt (`askPrompt`, cloud family): `garbage` gives a
 * reply that is not JSON; a find or change prompt gives two items in pixels of the size the
 * prompt names, with every field it asks for filled; anything else a short text answer.
 */
export function askReply(text: string): string {
  if (/garbage/i.test(text)) return 'I could not do that.';
  if (!text.includes('Output JSON only') && !text.includes('Output a JSON list only')) {
    return `Scripted answer: ${text.slice(0, 80)}`;
  }
  const size = /\((?:it is|both are) (\d+) x (\d+)/.exec(text);
  const w = Number(size?.[1] ?? 1000);
  const h = Number(size?.[2] ?? 1000);
  const change = text.includes('Output a JSON list only');
  const fields: Record<string, number | string> = {};
  for (const m of text.matchAll(/"([a-z][a-z0-9_]*)": (<[^>]*>|"[^"]*")/g)) {
    const key = m[1] ?? '';
    if (key === 'label' || key === 'note') continue;
    fields[key] = scriptedField(m[2] ?? '');
  }
  const boxes = [
    [0.1, 0.2, 0.3, 0.5],
    [0.6, 0.4, 0.8, 0.7],
  ];
  return JSON.stringify(
    boxes.map((b, n) => ({
      bbox_2d: b.map((v, i) => Math.round(v * (i % 2 === 0 ? w : h))),
      label: 'scripted item',
      note: `Scripted item ${String(n + 1)}.`,
      ...fields,
      ...(change ? { change_type: 'new', what: 'scripted object' } : {}),
    })),
  );
}

/** A custom request (`ai:ask` on the cloud): null when no user text starts with ASK_MARKER. */
export function scriptedAsk(prompt: LanguageModelV4Prompt): string | null {
  const texts = prompt
    .filter((m) => m.role === 'user')
    .flatMap((m) => m.content.filter((x) => x.type === 'text').map((x) => x.text));
  if (!texts.some((t) => t.startsWith(ASK_MARKER))) return null;
  const newest = lastUserText(prompt);
  return newest.startsWith(ASK_MARKER)
    ? askReply(newest)
    : `Scripted answer: ${newest.slice(0, 80)}`;
}

interface WireParam {
  name: string;
  value: number | string | boolean;
}
interface WireComponent {
  role: string;
  kind: string;
  count: number;
  units: 'ratio' | 'm';
  params: WireParam[];
  levels: number[];
  imageIds: string[];
  observed: boolean;
  description: string;
}

const p = (o: Record<string, number | string | boolean>): WireParam[] =>
  Object.entries(o).map(([name, value]) => ({ name, value }));

const part = (
  role: string,
  kind: string,
  count: number,
  params: Record<string, number | string | boolean>,
  levels: number[] = [],
): WireComponent => ({
  role,
  kind,
  count,
  units: 'ratio',
  params: p(params),
  levels,
  imageIds: ['p1'],
  observed: true,
  description: '',
});

const wireProposal = (
  family: string,
  components: WireComponent[],
  sameAsset = true,
): Record<string, unknown> => ({
  family: { value: family, reasons: [`Scripted ${family} for tests.`] },
  identity: {
    sameAsset,
    conflicts: sameAsset
      ? []
      : [{ imageIds: ['p1'], reason: 'Scripted: this image shows another structure.' }],
  },
  components,
  unresolved: ['Make and process duty unknown (scripted).'],
  notes: `Scripted ${family} proposal; no data left the workstation.`,
});

const CHIMNEY = [
  part('shaft', 'shaft', 1, { rBase: 0.05, rTop: 0.035, openTop: true, wall: 0.004 }),
  part('flue', 'flue', 3, { rOuter: 0.008, rInner: 0.006 }),
  part('light', 'warningLight', 3, { fixture: 'single', arrangement: 'ring' }, [0.5, 0.98]),
  part('ladder', 'ladder', 1, { cage: true, azimuthDeg: 90 }),
];

/**
 * The scripted engineer replies by name, in the reply format the model fills in (params as name
 * and value pairs). A request picks one with `#engineer <name>` in its summary; the default is
 * `chimney`. `invalid` is the first reply of `#engineer invalid` (the repair gets `chimney`).
 */
export const SCRIPTED_ENGINEER: Readonly<Record<string, Record<string, unknown>>> = {
  chimney: wireProposal('chimney', CHIMNEY),
  flare: wireProposal('flare', [
    part('riser', 'shaft', 1, { rBase: 0.012, rTop: 0.01, support: 'self' }),
    part('tip', 'flareTip', 1, { r: 0.015, height: 0.04, windshield: true, pilots: 3 }),
    part('platform', 'ringPlatform', 1, { guardrail: true, width: 0.02 }, [0.9]),
    part('gas-line', 'pipeRun', 1, { diameter: 0.004, azimuthDeg: 270 }),
  ]),
  lattice: wireProposal('telecom-lattice', [
    part('tower', 'lattice', 1, {
      legs: 3,
      widthBase: 0.12,
      widthTop: 0.04,
      bays: 8,
      bracing: 'X',
    }),
    part('antenna', 'antenna', 6, { type: 'panel', size: 0.05, sectors: 3, azimuthDeg: 0 }, [0.92]),
    part('mount', 'antennaMount', 6, { type: 'standoff' }),
  ]),
  monopole: wireProposal('telecom-monopole', [
    part('pole', 'monopole', 1, { rBase: 0.02, rTop: 0.012, sides: 12 }),
    part(
      'antenna',
      'antenna',
      3,
      { type: 'panel', size: 0.06, sectors: 3, azimuthDeg: 30 },
      [0.95],
    ),
    part('mount', 'antennaMount', 3, { type: 'pipe' }),
  ]),
  conflict: wireProposal('chimney', CHIMNEY, false),
  invalid: { ...wireProposal('chimney', CHIMNEY), family: { value: 'windmill', reasons: [] } },
};

/** The scripted engineer request names. */
const ENGINEER_NAMES = [
  'chimney',
  'flare',
  'lattice',
  'monopole',
  'conflict',
  'invalid-always',
  'invalid',
  'rate-limit',
] as const;

/**
 * An engineer request (`runEngineer`): the reply picked by `#engineer <name>` in the request, the
 * same for every provider. `rate-limit` throws a 429; `invalid` answers out of range first and
 * `chimney` on the repair; `invalid-always` stays out of range. Null for other prompts.
 */
export function scriptedEngineer(prompt: LanguageModelV4Prompt): string | null {
  if (!systemText(prompt).includes(ENGINEER_SYSTEM_LEAD)) return null;
  const first =
    prompt
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content.filter((x) => x.type === 'text').map((x) => x.text))
      .at(0) ?? '';
  const name = ENGINEER_NAMES.find((n) => first.includes(`#engineer ${n}`)) ?? 'chimney';
  const repair = prompt.some((m) => m.role === 'assistant');
  if (name === 'rate-limit') {
    throw new APICallError({
      message: 'Too Many Requests',
      url: 'scripted://engineer',
      requestBodyValues: {},
      statusCode: 429,
      responseBody: JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'Scripted rate limit.' },
      }),
      isRetryable: false,
    });
  }
  const pick =
    name === 'invalid-always' || (name === 'invalid' && !repair)
      ? 'invalid'
      : name === 'invalid'
        ? 'chimney'
        : name;
  return JSON.stringify(SCRIPTED_ENGINEER[pick] ?? SCRIPTED_ENGINEER.chimney);
}

/** The system instructions of a prompt. */
function systemText(prompt: LanguageModelV4Prompt): string {
  return prompt
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
}

/**
 * A report narrative request (`narrativeRequest`): a JSON object with a fixed text per part
 * asked for, naming the project from the statistics. Exported for tests.
 */
export function scriptedNarrative(prompt: LanguageModelV4Prompt): string | null {
  const keys = /keys ((?:"[a-z]+"(?:, | and )?)+)/.exec(systemText(prompt));
  if (!keys?.[1]) return null;
  const parts = [...keys[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1] ?? '');
  const user = lastUserText(prompt);
  const project = /"project": "([^"]*)"/.exec(user)?.[1] ?? 'the project';
  const total = /"total": (\d+)/.exec(user)?.[1] ?? '0';
  const text: Record<string, string> = {
    summary: `Scripted executive summary for ${project}. The review recorded ${total} issues.\n\nThe scripted test model wrote this text; no data left the workstation.`,
    method: `Scripted method for ${project}: drone capture, review of every frame and grading on the project severity scale.`,
    findings: `Scripted findings for ${project}: ${total} issues by class, zone and severity.`,
  };
  return JSON.stringify(Object.fromEntries(parts.map((p) => [p, text[p] ?? `Scripted ${p}.`])));
}

/**
 * The 400 the Messages API answers when an organisation key (not scoped to a workspace) is sent
 * without the `anthropic-workspace-id` header, as the installed app logged it on 2026-10-04.
 */
export const WORKSPACE_REQUIRED_BODY = JSON.stringify({
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message:
      'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.',
  },
});

export interface ScriptedOptions {
  /**
   * Stand in for an organisation key: every request fails with the workspace 400
   * (WORKSPACE_REQUIRED_BODY) until this returns a workspace ID, as Anthropic does. For the agent
   * panel's in-place fix (end-to-end test).
   */
  workspaceId?: () => string | undefined;
  /** Called for every non-streamed request (tests count what would have been sent). */
  onGenerate?: () => void;
}

function workspaceError(modelId: string): APICallError {
  const data = JSON.parse(WORKSPACE_REQUIRED_BODY) as unknown;
  return new APICallError({
    message: 'Bad Request',
    url: 'scripted://messages',
    requestBodyValues: { model: modelId },
    statusCode: 400,
    responseBody: WORKSPACE_REQUIRED_BODY,
    isRetryable: false,
    data,
  });
}

let calls = 0;

function scriptedModel(modelId: string, options: ScriptedOptions = {}): LanguageModelV4 {
  const onGenerate = options.onGenerate;
  // Rejects like the provider when an organisation key has no workspace ID yet.
  const refused = () =>
    options.workspaceId !== undefined && !options.workspaceId()?.trim()
      ? workspaceError(modelId)
      : null;
  const parts = (prompt: LanguageModelV4Prompt): LanguageModelV4StreamPart[] => {
    const turn = scriptedTurn(prompt);
    calls += 1;
    if (turn.kind === 'tool') {
      return [
        { type: 'stream-start', warnings: [] },
        {
          type: 'tool-call',
          toolCallId: `scripted-${String(calls)}`,
          toolName: turn.tool,
          input: JSON.stringify(turn.input),
        },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: USAGE },
      ];
    }
    return [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: turn.text },
      { type: 'text-end', id: 't' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage: USAGE },
    ];
  };
  return {
    specificationVersion: 'v4',
    provider: 'scripted',
    modelId,
    supportedUrls: {},
    // Settings, Test connection (OK), AI detection and the report narrative (JSON): one
    // non-streamed answer.
    doGenerate: (options) => {
      const error = refused();
      if (error) return Promise.reject(error);
      onGenerate?.();
      let engineer: string | null;
      try {
        engineer = scriptedEngineer(options.prompt);
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
      return Promise.resolve({
        content: [
          {
            type: 'text',
            text:
              engineer ??
              scriptedAsk(options.prompt) ??
              scriptedDetections(options.prompt) ??
              scriptedNarrative(options.prompt) ??
              'OK',
          },
        ],
        finishReason: { unified: 'stop', raw: 'end_turn' },
        usage: USAGE,
        warnings: [],
      });
    },
    doStream: (options) => {
      const error = refused();
      if (error) return Promise.reject(error);
      const list = parts(options.prompt);
      return Promise.resolve({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            for (const p of list) controller.enqueue(p);
            controller.close();
          },
        }),
      });
    },
  };
}

/**
 * A provider that answers every model id with the script. `id` is the route provider it stands in
 * for; `cloud` decides whether the cloud switch and project policy apply, as for the real one.
 */
export function createScriptedProvider(
  id: string,
  cloud = true,
  options: ScriptedOptions = {},
): ModelProvider {
  return {
    id,
    label: 'Scripted test model',
    cloud,
    needsKey: false,
    languageModel: (model) => scriptedModel(model, options),
  };
}
