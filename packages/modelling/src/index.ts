/**
 * @aio/modelling (M8 stream C5, BLD-11): procedural models (`aio.procmodel/1`) made from DXF
 * drawings, point cloud fits, the agent or by hand, meshed into a GLB with one node per part.
 */
export { meshProcModel, partNodeName, type MeshedModel } from './mesher';
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
