import { SYNC_ROUTES, type HealthResponse } from '@aio/schema';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { Store } from './store/store';

export interface ServerOptions {
  store: Store;
  /** Server version, reported by `/v1/health`. */
  version: string;
  /** Pino logging (structured, never payloads). Off in tests. */
  logger?: boolean;
}

/** `aio.sync/1` versions this server speaks. */
export const PROTOCOL_RANGE = { min: 1, max: 1 } as const;

declare module 'fastify' {
  interface FastifyInstance {
    store: Store;
  }
}

/**
 * The Team Server skeleton (M9 T7, preview): health answers; every other route of `aio.sync/1`
 * answers 501 until T7 adds signed requests, role checks, receipts and the Postgres store.
 * HEAD on the blob route comes with its GET (Fastify `exposeHeadRoutes`).
 */
export function buildServer({ store, version, logger = false }: ServerOptions): FastifyInstance {
  const app = Fastify({ logger, bodyLimit: 16 * 1024 * 1024 });
  app.decorate('store', store);

  app.get(SYNC_ROUTES.health, (): HealthResponse => ({
    ok: true,
    version,
    protocol: PROTOCOL_RANGE,
  }));

  const notYet = (_req: unknown, reply: FastifyReply) =>
    reply
      .code(501)
      .send({ error: 'Not implemented yet in this server build.', code: 'not-implemented' });
  app.post(SYNC_ROUTES.enrol, notYet);
  app.get(SYNC_ROUTES.heads, notYet);
  app.get(SYNC_ROUTES.ops, notYet);
  app.post(SYNC_ROUTES.ops, notYet);
  app.get(SYNC_ROUTES.members, notYet);
  app.get(SYNC_ROUTES.blob, notYet);
  app.put(SYNC_ROUTES.blob, notYet);
  return app;
}
