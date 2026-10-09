// Cross-sections (G5): sampling along a line, pins and grades, cut and fill shading, the chart's
// vertical exaggeration, sections at alignment stations, the corridor band and the cutaway plane.
export {
  defaultStep,
  gradeOf,
  lineLength,
  MAX_STATIONS,
  pinAt,
  pointAtChainage,
  resolveSection,
  sampleSection,
  samplerOf,
  sectionLabel,
  stations,
  surfaceKey,
  SECTION_TIN_STEP_M,
  type Grade,
  type Pin,
  type PinValue,
  type PointSampler,
  type Section,
  type SectionRef,
  type SectionSurface,
  type Stations,
} from './profile';
export {
  chartScale,
  clampExaggeration,
  cutFill,
  MAX_EXAGGERATION,
  MIN_EXAGGERATION,
  niceStep,
  type ChartScale,
  type ShadePiece,
  type Shading,
} from './shade';
export { alignmentSections, corridorRing, cutawayPlane, type StationSection } from './stations';
