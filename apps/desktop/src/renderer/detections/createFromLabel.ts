import { workspace } from '@aio/workspace';
import { createClass } from '../classes/store';
import { mapModelClass } from '../inspect/askAi/classMap';
import { loadDetections } from './store';

/**
 * Create class 'X' (ANN-7): the class named by a detection's word, then every detection with that
 * word resolves to it (the passes are read again; the resolver matches labels) and local models
 * map the word to it. Null when done, else why not.
 */
export async function createClassFromLabel(label: string): Promise<string | null> {
  const project = workspace.getState().project;
  if (!project) return 'No project is open.';
  let classId: string;
  try {
    classId = (await createClass(label)).id;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  mapModelClass(project.id, label, classId);
  await loadDetections(project.id, true);
  return null;
}
