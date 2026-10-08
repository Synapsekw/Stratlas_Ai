// @aio/survey (M11): surveying in the renderer. G0 holds the public API skeleton; each stream
// fills its own folder (plan "Ownership after G0"):
// - engine/ (G2): the survey engine's TypeScript executor (ADR 0009: one specification, two
//   executors; the Python reference core is `aio_pipelines/survey`), run in a worker;
// - tools/ and templates/ (G3): typed measurement tools, drawing aids and the template library;
// - section/ (G5): cross-sections and their chart data;
// - calc/ (G4): calculators and materials (density, swell, mass) at display time.
// Units and coordinates are `@aio/geo` (G1), not this package.

export type {
  BaseSpec,
  ComparisonItem,
  ComparisonResult,
  ComparisonStatus,
  MeasurementFamily,
  MeasurementTool,
  SectionProfile,
  SectionSpec,
  SiteMaterial,
  SurfaceRef,
  SurveyEngine,
  SurveyMeasurement,
  SurveySettings,
  SurveyTemplate,
} from '@aio/schema';

/**
 * Version of the TypeScript executor's arithmetic. It goes into every result's `fingerprint`, so
 * a change that alters numbers marks results computed before it stale. Bump it with the Python
 * core's own version when the specification changes.
 */
export const SURVEY_ENGINE_VERSION = 1;

export { signedVolumeTotals, type VolumeTotals } from './totals';

// designs/ (G6): design TINs, alignments and compliance to design
export { parseTin, TinError, TinSampler, TIN_CHAIN, type Tin, type TinChain } from './designs/tin';
export {
  alignmentPolyline,
  bearing,
  distanceAt,
  elementPoint,
  formatStation,
  pointAt,
  pointAtStation,
  stationAt,
  stationLabels,
  stationOffset,
  stationRegions,
  totalLength,
  type StationLabel,
  type StationOffset,
  type StationRegion,
} from './designs/alignment';
export {
  COMPLIANCE_COLOURS,
  DESIGN_PRESET_LABELS,
  designComparisonItem,
  toleranceBand,
  toleranceHeatmap,
  toleranceShare,
  type DesignPreset,
  type ToleranceBand,
  type ToleranceShare,
} from './designs/compliance';
