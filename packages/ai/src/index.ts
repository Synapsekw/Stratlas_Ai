// Renderer entry. The main process imports '@aio/ai/main' (runtime) and '@aio/ai/routes'.
export {
  DEFAULT_LOCAL_MODEL,
  defaultRoutes,
  missingKeyMessage,
  modelLabel,
  PROVIDER_LABELS,
  PROVIDERS,
  ROUTE_PROVIDERS,
  routeFor,
  type ModelRoute,
} from './routes';
export { capsFor, engineerReady, type LocalCaps, type ModelCaps } from './capabilities';
export { SendDialog } from './SendDialog';
// The engineer call itself runs in main ('@aio/ai/main'); the renderer gets its prompt and types.
export {
  engineerRepairText,
  engineerSystem,
  engineerUserText,
  evidenceNeed,
  imageLabel,
  payloadPreview,
  type EvidencePreviewContent,
  type EvidencePreviewImage,
  PROMPT_VERSION as ENGINEER_PROMPT_VERSION,
  PROPOSAL_PARAMS,
  type EngineerSetupView,
} from './engineerPrompt';
export type {
  EngineerCall,
  EngineerImage,
  EngineerImageKind,
  EngineerOutcome,
  EngineerPayload,
  EngineerPayloadImage,
  EngineerUsage,
} from './engineer';
export {
  ANTENNA_LABEL_PROMPT_VERSION,
  antennaLabelInstructions,
  antennaLabelUserText,
  estimateAntennaLabel,
  parseAntennaLabels,
  type ParsedAntennaLabels,
} from './antennaLabel';
export {
  AgentPanel,
  describeStep,
  type AgentFixControls,
  type AgentPanelProps,
} from './AgentPanel';
export { AgentSession, type AgentFix, type SessionState, type Step, type Turn } from './session';
export { assembleContext, bindingLabel } from './context';
export {
  allToolSpecs,
  approvalFor,
  getToolSpec,
  registerToolSpec,
  TOOL_SPECS,
  toolsForWindow,
  type ToolSpec,
} from './tools';
export {
  defaultToolContext,
  registerAppHooks,
  registerFrameSource,
  registerRendererTool,
  runRendererTool,
  ToolError,
  type AppHooks,
  type AddSightingRequest,
  type AddSightingResult,
  type AppScreen,
  type PlaceOnModelRequest,
  type PlaceOnModelResult,
  type PlaceOutcome,
  type SightingAt,
  type IssueViewFilter,
  type PhotoViewFilter,
  type PhotoRunRead,
  type PhotoViewResult,
  type ProcessPhotosRequest,
  type ProcessPhotosStarted,
  type RendererToolContext,
  type RendererToolRun,
  type SeverityLevel,
  type ToolRunResult,
  type ViewFilters,
  type ViewScope,
} from './renderer-tools';
export {
  addProviderUsage,
  estimateCostUsd,
  formatMeter,
  PRICES_AS_OF,
  totalUsage,
  type ProviderUsageRow,
  type UsageTotals,
} from './pricing';
export { conversationMarkdown, issuesCsv } from './exporting';
export {
  DEFAULT_BATCH,
  DETECT_PROMPT_VERSION,
  MAX_BATCH,
  SEND_MAX_PX,
  detectInstructions,
  detectUserText,
  estimateDetect,
  imageTokens,
  planBatches,
  sendSize,
  type AiDetection,
  type DetectClass,
  type DetectEstimate,
  type DetectPromptInput,
  type DetectSeverity,
} from './detect';
export {
  setChangeProducerRunner,
  type ChangeProducerRun,
  type ChangeProducerRunner,
} from './change-tools';
export { photoPlan } from './photo-frame';
export {
  parseCoordinate,
  registerPlaceSource,
  type Place,
  type PlaceKind,
  type PlaceSource,
} from './places';
export { SUGGESTIONS, suggestionsFor, type SuggestionFacts } from './suggestions';
export { viewContext } from './view-context';
export {
  assetIndex,
  clearAssetCache,
  describeIssue,
  issuesOn,
  severityLabel,
  type AssetIndex,
  type AssetLink,
  type IssueDetail,
} from './asset-index';
export { compareCodes } from './tool-kit';
