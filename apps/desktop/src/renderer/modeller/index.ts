import { assetUrl, workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { setAgentModelCheck } from '../agent/modelCheck';
import { bridge, jobs } from '../shell';
import { registerModellingTools } from './agentTools';
import { activeEngineerSession } from './engineerTools';
import { createModeller, type Modeller } from './store';

/** The Model builder of this window (BLD-11). */
export const modeller = createModeller({ bridge, workspace, jobs });

export function useModeller<T>(selector: (s: Modeller) => T): T {
  return useStore(modeller, selector);
}

async function dataUrl(path: string): Promise<string> {
  const p = workspace.getState().project;
  if (!p) throw new Error('No project is open.');
  const r = await fetch(assetUrl(p.id, { path }));
  if (!r.ok) throw new Error(`Could not read ${path}.`);
  const blob = await r.blob();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      resolve(typeof fr.result === 'string' ? fr.result : '');
    };
    fr.onerror = () => {
      reject(new Error(`Could not read ${path}.`));
    };
    fr.readAsDataURL(blob);
  });
}

registerModellingTools({
  modeller,
  cloudRoute: async () => {
    const projectId = workspace.getState().project?.id;
    const r = await bridge.call('ai:status', projectId ? { projectId } : {});
    // unknown counts as cloud: never send a drawing on a guess
    return !r.ok || r.value.cloud;
  },
  cloudDrawings: () => workspace.getState().project?.manifest.aiCloudDrawings === true,
  dataUrl,
  clouds: () =>
    (workspace.getState().project?.manifest.layers ?? [])
      .filter((l) => l.kind === 'pointcloud')
      .map((l) => ({ id: l.id, name: l.name })),
});

// The agent is offered the modelling tools only in a project with a model (a procedural model or
// a saved engineering run), or while one is open (the Model builder, an engineering correction
// host). Unknown when either list cannot be read: the tools stay.
setAgentModelCheck({
  now: () => {
    const s = modeller.getState();
    return activeEngineerSession() !== null || s.open || s.model !== null || s.models.length > 0;
  },
  saved: async (projectId) => {
    const [models, runs] = await Promise.all([
      bridge.call('model:list', { projectId }),
      bridge.call('engineer:runList', { projectId }),
    ]);
    const procedural = models.ok && models.value.ok ? models.value.models.length : undefined;
    const engineering = runs.ok && runs.value.ok ? runs.value.runs.length : undefined;
    if ((procedural ?? 0) > 0 || (engineering ?? 0) > 0) return true;
    return procedural === undefined || engineering === undefined ? undefined : false;
  },
});
