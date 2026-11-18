/**
 * The open project's tool sets, read from the stores (tools by project type, 18 Nov 2026): its
 * type and the list a person chose (the manifest), and the records it holds (`Held`). The rule is
 * `toolSets.ts`; this module only gathers the facts.
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
  const kit = useVolumetric((s) => kitShown(s.status));
  const piles = useMeasure((s) => hasPiles(s.file.measurements));
  const road = useRoad((s) => s.status === 'ready');
  const telecomMeasured = useMeasure((s) => hasTelecom(s.file.measurements));
  const inventory = useAntennas((s) => s.file !== null);
  const plan = useRf((s) => (s.hasFile || s.antennas !== null) && s.projectId === projectId);
  const thermal = useStore(heldFacts, (s) => s.thermal);
  return useMemo(
    () => ({
      earthworks: kit || piles,
      road,
      telecom: telecomMeasured || inventory || plan,
      thermal,
    }),
    [kit, piles, road, telecomMeasured, inventory, plan, thermal],
  );
}

/** The open project's tool sets (React). */
export function useToolSets(): ReadonlySet<ToolSet> {
  const manifest = useWorkspace((s) => s.project?.manifest ?? null);
  const held = useHeld();
  return useMemo(() => toolSetsFor(manifest, held), [manifest, held]);
}
