/**
 * The open project's tool sets, read from the stores (tools by project type, 18 Nov 2026): its
 * type and the list a person chose (the manifest), and the records it holds (`Held`). The rule is
 * `toolSets.ts`; this module only gathers the facts.
 *
 * A record that is there but could not be read counts as held: a project whose antenna file is
 * damaged keeps its Telecom tools, and with them the place that shows the error.
 */
import { inventoryPiles, isTelecomTool } from '@aio/survey';
import { useVolumetric } from '@aio/volumetric';
import { useWorkspace } from '@aio/workspace';
import type { SurveyMeasurement } from '@aio/schema';
import { useMemo } from 'react';
import { useStore } from 'zustand';
import { useRf } from '../rf/rfStore';
import { useRoad } from '../road/store';
import { useMeasure } from '../survey/measureStore';
import { useAntennas } from '../telecom/antennaStore';
import { heldFacts } from './heldFacts';
import { toolSetsFor, type Held, type ToolSet } from './toolSets';

const kitShown = (status: string): boolean => status !== 'none' && status !== 'idle';
const hasPiles = (list: readonly SurveyMeasurement[]): boolean => inventoryPiles(list).length > 0;
const hasTelecom = (list: readonly SurveyMeasurement[]): boolean =>
  list.some((m) => isTelecomTool(m.tool));

/** The records the open project holds, per tool set (React). */
export function useHeld(): Held {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  // the kit while it is read, read, or unreadable (`error`)
  const kit = useVolumetric((s) => kitShown(s.status));
  const piles = useMeasure((s) => hasPiles(s.file.measurements));
  // the measurements could not be read: they may hold piles and telecom measurements
  const unread = useMeasure((s) => s.status === 'error');
  // a road model, read or unreadable; a road survey still in setup holds none yet
  const road = useRoad((s) => s.status === 'ready' || s.status === 'error');
  const telecomMeasured = useMeasure((s) => hasTelecom(s.file.measurements));
  const inventory = useAntennas(
    (s) => s.file !== null || (s.status === 'error' && s.projectId === projectId),
  );
  // the inventory as the coverage planner read it, saved sectors (an RF plan), or either unreadable
  const plan = useRf(
    (s) => (s.hasFile || s.antennas !== null || s.status === 'error') && s.projectId === projectId,
  );
  const thermal = useStore(heldFacts, (s) => s.thermal);
  return useMemo(
    () => ({
      earthworks: kit || piles || unread,
      road,
      telecom: telecomMeasured || inventory || plan || unread,
      thermal,
    }),
    [kit, piles, unread, road, telecomMeasured, inventory, plan, thermal],
  );
}

/** The open project's tool sets (React). */
export function useToolSets(): ReadonlySet<ToolSet> {
  const manifest = useWorkspace((s) => s.project?.manifest ?? null);
  const held = useHeld();
  return useMemo(() => toolSetsFor(manifest, held), [manifest, held]);
}
