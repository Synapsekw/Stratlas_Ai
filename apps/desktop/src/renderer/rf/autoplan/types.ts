import type { RfCarrier, RfEquipment } from '@aio/schema';

/** One proposed equipment and carrier for one antenna, from the AI, the rules or a cell export. */
export interface PlanPick {
  equipment: RfEquipment;
  carrier: Omit<RfCarrier, 'id' | 'feederLossDb' | 'origin'>;
  /** Electrical tilt from a cell export row, degrees; AI and rules never set it. */
  etiltDeg?: number;
  by: 'ai' | 'rules' | 'export';
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}
