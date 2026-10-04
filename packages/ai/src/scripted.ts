/**
 * A scripted language model for end-to-end tests and offline demos. It never touches the network:
 * it reads the newest user message, answers with a fixed text or one tool call picked by keyword,
 * and after a tool result it reports what the tool returned. The desktop app registers it only
 * when an isolated test profile asks for it (STRATLAS_AI_TEST_PROVIDER with STRATLAS_USER_DATA).
 */
import type {
  LanguageModelV4,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import type { ModelProvider } from './providers';

/** Keyword (lower case, in the user's message) to the tool call the script makes. */
export const SCRIPT: readonly { when: string; tool: string; input: Record<string, unknown> }[] = [
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

/** What the script answers for a prompt. Exported for tests. */
export function scriptedTurn(
  prompt: LanguageModelV4Prompt,
): { kind: 'text'; text: string } | { kind: 'tool'; tool: string; input: Record<string, unknown> } {
  const result = lastToolResult(prompt);
  if (result) return { kind: 'text', text: `Tool ${result.name} returned ${result.output}` };
  const text = lastUserText(prompt);
  const hit = SCRIPT.find((s) => text.toLowerCase().includes(s.when));
  if (hit) return { kind: 'tool', tool: hit.tool, input: hit.input };
  return { kind: 'text', text: `Scripted reply to: ${text.slice(0, 120)}` };
}

let calls = 0;

function scriptedModel(modelId: string): LanguageModelV4 {
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
    // Settings, Test connection: one non-streamed answer.
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: 'text', text: 'OK' }],
        finishReason: { unified: 'stop', raw: 'end_turn' },
        usage: USAGE,
        warnings: [],
      }),
    doStream: (options) => {
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
export function createScriptedProvider(id: string, cloud = true): ModelProvider {
  return {
    id,
    label: 'Scripted test model',
    cloud,
    needsKey: false,
    languageModel: (model) => scriptedModel(model),
  };
}
