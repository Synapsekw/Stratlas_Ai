import type { RfCarrier, RfEquipment } from '@aio/schema';

/** One proposed equipment and carrier for one antenna, from the AI, the rules or a cell export. */
export interface PlanPick {
  equipment: RfEquipment;
  // TODO(merge): re-add 'origin' to the Omit list once RfCarrier carries it (Task 1).
  carrier: Omit<RfCarrier, 'id' | 'feederLossDb'>;
  by: 'ai' | 'rules' | 'export';
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}
