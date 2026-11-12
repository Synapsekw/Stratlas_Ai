export { extractFacts, fit, fitKey, inside, subjectOfTarget, type Extracted } from './extract';
export {
  indexFiles,
  openOrReset,
  pruneIndexes,
  stillThere,
  removeIndex,
  syncFolder,
  type FolderSync,
  type FolderSyncOptions,
} from './folder';
export {
  emptySources,
  parsePass,
  readProjectSources,
  type DetectionPass,
  type ProjectSources,
} from './sources';
export { ftsQuery, openFactIndex, type FactIndex, type SyncResult } from './store';
