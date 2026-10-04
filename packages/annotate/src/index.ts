export type { Issue, Sighting, SeverityModel, ClassCatalogue } from '@aio/schema';
export { validateIssueAgainstModel } from '@aio/schema';

// Issue model (pure)
export * from './model/ops';
export * from './model/query';
export * from './model/register';
export { History, applyChange, invert, type Change } from './model/history';
export {
  createIssueEditor,
  type AuditEntry,
  type BulkResult,
  type CreateInput,
  type DeriveSightings,
  type EditorState,
  type IssueEditor,
  type IssueEditorOptions,
} from './model/editor';
export {
  createIssueSaver,
  ipcWriteIssues,
  type IssueSaver,
  type SaveState,
  type SaveStateName,
  type WriteIssues,
} from './model/persist';

// Cross-view placement (ANN-9)
export * from './crossview/lens';
export {
  backProject,
  backProjectOutline,
  geomCenter,
  layerOf,
  GROUND_LAYER,
  type MeshSighting,
  type RaySurface,
} from './crossview/backproject';
export { createDeriver, type DeriverSources } from './crossview/derive';

// Tools
export * from './video/track';
export * from './tools/cloud';
export * from './tools/map';
export {
  bestAnchor,
  initialMeshDraw,
  issuePins,
  meshDrawReducer,
  meshSightingFromDraw,
  pickSurface,
  severityColor,
  sightingAnchor,
  surfacePointFromHit,
  type IssuePin,
  type MeshDrawEvent,
  type MeshDrawMode,
  type MeshDrawState,
} from './tools/mesh';
export { installIssueOverlay, ndcOf, startSceneTool, type SceneTool } from './tools/scene';
export {
  clusterScreen,
  hitItem,
  layoutPins,
  parsePinFilter,
  pinPasses,
  placeLabels,
  sevRank,
  type PinFilter,
  type PinItem,
  type PinLabel,
  type ScreenCluster,
  type ScreenPin,
} from './tools/declutter';
export {
  createPinDisplay,
  pinDisplay,
  usePinDisplay,
  type PinDisplayState,
} from './tools/pinDisplay';
export * as imageGeometry from './image/geometry';

// Import helpers (stream S10)
export * from './import';

// App runtime and components
export {
  annotateUi,
  beginSighting,
  cancelSighting,
  confirmSighting,
  focusIssue,
  getFlightPoses,
  issueEditor,
  issueSaver,
  loadFlightPoses,
  rememberImageSize,
  setAnnotationAuthor,
  setFlightPoses,
  useAnnotateUi,
  useIssueEditorState,
  type AnnotateUiState,
  type ImageTool,
  type PendingSighting,
} from './runtime';
export * from './components';
