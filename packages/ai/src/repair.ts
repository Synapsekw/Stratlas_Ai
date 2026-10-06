/**
 * Tool-call repair for small local models (AI-9). Small models often write almost-JSON (single
 * quotes, trailing commas, Python literals, a sentence around the object) or a tool name in
 * another spelling. The repair fixes that locally first; when the input is valid JSON that does
 * not fit the tool's schema, it asks the model once more with the schema error, then gives up so
 * the SDK reports the error to the model as the tool's result. Main process only.
 */
import {
  asSchema,
  generateText,
  NoSuchToolError,
  type LanguageModel,
  type ToolCallRepairFunction,
  type ToolSet,
} from 'ai';

/** Parse `text` as a JSON object, or null. */
function asObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The tool input in `text` as compact JSON, repaired where small models usually go wrong, or null
 * when there is no object to recover. An empty input is an empty object.
 */
export function repairJson(text: string): string | null {
  let t = text.trim();
  if (t === '') return '{}';
  const direct = asObject(t);
  if (direct) return JSON.stringify(direct);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fenced?.[1] !== undefined) t = fenced[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  t = t.slice(start, end + 1);
  const attempts = [t];
  let fixed = t
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null');
  if (!fixed.includes('"')) fixed = fixed.replace(/'/g, '"');
  fixed = fixed
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, '$1');
  attempts.push(fixed);
  for (const a of attempts) {
    const o = asObject(a);
    if (o) return JSON.stringify(o);
  }
  return null;
}

/** `functions.Set-View` and `set view` both mean `set_view`. */
function normaliseName(name: string): string {
  return (name.split('.').pop() ?? name)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

async function fits(schema: unknown, json: string): Promise<boolean> {
  const validate = asSchema(schema as Parameters<typeof asSchema>[0]).validate;
  if (!validate) return true;
  const r = await validate(JSON.parse(json));
  return r.success;
}

const FIX_INSTRUCTIONS =
  'You correct the arguments of a tool call so they match the JSON schema. Answer with the corrected JSON object only, no other text.';

export interface RepairOptions {
  /** The model that made the call; it gets one more request with the schema error. */
  model: LanguageModel;
  abortSignal?: AbortSignal;
}

/** The `repairToolCall` of a local model's run. */
export function createToolCallRepair(opts: RepairOptions): ToolCallRepairFunction<ToolSet> {
  return async ({ toolCall, tools, error, inputSchema }) => {
    if (NoSuchToolError.isInstance(error)) {
      const want = normaliseName(toolCall.toolName);
      const match = Object.keys(tools).find((n) => normaliseName(n) === want);
      return match ? { ...toolCall, toolName: match } : null;
    }
    const spec = tools[toolCall.toolName];
    if (!spec) return null;
    const local = repairJson(toolCall.input);
    if (local !== null && (await fits(spec.inputSchema, local))) {
      return { ...toolCall, input: local };
    }
    try {
      const schema = await inputSchema({ toolName: toolCall.toolName });
      const reason = error.cause instanceof Error ? error.cause.message : String(error.cause);
      const r = await generateText({
        model: opts.model,
        instructions: FIX_INSTRUCTIONS,
        prompt: [
          `Tool: ${toolCall.toolName}`,
          `Arguments given: ${toolCall.input}`,
          `Error: ${reason.slice(0, 600)}`,
          `JSON schema: ${JSON.stringify(schema)}`,
        ].join('\n'),
        maxOutputTokens: 1024,
        maxRetries: 0,
        ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      });
      const fixed = repairJson(r.text);
      if (fixed !== null && (await fits(spec.inputSchema, fixed))) {
        return { ...toolCall, input: fixed };
      }
    } catch {
      // the SDK reports the original error to the model
    }
    return null;
  };
}
