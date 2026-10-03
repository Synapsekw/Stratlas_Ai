import type { WindowKind } from '@aio/schema';

export interface AgentPanelProps {
  /** The window this agent is bound to; its context travels with every message. */
  window: WindowKind;
  className?: string;
}

/**
 * Agent panel: conversation, tool steps with approve, reject and undo, cost meter. Sends through
 * window.aio 'ai:send', executes renderer tools on 'ai:event' tool calls. Owner: stream S9.
 *
 * Phase 0 stub.
 */
export function AgentPanel({ window, className }: AgentPanelProps) {
  return (
    <div className={className} data-stub="agent-panel">
      Agent: {window}
    </div>
  );
}
