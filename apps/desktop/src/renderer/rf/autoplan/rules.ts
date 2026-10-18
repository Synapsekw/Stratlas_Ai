/** Rules-only equipment pick: the no-AI fallback of Auto-plan (C2). Pure, offline. */
import type { AntennaUnit, RfCatalogueEntry } from '@aio/schema';
import { AAU_MIN_DEPTH_M, AAU_MIN_WIDTH_M, AUTOPLAN_AAU, AUTOPLAN_PANEL } from '../rfDefaults';
import { entryCoversBand } from './bandFit';
import type { PlanPick } from './types';

/** True when the band's downlink range lies inside the panel's port range and the radio's range. */
function panelCoversBand(
  catalogue: readonly RfCatalogueEntry[],
  antennaId: string,
  radioId: string,
  band: string,
): boolean {
  const antenna = catalogue.find((e) => e.id === antennaId);
  const radio = catalogue.find((e) => e.id === radioId);
  if (antenna?.kind !== 'antenna' || radio?.kind !== 'radio') return false;
  return entryCoversBand(antenna, band) && entryCoversBand(radio, band);
}

function aauPick(reason: string, confidence: PlanPick['confidence']): PlanPick {
  return {
    equipment: { kind: 'aau', aau: AUTOPLAN_AAU.aau },
    carrier: {
      tech: AUTOPLAN_AAU.tech,
      band: AUTOPLAN_AAU.band,
      bandwidthMhz: AUTOPLAN_AAU.bandwidthMhz,
    },
    by: 'rules',
    confidence,
    reason,
  };
}

const metres = (v: number) => `${v.toFixed(2)} m`;

export function rulesPick(unit: AntennaUnit, catalogue: readonly RfCatalogueEntry[]): PlanPick {
  // A unit read from an older file may lack a size, so read it as optional.
  const sizes: Partial<Pick<AntennaUnit, 'widthM' | 'depthM'>> = unit;
  const width = sizes.widthM?.value;
  const depth = sizes.depthM?.value;
  const face =
    width !== undefined && depth !== undefined && Number.isFinite(width) && Number.isFinite(depth)
      ? { width, depth }
      : undefined;
  const known = face !== undefined;
  const aauLike =
    face !== undefined && face.depth >= AAU_MIN_DEPTH_M && face.width >= AAU_MIN_WIDTH_M;
  const size = face ? `${metres(face.width)} × ${metres(face.depth)} deep face` : 'No size';

  if (aauLike) return aauPick(`${size}: AAU`, 'medium');

  const { antenna, radio, band, tech, bandwidthMhz } = AUTOPLAN_PANEL;
  if (!panelCoversBand(catalogue, antenna, radio, band))
    return aauPick(`${size}: the panel and radio cannot do ${band}, so AAU`, 'low');

  return {
    equipment: { kind: 'separate', antenna, radio },
    carrier: { tech, band, bandwidthMhz, radioUnit: radio },
    by: 'rules',
    confidence: known ? 'medium' : 'low',
    reason: known
      ? `${size}: panel and radio on ${band}`
      : 'No size measured: panel and radio on B3',
  };
}
