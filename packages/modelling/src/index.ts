/**
 * @aio/modelling (M8 stream C5, BLD-11): procedural models (`aio.procmodel/2`) made from DXF
 * drawings, point cloud fits, the agent or by hand, meshed into a GLB with one node per part; and
 * the engineering model (`aio.procmodel/2` assemblies): builders, PBR component GLB, file checks.
 */
export {
  glbNodeName,
  meshPart,
  meshParts,
  meshProcModel,
  partColour,
  partNodeName,
  triangulate,
  type MeshedModel,
  type PartMesh,
  type PartNode,
} from './mesher';
export {
  readGlb,
  writeGlb,
  writeGlbV2,
  type GlbMaterial,
  type GlbNodeV2,
  type GlbPart,
} from './glb';
export { MeshSink, SEGMENTS, type Opening, type Prim, type V3 } from './engineer/geom';
export { ctxFor, type BuildCtx, type Builder } from './engineer/builders/ctx';
export {
  anchorOf,
  buildAssembly,
  buildEngineeringGlb,
  BUILDERS,
  componentExtras,
  meshAssemblies,
  type ComponentMesh,
  type EngineeringGlb,
  type MeshAssembliesResult,
} from './engineer/meshAssemblies';
export { DEFAULT_MATERIALS, resolveMaterials } from './engineer/materials';
/** Synthetic whole models (no real asset), for tests, end to end specs and demos. */
export {
  FIXTURE_MODELS,
  flareModel,
  latticeModel,
  monopoleModel,
  stackModel,
} from './engineer/fixtures';
export {
  ASSUMED_HEIGHT_M,
  assemble,
  FAMILIES,
  type AssembleInput,
  type AssembleResult,
  type Candidates,
  type FamilyAssembler,
  type FamilyCtx,
  type UserOverrides,
} from './engineer/assemble/assemble';
export { assignIds, azimuthDeg, type IdItem } from './engineer/assemble/ids';
export { mergeModels, type MergeResult } from './engineer/assemble/merge';
export { deckOpenings } from './engineer/assemble/chimney';
export { assembleFlare, SERVICE_LINE_OFFSET } from './engineer/assemble/flare';
export { assembleLattice, assembleMonopole, SECTOR_GAP_DEG } from './engineer/assemble/telecom';
export {
  componentRegister,
  exportBundle,
  type BundleBuild,
  type ComponentRow,
  type EngineeringBundle,
} from './engineer/exportBundle';
export {
  validateGlb,
  type GlbReport,
  type KhronosResult,
  type KhronosValidator,
} from './engineer/validate';
export {
  addParts,
  applyDimension,
  assemblySummary,
  checkProcModel,
  FAR_FROM_ORIGIN_M,
  findAssembly,
  findPart,
  movePart,
  newProcModel,
  partAnchor,
  partDimensions,
  partSummary,
  pipeLength,
  readProcModel,
  ringArea,
  selfCrossing,
  setAssemblyStatus,
  setPartStatus,
  summarise,
  updatePart,
  type Dimension,
  type DimensionKey,
  type ModelProblem,
  type PartPatch,
} from './procmodel';
export {
  drawingsOf,
  dxfStemOf,
  drawingToLocal,
  findDrawing,
  isDrawingPlan,
  pictureOwnsStem,
  localToDrawing,
  parsePlacement,
  readDrawingParts,
  type DrawingInfo,
  type DrawingPlacement,
} from './drawing';
export { fitQuality, ModelBuilder, type ModelBuilderProps } from './ModelBuilder';
export {
  addAssembly,
  applyAssemblyField,
  assemblyFields,
  kindLabel,
  newAssembly,
  nextAssemblyId,
  removeAssembly,
  removeAssemblyOverrides,
  roleOfKind,
  type AssemblyField,
} from './assemblyEdit';
export {
  ComponentCard,
  coverageWords,
  residualWords,
  type ComponentCardProps,
  type ComponentEvidence,
} from './ComponentCard';
export { ComponentTree, type ComponentTreeProps } from './ComponentTree';
export { ComponentsSection, type ComponentsPanel } from './ComponentsSection';
