/**
 * Tools (D2, D3): a section per tool group whose data the project holds, in one order. Until the
 * tool registry (W8) it shows today's benches: Measure's catalogue with its live tool card,
 * Annotate, Point cloud, Terrain analysis, Survey checks, Video, Engineering, Coverage, Thermal
 * and Environment.
 */
import { PanelSections } from './PanelSections';

export function ToolsTab() {
  return <PanelSections tab="tools" />;
}
