import type { IpcRequest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { Bridge, Res } from '../bridge';
import { graphics } from '../graphics';

interface DiagnosticsState {
  /** The Report a problem dialog is open. */
  problemOpen: boolean;
  openProblem(): void;
  closeProblem(): void;
}

export const diagnostics = createStore<DiagnosticsState>((set) => ({
  problemOpen: false,
  openProblem: () => {
    set({ problemOpen: true });
  },
  closeProblem: () => {
    set({ problemOpen: false });
  },
}));

export function useDiagnostics<T>(selector: (s: DiagnosticsState) => T): T {
  return useStore(diagnostics, selector);
}

/** What only the renderer knows: the graphics tier in effect and the project on screen. */
export function rendererContext(): Omit<IpcRequest<'app:exportDiagnostics'>, 'problem'> {
  const out: Omit<IpcRequest<'app:exportDiagnostics'>, 'problem'> = {};
  try {
    const g = graphics().getState();
    out.graphics = {
      tier: g.tier,
      detected: g.detected,
      override: g.override,
      renderer: g.renderer ? g.renderer.slice(0, 500) : null,
    };
  } catch {
    // graphics not set up (tests): the bundle goes without it
  }
  const project = workspace.getState().project;
  if (project) out.openProject = project.id.slice(0, 200);
  return out;
}

/**
 * Save the diagnostics bundle (with the problem description when given). Resolves to the saved
 * path, null when the person cancelled the save dialog, or an error sentence.
 */
export async function saveDiagnostics(
  bridge: Bridge,
  problem?: { what: string; steps?: string },
): Promise<Res<string | null>> {
  const r = await bridge.call('app:exportDiagnostics', {
    ...rendererContext(),
    ...(problem ? { problem } : {}),
  });
  if (!r.ok) return r;
  if (r.value.error) return { ok: false, error: r.value.error };
  return { ok: true, value: r.value.path };
}
