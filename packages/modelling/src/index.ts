/**
 * @aio/modelling (M8 stream C5, BLD-11): procedural models (`aio.procmodel/1`) made from DXF
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
export {
  validateGlb,
  type GlbReport,
  type KhronosResult,
  type KhronosValidator,
} from './engineer/validate';
export {
  addParts,
  applyDimension,
  checkProcModel,
  FAR_FROM_ORIGIN_M,
  findPart,
  movePart,
  newProcModel,
  partAnchor,
  partDimensions,
  partSummary,
  pipeLength,
  ringArea,
  selfCrossing,
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
