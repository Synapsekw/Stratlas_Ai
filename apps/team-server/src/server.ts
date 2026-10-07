import type { ServerOptions as HttpsOptions } from 'node:https';
import { PullOpsQuery, SYNC_ROUTES, type HealthResponse, type PullPage } from '@aio/schema';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { NonceCache, verifyRequest, type SignatureFailure } from './auth/signatures';
import { BlobHashError, BlobOffsetError, type BlobStore } from './blobs/blobStore';
import { createCore, ServerRefusal, type Core } from './core';
import type { ServerIdentity } from './identity';
import { defaultRateLimits, type RateLimits } from './rateLimit';
import type { EnrolledDevice, Store } from './store/store';

export interface ServerOptions {
  store: Store;
  blobs: BlobStore;
  identity: ServerIdentity;
  /** Server version, reported by `/v1/health` and at enrolment. */
  version: string;
  /** Shown to people at enrolment. */
  name?: string;
  /** TLS key and certificate: the server ends TLS itself. Absent: plain HTTP (loopback or a proxy). */
  https?: Pick<HttpsOptions, 'key' | 'cert'>;
  /** SHA-256 of the certificate people see (when a proxy ends TLS). */
  fingerprint?: string;
  /** The address people use (`https://team.example.com`); the signed target URI is built on it. */
  publicUrl?: string;
  /** Trust `X-Forwarded-*` from a reverse proxy. */
  trustProxy?: boolean;
  /** Pino logging (structured, never bodies). Off in tests. */
  logger?: boolean;
  now?: () => Date;
  limits?: RateLimits;
}

/** `aio.sync/1` versions this server speaks. */
export const PROTOCOL_RANGE = { min: 1, max: 1 } as const;

/** Largest blob part (8 MB parts plus headroom). */
const PART_LIMIT = 9 * 1024 * 1024;

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
    device?: EnrolledDevice;
  }
  interface FastifyInstance {
    core: Core;
  }
}

const SIGNATURE_MESSAGES: Record<SignatureFailure, string> = {
  missing: 'This request is not signed.',
  malformed: 'The request signature is not valid.',
  components: 'The request signature does not cover what the protocol requires.',
  digest: 'The request body does not match its digest.',
  expired: 'The request was signed too long ago, or this computer clock is off.',
  replay: 'This request was already received.',
  'unknown-device': 'This device is not enrolled on this server, or it was revoked.',
  signature: 'The request signature does not verify.',
};

const fail = (reply: FastifyReply, status: number, code: string, error: string) =>
  reply.code(status).send({ error, code });

/** A certificate fingerprint people compare, or 64 zeros when TLS ends at an unknown proxy. */
const UNKNOWN_FINGERPRINT = '0'.repeat(64);

/**
 * The Team Server (M9 T7, preview): `aio.sync/1` over Fastify. Every route but health is signed
 * per device (RFC 9421); roles are enforced here, at each op's clock reading.
 */
