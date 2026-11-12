/**
 * The renderer side of the local MCP server (intelligence review Wave 3, X1): main sends
 * `mcp:call` for each read tool an outside agent calls, after it checked the project may be read;
 * this runs the agent's own executor (`runRendererTool`, the same code path as the in-app agent)
 * and answers `mcp:result`. Only MCP tools run (`isMcpTool`, read-only), only on the project main
 * checked, and the view is never touched: a read tool's result is all that goes back.
 */
import {
  defaultToolContext,
  getToolSpec,
  isMcpTool,
  mcpOutput,
  runRendererTool,
  type RendererToolContext,
} from '@aio/ai';
import type { AioBridge, McpCall, McpCallResult, WindowKind } from '@aio/schema';
import { workspace } from '@aio/workspace';

/** The window a tool runs against: the 3D view, or the first window the tool is offered in. */
export function mcpWindow(name: string): WindowKind {
  const windows = getToolSpec(name)?.meta.windows;
  return !windows || windows.includes('scene3d') ? 'scene3d' : (windows[0] ?? 'scene3d');
}

export async function runMcpCall(
  call: McpCall,
  context: (window: WindowKind) => RendererToolContext = defaultToolContext,
): Promise<McpCallResult> {
  const fail = (error: string): McpCallResult => ({ callId: call.callId, ok: false, error });
  if (!isMcpTool(call.name)) return fail(`Unknown tool "${call.name}".`);
  const gone = () => workspace.getState().project?.id !== call.projectId;
  if (gone()) return fail('That project is no longer open in the app.');
  try {
    // `outside`: the project's notes stay in the app (A3)
    const r = await runRendererTool(call.name, call.input, {
      ...context(mcpWindow(call.name)),
      outside: true,
    });
    // another project opened during the call: drop the result rather than mix the two
    if (gone()) return fail('That project is no longer open in the app.');
    return { callId: call.callId, ok: true, text: mcpOutput(r.result, r.summary) };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/** Answer main's calls for as long as the app runs; returns the stop function. */
export function startMcpBridge(
  aio: AioBridge | undefined = (globalThis as { aio?: AioBridge }).aio,
): () => void {
  if (!aio) return () => undefined;
  return aio.on('mcp:call', (call) => {
    void runMcpCall(call).then((r) => aio.invoke('mcp:result', r));
  });
}
