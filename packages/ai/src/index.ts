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
export { CORRECTION_PROMPT_LEAD, correctionPrompt } from './correctionPrompt';
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
  estimateRfPlan,
  parseRfPlan,
  RF_PLAN_PROMPT_VERSION,
  rfPlanInstructions,
  rfPlanUserText,
  type AiPickRaw,
} from './rfPlan';
export {
  AgentPanel,
  describeStep,
  type AgentFixControls,
  type AgentPanelProps,
} from './AgentPanel';
export { AgentSession, type AgentFix, type SessionState, type Step, type Turn } from './session';
export { assembleContext, bindingLabel } from './context';
export {
  actionRisk,
  actionToolInputs,
  AGENT_ACTIONS,
  AGENT_TARGET_KINDS,
  type ActionTarget,
  type ActionToolInput,
  type AgentActionEntry,
} from './action-tool-specs';
export { surveyToolInputs, type SurveyToolInput, type SurveyToolName } from './survey-tool-specs';
export { captureRef, capturesOf, resolveCapture, resolveLayer } from './survey-tools';
export { factToolInputs, type FactToolInput, type FactToolName } from './fact-tool-specs';
export { factRow, isSubjectId, resolveSubject } from './fact-tools';
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
  registerStepDescriber,
  say,
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
  type StepUndo,
  type SeverityLevel,
  type ToolRunResult,
  type ViewFilters,
  type ViewScope,
} from './renderer-tools';
export {
  addProviderUsage,
  estimateCostUsd,
  formatMeter,
  priceFor,
  PRICES_AS_OF,
  totalUsage,
  type ProviderUsageRow,
  type UsageTotals,
} from './pricing';
export { conversationMarkdown, issuesCsv } from './exporting';
export {
  ASK_MARKER,
  ASK_MODELS,
  ASK_PROMPT_VERSION,
  ASK_SEND_MAX_PX,
  CHANGE_FIELDS,
  MAX_ASK_ITEMS,
  askMaxTokens,
  askPrompt,
  askProviderOptions,
  coerceField,
  estimateAsk,
  guardItems,
  parseAskReply,
  readJsonList,
  routeAsk,
  type AskFamily,
  type AskRoute,
} from './ask';
export {
  CHANGE_LABEL_FIELDS,
  CHANGE_LABEL_PROMPT,
  CHANGE_LABEL_WORDS,
  changeLabelAsk,
  readChangeLabel,
  type UnitBox,
} from './changeLabels';
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
// X1: the local MCP server's tool list (the agent's read tools); the server is in ./mcp
export { isMcpTool, mcpOutput, MCP_TOOL_CLASS } from './mcp-tools';