export function buildServer(options: ServerOptions): FastifyInstance {
  const now = options.now ?? (() => new Date());
  const limits = options.limits ?? defaultRateLimits();
  const nonces = new NonceCache();
  const core = createCore({
    store: options.store,
    identity: options.identity,
    name: options.name ?? 'Team server',
    version: options.version,
    fingerprint: options.fingerprint ?? UNKNOWN_FINGERPRINT,
    now,
  });

  const app = Fastify({
    logger: options.logger
      ? {
          level: 'info',
          // structured logs without bodies, signatures or nonces
          serializers: {
            req: (req: FastifyRequest) => ({
              method: req.method,
              url: req.url.split('?')[0] ?? req.url,
              device: req.headers['x-aio-device'],
            }),
          },
        }
      : false,
    bodyLimit: 64 * 1024 * 1024,
    trustProxy: options.trustProxy ?? false,
    ...(options.https ? { https: options.https } : {}),
  }) as unknown as FastifyInstance;
  app.decorate('core', core);

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    const buf = body as Buffer;
    req.rawBody = buf;
    try {
      done(null, buf.length ? (JSON.parse(buf.toString('utf8')) as unknown) : undefined);
    } catch {
      done(Object.assign(new Error('The body is not JSON.'), { statusCode: 400 }), undefined);
    }
  });
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: PART_LIMIT },
    (req, body, done) => {
      req.rawBody = body as Buffer;
      done(null, body);
    },
  );

  const targetUri = (req: FastifyRequest) =>
    new URL(req.url, options.publicUrl ?? `${req.protocol}://${req.host}`).href;

  /** Check the signature of a request from an enrolled device. */
  async function signed(req: FastifyRequest, reply: FastifyReply) {
    const ip = req.ip;
    if (!limits.address.take(ip, now().getTime()))
      return fail(reply, 429, 'rate-limited', 'Too many requests; try again in a minute.');
    const deviceId = req.headers['x-aio-device'];
    const device = typeof deviceId === 'string' ? await core.device(deviceId) : null;
    const v = verifyRequest(
      {
        method: req.method,
        url: targetUri(req),
        headers: req.headers,
        body: req.rawBody ?? Buffer.alloc(0),
      },
      () => device?.key ?? null,
      nonces,
      now().getTime(),
    );
    if (!v.ok) return fail(reply, 401, `signature-${v.why}`, SIGNATURE_MESSAGES[v.why]);
    if (!device)
      return fail(reply, 401, 'signature-unknown-device', SIGNATURE_MESSAGES['unknown-device']);
    if (!limits.device.take(device.device, now().getTime()))
      return fail(reply, 429, 'rate-limited', 'Too many requests; try again in a minute.');
    req.device = device;
  }

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ServerRefusal) return fail(reply, error.status, error.code, error.message);
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error({ err: { name: (error as Error).name } }, 'request failed');
    return fail(
      reply,
      status,
      status === 413 ? 'too-large' : status >= 500 ? 'internal' : 'bad-request',
      status >= 500 ? 'The server could not do this.' : (error as Error).message,
    );
  });

  /** The device `signed` put on the request. */
  const deviceOf = (req: FastifyRequest): EnrolledDevice => {
    if (!req.device) throw new ServerRefusal(401, 'signature-missing', SIGNATURE_MESSAGES.missing);
    return req.device;
  };
  const projectId = (req: FastifyRequest) => (req.params as { id: string }).id;

  app.get(SYNC_ROUTES.health, (): HealthResponse => ({
    ok: true,
    version: options.version,
    protocol: PROTOCOL_RANGE,
  }));

  app.post(SYNC_ROUTES.enrol, async (req, reply) => {
    if (!limits.enrol.take(req.ip, now().getTime()))
      return fail(reply, 429, 'rate-limited', 'Too many enrolment attempts; try again later.');
    const body = req.body as { device?: { id?: unknown; key?: unknown } } | undefined;
    const key = typeof body?.device?.key === 'string' ? body.device.key : null;
    const v = verifyRequest(
      {
        method: req.method,
        url: targetUri(req),
        headers: req.headers,
        body: req.rawBody ?? Buffer.alloc(0),
      },
      (device) => (device === body?.device?.id ? key : null),
      nonces,
      now().getTime(),
    );
    if (!v.ok) return fail(reply, 401, `signature-${v.why}`, SIGNATURE_MESSAGES[v.why]);
    return core.enrol(req.body, v.device);
  });

  app.get(SYNC_ROUTES.heads, { preHandler: signed }, async (req) =>
    core.heads(deviceOf(req), projectId(req)),
  );

  app.get(
    SYNC_ROUTES.ops,
    { preHandler: signed },
    async (req, reply): Promise<PullPage | undefined> => {
      const q = PullOpsQuery.safeParse(req.query);
      if (!q.success) {
        await fail(reply, 400, 'bad-request', 'The query is not valid.');
        return undefined;
      }
      return core.pull(deviceOf(req), projectId(req), q.data.since, q.data.limit ?? 1000);
    },
  );

  app.post(SYNC_ROUTES.ops, { preHandler: signed }, async (req, reply) => {
    const body = req.body as { ops?: unknown } | undefined;
    if (!Array.isArray(body?.ops) || body.ops.length < 1 || body.ops.length > 5000)
      return fail(reply, 400, 'bad-request', 'Send between 1 and 5000 ops.');
    const { forbidden, ...result } = await core.push(deviceOf(req), projectId(req), body.ops);
    if (forbidden) {
      return reply.code(403).send({
        ...result,
        error: result.refused[0]?.message ?? 'Not allowed.',
        code: 'forbidden',
      });
    }
    return result;
  });

  app.get(SYNC_ROUTES.members, { preHandler: signed }, async (req) => ({
    members: await core.members(deviceOf(req), projectId(req)),
  }));

  // ---- blobs (by SHA-256, shared by every project; uploads in parts that resume) ----

  const blobAccess = (req: FastifyRequest, reply: FastifyReply) => {
    if (deviceOf(req).role === 'client') {
      void fail(reply, 403, 'forbidden', 'Clients do not exchange project files.');
      return false;
    }
    return true;
  };
  const sha = (req: FastifyRequest) => (req.params as { sha256: string }).sha256;
  const validSha = (s: string) => /^[a-f0-9]{64}$/.test(s);

  app.route({
    method: ['GET', 'HEAD'],
    url: SYNC_ROUTES.blob,
    exposeHeadRoute: false,
    preHandler: signed,
    handler: async (req, reply) => {
      if (!blobAccess(req, reply)) return reply;
      const s = sha(req);
      if (!validSha(s)) return fail(reply, 400, 'bad-request', 'Not a SHA-256.');
      const stat = await options.blobs.stat(s);
      if (!stat) {
        const received = await options.blobs.received(s);
        reply.header('x-aio-blob-received', String(received));
        if (req.method === 'HEAD') return reply.code(404).send();
        return fail(reply, 404, 'not-found', 'This server does not have that file.');
      }
      reply.header('accept-ranges', 'bytes');
      reply.header('content-type', 'application/octet-stream');
      if (req.method === 'HEAD') {
        reply.header('content-length', String(stat.size));
        return reply.code(200).send();
      }
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      if (range?.[1] !== undefined) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]) + 1, stat.size) : stat.size;
        if (start >= stat.size || end <= start) {
          reply.header('content-range', `bytes */${stat.size}`);
          return fail(reply, 416, 'range', 'That range is outside the file.');
        }
        reply.code(206);
        reply.header('content-range', `bytes ${start}-${end - 1}/${stat.size}`);
        reply.header('content-length', String(end - start));
        return reply.send(await options.blobs.read(s, { start, end }));
      }
      reply.header('content-length', String(stat.size));
      return reply.send(await options.blobs.read(s));
    },
  });

  app.put(SYNC_ROUTES.blob, { preHandler: signed }, async (req, reply) => {
    if (!blobAccess(req, reply)) return reply;
    const s = sha(req);
    if (!validSha(s)) return fail(reply, 400, 'bad-request', 'Not a SHA-256.');
    const cr = req.headers['content-range'] ?? '';
    const empty = /^bytes \*\/0$/.exec(cr);
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
    const data = req.rawBody ?? Buffer.alloc(0);
    let start = 0;
    let total = 0;
    if (empty) {
      if (data.length !== 0) return fail(reply, 400, 'bad-request', 'An empty file has no bytes.');
    } else if (m?.[1] && m[2] && m[3]) {
      start = Number(m[1]);
      total = Number(m[3]);
      if (Number(m[2]) - start + 1 !== data.length || Number(m[2]) >= total)
        return fail(reply, 400, 'bad-request', 'The content range does not match the part.');
    } else {
      return fail(reply, 400, 'bad-request', 'Send each part with a Content-Range header.');
    }
    try {
      const r = await options.blobs.write(s, start, total, data);
      reply.header('x-aio-blob-received', String(r.received));
      return await reply
        .code(r.complete ? 201 : 202)
        .send({ received: r.received, complete: r.complete });
    } catch (e) {
      if (e instanceof BlobOffsetError) {
        reply.header('x-aio-blob-received', String(e.received));
        return fail(reply, 409, 'offset', e.message);
      }
      if (e instanceof BlobHashError) return fail(reply, 422, 'hash', e.message);
      throw e;
    }
  });

  return app;
}
