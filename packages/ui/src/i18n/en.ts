import { enShell } from './en/shell';
import { enPalette } from './en/palette';
import { enKeys } from './en/keys';
import { enAgent } from './en/agent';
import { enSettings } from './en/settings';
import { enLibrary } from './en/library';
import { enIsland } from './en/island';
import { enLayers } from './en/layers';
import { enWorkbench } from './en/workbench';
import { enStage } from './en/stage';
import { enSurvey } from './en/survey';
import { enProcessing } from './en/processing';
import { enCapture } from './en/capture';
import { enGlobe } from './en/globe';
import { enMaps } from './en/maps';
import { enInspect } from './en/inspect';
import { enAskAi } from './en/askAi';
import { enChange } from './en/change';
import { enRf } from './en/rf';
import { enTelecom } from './en/telecom';
import { enHouse } from './en/house';
import { enVreport } from './en/vreport';
import { enEng } from './en/eng';
import { enReview } from './en/review';
import { enAudit } from './en/audit';
import { enRoad } from './en/road';
import { enTeam } from './en/team';
import { enCommon } from './en/common';
import { enAskRun } from './en/askAiRun';
import { enAskPanel } from './en/askAiPanel';
import { enAskFields } from './en/askAiFields';
import { enAskSettings } from './en/askAiSettings';
import { enAskReport } from './en/askAiReport';
import { enLayoutSpike } from './en/layoutSpike';

/**
 * English UI strings for the main shell (title bar, sidebar, settings). The source catalogue:
 * every other locale is checked against it (`catalogueProblems`). Keys are `area.thing`;
 * plurals use `_one` / `_other` suffixes picked by `Intl.PluralRules`; placeholders are
 * `{name}`. The product name is never written here; pass it as `{product}` from @aio/brand.
 * No em or en dashes.
 *
 * The strings live in area modules under `./en/`, one per key prefix. Add a key to the module
 * of its prefix, never to this file. A feature with a new prefix gets its own module plus one
 * import and one spread line here. Prefix to module:
 *   en/shell.ts: titlebar, nav, connection, status, syncNotice, diskChanged, announce, online, help, diag
 *   en/palette.ts: palette
 *   en/keys.ts: keys
 *   en/agent.ts: agent
 *   en/settings.ts: settings, identity, classes, graphics, mapSources, tools, blobs
 *   en/library.ts: library, project, package, remove, trash, gate
 *   en/island.ts: island
 *   en/layers.ts: tree, actions, layerProps, layerExport
 *   en/workbench.ts: wb, bench, measureBench, measureCat, section, tabs, panel, measure, bulk, selection
 *   en/stage.ts: stage, show, strip, timeline, timelapse, datebar, split, hover, calendar, frames, lineUp, spot, view
 *   en/survey.ts: vol, mcard, pile, cutfill, materials, chart, surface, base, stockpiles, volumes
 *   en/processing.ts: processing, jobs, engine, builder, align, calibrate, photo, drop, position, cleanup, place
 *   en/capture.ts: walk, pano, media
 *   en/globe.ts: globe
 *   en/maps.ts: maps, mapMenu, g7, pin
 *   en/inspect.ts: inspect, detect, det, infer, card, lightbox, issues, thermal, report, reports
 *   en/askAi.ts: askAi, localAi
 *   en/change.ts: change, compare, imgChange, cloudChange, heat, narr, empty, evidence
 *   en/rf.ts: rf
 *   en/telecom.ts: telecom
 *   en/house.ts: house
 *   en/vreport.ts: vreport
 *   en/eng.ts: eng, component
 *   en/review.ts: review, collab, conflicts, queue
 *   en/audit.ts: audit
 *   en/road.ts: road, roadBench
 *   en/team.ts: team, teamServer
 *   en/common.ts: dialog
 *   en/layoutSpike.ts: layoutSpike
 *   en/askAi*.ts: custom analytics, one module per UI task (askAi, askPanel, fields, house, report, settings keys)
 */
export const en = {
  ...enShell,
  ...enPalette,
  ...enKeys,
  ...enAgent,
  ...enSettings,
  ...enLibrary,
  ...enIsland,
  ...enLayers,
  ...enWorkbench,
  ...enStage,
  ...enSurvey,
  ...enProcessing,
  ...enCapture,
  ...enGlobe,
  ...enMaps,
  ...enInspect,
  ...enAskAi,
  ...enChange,
  ...enRf,
  ...enTelecom,
  ...enHouse,
  ...enVreport,
  ...enEng,
  ...enReview,
  ...enAudit,
  ...enRoad,
  ...enTeam,
  ...enCommon,
  // Custom analytics (one catalogue file per UI task)
  ...enAskRun,
  ...enAskPanel,
  ...enAskFields,
  ...enAskSettings,
  ...enAskReport,
  ...enLayoutSpike,
} as const satisfies Record<string, string>;

/** Every key in the catalogue, plural forms included. */
export type CatalogueKey = keyof typeof en;
