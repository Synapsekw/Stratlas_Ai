/**
 * `@aio/change/core`: the pure part of change detection (no React, no DOM), for the main process
 * (`change:compute`) and the agent tools: change sets and the register, issue, detection and
 * vector change, the in-app producers and what a person's confirmation does to issues.
 */
export { ChangeCancelled, computeInApp, inAppKinds, type ComputeSources } from './compute';
export { detectionChanges, SITE_ZONE, type DetectionPass } from './detections';
export { issueChanges, issueDate, issuePosition, issueSize, seenOn } from './issues';
export {
  canMakeIssue,
  closeResolved,
  draftFromChange,
  trackPair,
  type DraftContext,
} from './issueOps';
export {
  changeSetId,
  counterpartPairs,
  IN_APP_KINDS,
  IN_APP_PRODUCERS,
  layersOf,
  orderPair,
  type DateIndex,
  type InAppKind,
} from './pairs';
export {
  buildChangeSet,
  changeStats,
  mergeReviews,
  registerRows,
  reviewItem,
  summarize,
  verdictCounts,
  type RegisterFilter,
  type RegisterRow,
  type RegisterSort,
  type ReviewStatus,
} from './register';
export { DEFAULT_VECTOR_KEYS, vectorChanges, type VectorChangeInput } from './vector';
