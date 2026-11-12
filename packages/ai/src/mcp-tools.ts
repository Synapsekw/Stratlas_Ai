/**
 * The tools the local MCP server offers (intelligence review Wave 3, X1): the agent's read tools,
 * taken from the same specs (`allToolSpecs()`), so the list outside agents see never drifts from
 * the in-app agent's. Every read tool is classified here, `pure` (exposed, with its reviewed
 * purity note) or `exclude` with a reason; the parity test (mcp-tools.test.ts) fails when a read
 * tool is added to the agent and not classified, or when a tool that is not `risk: 'read'` would
 * be exposed. No write, navigate or send tool is
 * ever offered. Shared by both processes: main lists and validates, the renderer runs.
 */
import { z } from 'zod';
import { allToolSpecs, getToolSpec, type ToolSpec } from './tools';

/**
 * `pure`: exposed, and its executor was reviewed to be pure (the note says what it reads): it
 * writes nothing, changes no view, camera, selection or screen, starts no job, capture or network
 * call, and does not decide what to share from the in-app route. `exclude`: never offered, why.
 * A tool is only exposed with a `pure` note; adding one means reading its executor first.
 */
export type McpClass = { pure: string } | { exclude: string };

const MODELLER =
  'Drawing-derived engineering model content: its consent is decided on the in-app route (or not at all), and an outside app is not that route.';

/**
 * Every read tool of the agent, and whether outside agents get it. Purity audit of 12 Nov 2026
 * (session note 2026-11-12-0600-local-mcp.md).
 */
export const MCP_TOOL_CLASS: Readonly<Record<string, McpClass>> = {
  list_layers: { pure: 'Manifest layers and their visibility.' },
  list_clips: { pure: 'Video layers and the active clip.' },
  find_clips_near: {
    pure: 'Flight logs read from the project (aio://project), one per clip, no cache.',
  },
  find_places: { pure: 'Scene nodes, manifest and the volumetric and road stores, read only.' },
  list_issues: { pure: 'Issues; the asset index walks the scene into an in-memory cache.' },
  summarize_issues: { pure: 'Issues and the in-memory asset index.' },
  compare_captures: {
    exclude:
      'Reads change sets through main change:read, which refreshes the compare-before-write record a later review save relies on.',
  },
  measure_distance: { pure: 'Resolves two targets; a clip target reads its flight log.' },
  summarize_by_zone: { pure: 'Issues and the manifest.' },
  summarize_by_class: { pure: 'Issues and the manifest.' },
  find_issues_near: { pure: 'Resolves a target, then issues.' },
  list_sites: {
    exclude:
      'Spans every project of the library, whose privacy settings differ; the server answers for the open project only.',
  },
  list_changes: {
    exclude:
      'Reads change sets through main change:read, which refreshes the compare-before-write record a later review save relies on.',
  },
  list_my_work: { pure: 'collab:read, members:list and identity:get, filtered to the role.' },
  list_assets: { pure: 'The in-memory asset index.' },
  accuracy_summary: { pure: 'photo:runs, photo:readRun and photo:readGcp.' },
  list_measurements: { pure: 'The measure store.' },
  get_volume: { pure: 'Volume, boundary and measurement files of the project; the compare store.' },
  rank_locations: { pure: 'Issues and the in-memory asset index.' },
  query_facts: { pure: 'facts:query on an index already built; never starts a build.' },
  history_of: { pure: 'facts:query and facts:history.' },
  list_model_parts: {
    exclude:
      'Not a pure read: it can save a new model and switch the modeller view, and it shares drawing content by the in-app route instead of the drawing consent.',
  },
  list_components: { exclude: MODELLER },
  list_model_corrections: { exclude: MODELLER },
  list_surveys: { pure: 'The manifest and the focused survey date.' },
  list_detections: { pure: 'The detection review store.' },
  list_jobs: { pure: 'The jobs store.' },
  thermal_summary: { pure: 'thermal/thermal.json of the project and cached photo probes.' },
  list_walks: { pure: 'Manifest walk layers.' },
  list_actions: {
    pure: 'The menu registry resolvers (appliesTo, disabled, label); never runs an action.',
  },
};

const exposed = (name: string): boolean => {
  const c = MCP_TOOL_CLASS[name];
  return c !== undefined && 'pure' in c && c.pure.trim().length > 0;
};

/** True when the spec is read-only for every input (no `riskFor` that could raise it). */
const readOnly = (s: ToolSpec) => s.meta.risk === 'read' && !s.riskFor;

/** The read tools offered over MCP, in catalogue order. */
export function mcpToolSpecs(): ToolSpec[] {
  return allToolSpecs().filter((s) => readOnly(s) && exposed(s.meta.name));
}

/** True when outside agents may call this tool. */
export function isMcpTool(name: string): boolean {
  const spec = getToolSpec(name);
  return spec !== undefined && readOnly(spec) && exposed(name);
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
