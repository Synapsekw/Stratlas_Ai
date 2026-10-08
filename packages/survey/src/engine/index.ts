// The survey engine's TypeScript executor (G2, ADR 0009): the comparison specification of
// data-conventions section 26 over prepared height tiles, design TINs and in-memory grids.
export {
  compareItem,
  compareItems,
  ENGINE_VERSION,
  fingerprint,
  isSurface,
  newShared,
  PARTIAL_SHARE,
  REFUSE_SHARE,
  sideLabel,
  SurfaceMissing,
  type CompareOptions,
  type GridOut,
  type Resolve,
  type ResolvedSurface,
  type Shared,
  type SiteContext,
} from './compare';
export {
  buildBase,
  f3,
  fitPlane,
  perimeterLevels,
  planeFn,
  Refused,
  TIN_STEP_M,
  type Samples,
} from './bases';
export { canonical, sha256Hex, type Json } from './fingerprint';
export { delaunay } from './delaunay';
export {
  coverage,
  crossesItself,
  densify,
  normalRing,
  ringArea,
  signedArea,
  windowOver,
  type Window,
  type XY,
} from './geometry';
export {
  ArraySurface,
  bilinear,
  buildTile,
  checkSignal,
  decodeTile,
  encodeTile,
  EngineCancelled,
  inflate,
  parseTile,
  sampleCells,
  TILE,
  TileCache,
  tileHeights,
  TileSurface,
  type GridSurface,
  type Tile,
  type TilesMeta,
} from './tiles';
export {
  earClip,
  exactCompare,
  HullExtension,
  rasterize,
  readTin,
  samplePoints,
  Tin,
  tinAt,
  type TinFile,
} from './tin';
export { Accumulator, type Accumulated } from './accumulate';
