/**
 * The two calls before a device can sync: `health` (unsigned, also the protocol check) and
 * `enrol` (an invite code and this device's public record, signed by the same key).
 */
import {
  EnrolResponse,
  HealthResponse,
  type DeviceRecord,
  type EnrolRequest,
  type IdentityCard,
} from '@aio/schema';
import { errorFor, TeamServerError, type HttpClient } from './client';
import { routePath } from './routes';

/** The `aio.sync/1` version this app speaks. */
export const CLIENT_PROTOCOL = 1;

function parse<T>(schema: { parse(v: unknown): T }, body: Buffer): T {
  try {
    return schema.parse(JSON.parse(body.toString('utf8')));
  } catch {
    throw new TeamServerError('protocol', 'This address does not answer like a team server.');
  }
}

/** Ask the server who it is; refuses a server that does not speak this app's protocol. */
export async function serverHealth(client: HttpClient): Promise<HealthResponse> {
  const res = await client.request('GET', routePath('health'), { sign: false });
  if (res.status !== 200) throw errorFor(res, 'Reaching the team server');
  const health = parse(HealthResponse, res.body);
  if (CLIENT_PROTOCOL < health.protocol.min || CLIENT_PROTOCOL > health.protocol.max) {
    throw new TeamServerError(
      'protocol',
      `This team server speaks protocol ${health.protocol.min} to ${health.protocol.max}; this app speaks ${CLIENT_PROTOCOL}. Update the app or the server.`,
    );
  }
  return health;
}

/** Enrol this device with an invite code (the client must sign with the record's key). */
export async function enrolDevice(
  client: HttpClient,
  code: string,
  device: DeviceRecord,
  card?: IdentityCard,
): Promise<EnrolResponse> {
  const body: EnrolRequest = { code: code.trim(), device, ...(card ? { card } : {}) };
  const res = await client.request('POST', routePath('enrol'), {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  if (res.status !== 200) throw errorFor(res, 'Enrolling');
  return parse(EnrolResponse, res.body);
}
