import type { AiProvider, IpcEvent, IpcRequest } from '@aio/schema';

/** What the agent runtime needs from the Electron main process. */
export interface AgentRuntimeHost {
  /** API key from the OS vault, or null. Never logged, never sent to the renderer. */
  getKey(provider: AiProvider): Promise<string | null>;
  /** False when the person has cloud AI switched off: the runtime must refuse to call out. */
  cloudAllowed(): boolean;
  emit(event: IpcEvent<'ai:event'>): void;
}

export interface AgentRuntime {
  send(req: IpcRequest<'ai:send'>): Promise<{ ok: boolean; error?: string }>;
  toolResult(req: IpcRequest<'ai:toolResult'>): void;
  cancel(runId: string): void;
}

/**
 * Agent loop in the main process (Vercel AI SDK, providers Anthropic, OpenAI, Google). Owner:
 * stream S9. Phase 0 stub: refuses politely so the UI can be built against it.
 */
export function createAgentRuntime(host: AgentRuntimeHost): AgentRuntime {
  return {
    send: (req) => {
      if (!host.cloudAllowed()) {
        return Promise.resolve({
          ok: false,
          error: 'Cloud AI is off. Turn it on in Settings, AI providers, to use the agent.',
        });
      }
      host.emit({ type: 'error', runId: req.runId, message: 'The agent is not available yet.' });
      return Promise.resolve({ ok: false, error: 'The agent is not available yet.' });
    },
    toolResult: () => undefined,
    cancel: () => undefined,
  };
}
