import type { IpcRequest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { Bridge, Res } from '../bridge';
import { graphics } from '../graphics';
import { graphicsReport } from '../memoryWatch';

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

type Context = Omit<IpcRequest<'app:exportDiagnostics'>, 'problem'>;
type ReportValue = NonNullable<NonNullable<Context['graphics']>['report']>[string];

/** graphicsReport() in the shape the IPC contract accepts (short strings, short lists). */
async function reportForBundle(): Promise<Record<string, ReportValue> | undefined> {
  try {
    const out: Record<string, ReportValue> = {};
    for (const [k, v] of Object.entries(await graphicsReport()) as [string, unknown][]) {
      if (Array.isArray(v))
        out[k] = (v as unknown[]).slice(0, 20).map((x) => String(x).slice(0, 40));
      else if (typeof v === 'string') out[k] = v.slice(0, 500);
      else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    }
    return out;
  } catch {
    return undefined; // no stage or graphics yet: the bundle goes without the report
  }
}

/**
 * What only the renderer knows: the graphics tier in effect, its graphicsReport() (memory caps,
 * pressure, the live stage's estimate) and the project on screen.
 */
export async function rendererContext(): Promise<Context> {
  const out: Context = {};
  try {
    const g = graphics().getState();
    const report = await reportForBundle();
    out.graphics = {
      tier: g.tier,
      detected: g.detected,
      override: g.override,
      renderer: g.renderer ? g.renderer.slice(0, 500) : null,
      ...(report ? { report } : {}),
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
    ...(await rendererContext()),
    ...(problem ? { problem } : {}),
  });
  if (!r.ok) return r;
  if (r.value.error) return { ok: false, error: r.value.error };
  return { ok: true, value: r.value.path };
}
