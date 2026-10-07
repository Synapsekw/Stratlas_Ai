/**
 * Hub folders (M9 T5): a shared folder where each device writes only its own files that never
 * change (op chunks and blobs, temp name then rename), plus advisory presence. T0 holds the
 * layout; T5 implements the hub transport, presence and cloud-drive conflict copies.
 */
import { HUB_FILE, HUB_PATHS, PRESENCE_TTL_MS, type Presence } from '@aio/schema';

export { HUB_FILE, HUB_PATHS };

/** Is a presence file still current ("Rana has F03 open")? */
export function presenceFresh(p: Pick<Presence, 'at'>, nowMs: number): boolean {
  const at = Date.parse(p.at);
  return Number.isFinite(at) && nowMs - at <= PRESENCE_TTL_MS;
}
