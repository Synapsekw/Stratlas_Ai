import { PRESENCE_TTL_MS, type Presence } from '@aio/schema';

/** Is a presence file still current ("Rana has F03 open")? */
export function presenceFresh(p: Pick<Presence, 'at'>, nowMs: number): boolean {
  const at = Date.parse(p.at);
  return Number.isFinite(at) && nowMs - at <= PRESENCE_TTL_MS;
}
