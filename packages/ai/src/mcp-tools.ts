/**
 * The tools the local MCP server offers (intelligence review Wave 3, X1): the agent's read tools,
 * taken from the same specs (`allToolSpecs()`), so the list outside agents see never drifts from
 * the in-app agent's. Every read tool is classified here, `expose` or `exclude` with a reason; the
 * parity test (mcp-tools.test.ts) fails when a read tool is added to the agent and not classified,
 * or when a tool that is not `risk: 'read'` would be exposed. No write, navigate or send tool is
 * ever offered. Shared by both processes: main lists and validates, the renderer runs.
 */
import { z } from 'zod';
import { allToolSpecs, getToolSpec, type ToolSpec } from './tools';

export type McpClass = 'expose' | { exclude: string };

/** Every read tool of the agent, and whether outside agents get it. */
export const MCP_TOOL_CLASS: Readonly<Record<string, McpClass>> = {
  list_layers: 'expose',
  list_clips: 'expose',
  find_clips_near: 'expose',
  find_places: 'expose',
  list_issues: 'expose',
  summarize_issues: 'expose',
  compare_captures: 'expose',
  measure_distance: 'expose',
  summarize_by_zone: 'expose',
  summarize_by_class: 'expose',
  find_issues_near: 'expose',
  list_sites: {
    exclude:
      'Spans every project of the library, whose privacy settings differ; the server answers for the open project only.',
  },
  list_changes: 'expose',
  list_my_work: 'expose',
  list_assets: 'expose',
  accuracy_summary: 'expose',
  list_measurements: 'expose',
  get_volume: 'expose',
  rank_locations: 'expose',
  query_facts: 'expose',
  history_of: 'expose',
  list_model_parts: 'expose',
  list_components: 'expose',
  list_model_corrections: 'expose',
  list_surveys: 'expose',
  list_detections: 'expose',
  list_jobs: 'expose',
  thermal_summary: 'expose',
  list_walks: 'expose',
  list_actions: 'expose',
};

/** True when the spec is read-only for every input (no `riskFor` that could raise it). */
const readOnly = (s: ToolSpec) => s.meta.risk === 'read' && !s.riskFor;

/** The read tools offered over MCP, in catalogue order. */
export function mcpToolSpecs(): ToolSpec[] {
  return allToolSpecs().filter((s) => readOnly(s) && MCP_TOOL_CLASS[s.meta.name] === 'expose');
}

/** True when outside agents may call this tool. */
export function isMcpTool(name: string): boolean {
  const spec = getToolSpec(name);
  return spec !== undefined && readOnly(spec) && MCP_TOOL_CLASS[name] === 'expose';
}

export interface McpToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: { type: 'object'; [k: string]: unknown };
  annotations: { readOnlyHint: true; destructiveHint: false; openWorldHint: false };
}

/** The JSON Schema of a tool's input, as the model and the agent validate it. */
export function inputJsonSchema(spec: ToolSpec): McpToolDefinition['inputSchema'] {
  const json = z.toJSONSchema(spec.input, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json.type === 'object'
    ? (json as McpToolDefinition['inputSchema'])
    : { type: 'object', properties: {} };
}

/** The MCP `tools/list` answer, built from the agent's specs. */
export function mcpToolList(): McpToolDefinition[] {
  return mcpToolSpecs().map((s) => ({
    name: s.meta.name,
    description: s.meta.description,
    inputSchema: inputJsonSchema(s),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }));
}

/** Validate an outside agent's input against the tool's spec, with a message it can act on. */
export function parseMcpInput(
  name: string,
  input: unknown,
): { ok: true; input: unknown } | { ok: false; error: string } {
  const spec = getToolSpec(name);
  if (!spec || !isMcpTool(name)) return { ok: false, error: `Unknown tool "${name}".` };
  const r = spec.input.safeParse(input ?? {});
  if (r.success) return { ok: true, input: r.data };
  const first = r.error.issues[0];
  const where = first?.path.length ? ` at ${first.path.join('.')}` : '';
  return { ok: false, error: `Invalid input${where}: ${first?.message ?? 'does not match'}.` };
}

/**
 * A tool result as an outside agent gets it: JSON text, with any image removed (read-only first:
 * no imagery leaves the app through MCP).
 */
export function mcpOutput(result: unknown, summary: string): string {
  if (result === undefined) return JSON.stringify({ summary });
  if (typeof result === 'object' && result !== null && 'image' in result) {
    return JSON.stringify({ ...(result as Record<string, unknown>), image: 'omitted' });
  }
  return JSON.stringify(result);
}
