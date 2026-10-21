import type { ServerOptions as HttpsOptions } from 'node:https';
import { PullOpsQuery, SYNC_ROUTES, type HealthResponse, type PullPage } from '@aio/schema';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  NONCE_WINDOW_MS,
  precheckRequest,
  verifyRequest,
  type NonceStore,
  type SignatureFailure,
} from './auth/signatures';
import { BlobHashError, BlobOffsetError, BlobQuotaError, type BlobStore } from './blobs/blobStore';
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
  /**
   * The reverse proxies (IPs or CIDRs) whose `X-Forwarded-*` headers count. Never every address:
   * then anyone could choose the address the rate limits see.
   */
  trustProxy?: false | string | readonly string[];
  /** Refuse a request that carries a content type or range its signature does not cover. */
  requireSignedHeaders?: boolean;
  /** Pino logging (structured, never bodies). Off in tests. */
  logger?: boolean;
  now?: () => Date;
  limits?: RateLimits;
}

/** `aio.sync/1` versions this server speaks. */
export const PROTOCOL_RANGE = { min: 1, max: 1 } as const;

/**
 * Largest JSON body. The app sends at most 1000 ops or about 6 MB per push, whichever comes first
 * (`PUSH_BATCH`, `PUSH_BATCH_BYTES` in `@aio/sync/http`).
 */
export const JSON_BODY_LIMIT = 8 * 1024 * 1024;
/** Largest enrolment: a device record and its certificates. */
const ENROL_LIMIT = 256 * 1024;
/** Largest blob part (8 MB parts plus headroom). */
const PART_LIMIT = 9 * 1024 * 1024;

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
    /** The device a request names, before its signature is checked. */
    claimed?: EnrolledDevice;
    /** The device whose signature verified. */
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
 * per device (RFC 9421); roles are enforced here. A signed request is checked in two steps: its
 * headers, clock and device before the body is read (`onRequest`), then the signature over the
 * body (`preHandler`), so nobody who is not enrolled can make the server read a large body.
 */
export function buildServer(options: ServerOptions): FastifyInstance {
  const now = options.now ?? (() => new Date());
  const limits = options.limits ?? defaultRateLimits();
  const nonces: NonceStore = {
    use: (device, nonce, nowMs) => options.store.useNonce(device, nonce, nowMs, NONCE_WINDOW_MS),
  };
  const verifyOptions = { requireCovered: options.requireSignedHeaders === true };
  const core = createCore({
    store: options.store,
    identity: options.identity,
    name: options.name ?? 'Team server',
    version: options.version,
    fingerprint: options.fingerprint ?? UNKNOWN_FINGERPRINT,
    now,
  });

  const trust = options.trustProxy;
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
    bodyLimit: JSON_BODY_LIMIT,
    trustProxy: trust ? (typeof trust === 'string' ? trust : [...trust]) : false,
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

  const refuseSignature = (reply: FastifyReply, why: SignatureFailure) =>
    fail(reply, 401, `signature-${why}`, SIGNATURE_MESSAGES[why]);
  const rateLimited = (reply: FastifyReply) =>
    fail(reply, 429, 'rate-limited', 'Too many requests; try again in a minute.');

  /** Before the body: the address limit, the signature headers, the clock, an enrolled device. */
  async function early(req: FastifyRequest, reply: FastifyReply) {
    if (!limits.address.take(req.ip, now().getTime())) return rateLimited(reply);
    const pre = precheckRequest(req.headers, now().getTime(), verifyOptions);
    if (!pre.ok) return refuseSignature(reply, pre.why);
    const device = await core.device(pre.device);
    if (!device) return refuseSignature(reply, 'unknown-device');
    req.claimed = device;
  }

  /** After the body: the signature, the nonce and the device's own rate limit. */
  async function signed(req: FastifyRequest, reply: FastifyReply) {
    const device = req.claimed;
    if (!device) return refuseSignature(reply, 'missing');
    const v = await verifyRequest(
      {
        method: req.method,
        url: targetUri(req),
        headers: req.headers,
        body: req.rawBody ?? Buffer.alloc(0),
      },
      (id) => (id === device.device ? device.key : null),
      nonces,
      now().getTime(),
      verifyOptions,
    );
    if (!v.ok) return refuseSignature(reply, v.why);
    if (!limits.device.take(device.device, now().getTime())) return rateLimited(reply);
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
  const guarded = { onRequest: early, preHandler: signed };

  app.get(SYNC_ROUTES.health, (): HealthResponse => ({
    ok: true,
    version: options.version,
    protocol: PROTOCOL_RANGE,
    server: { id: options.identity.id, publicKey: options.identity.publicKey },
  }));

  app.post(
    SYNC_ROUTES.enrol,
    {
      bodyLimit: ENROL_LIMIT,
      onRequest: async (req, reply) => {
        if (!limits.enrol.take(req.ip, now().getTime()))
          return fail(reply, 429, 'rate-limited', 'Too many enrolment attempts; try again later.');
        const pre = precheckRequest(req.headers, now().getTime(), verifyOptions);
        if (!pre.ok) return refuseSignature(reply, pre.why);
      },
    },
    async (req, reply) => {
      const body = req.body as { device?: { id?: unknown; key?: unknown } } | undefined;
      const key = typeof body?.device?.key === 'string' ? body.device.key : null;
      const v = await verifyRequest(
        {
          method: req.method,
          url: targetUri(req),
          headers: req.headers,
          body: req.rawBody ?? Buffer.alloc(0),
        },
        (device) => (device === body?.device?.id ? key : null),
        nonces,
        now().getTime(),
        verifyOptions,
      );
      if (!v.ok) return refuseSignature(reply, v.why);
      return core.enrol(req.body, v.device);
    },
  );

  app.get(SYNC_ROUTES.heads, guarded, async (req) => core.heads(deviceOf(req), projectId(req)));

  app.get(SYNC_ROUTES.ops, guarded, async (req, reply): Promise<PullPage | undefined> => {
    const q = PullOpsQuery.safeParse(req.query);
    if (!q.success) {
      await fail(reply, 400, 'bad-request', 'The query is not valid.');
      return undefined;
    }
    return core.pull(deviceOf(req), projectId(req), q.data.since, q.data.limit ?? 1000);
  });

  app.post(SYNC_ROUTES.ops, guarded, async (req, reply) => {
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

  app.get(SYNC_ROUTES.members, guarded, async (req) => ({
    members: await core.members(deviceOf(req), projectId(req)),
  }));

  // ---- blobs (by SHA-256, stored once; read by members of a project that names them) ----

  const noClients = (req: FastifyRequest, reply: FastifyReply) => {
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
    ...guarded,
    handler: async (req, reply) => {
      if (!noClients(req, reply)) return reply;
      const d = deviceOf(req);
      const s = sha(req);
      if (!validSha(s)) return fail(reply, 400, 'bad-request', 'Not a SHA-256.');
      const stat = await options.blobs.stat(s);
      // a blob this device may not read answers as one the server does not have
      if (!stat || !(await core.mayReadBlob(d, s))) {
        const received = await options.blobs.received(s, d.device);
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

  app.put(SYNC_ROUTES.blob, { ...guarded, bodyLimit: PART_LIMIT }, async (req, reply) => {
    if (!noClients(req, reply)) return reply;
    const d = deviceOf(req);
    if (!(await core.mayUploadBlob(d)))
      return fail(reply, 403, 'forbidden', 'Only owners and reviewers send project files.');
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
      const r = await options.blobs.write(s, start, total, data, d.device);
      if (r.complete) await core.uploadedBlob(d, s);
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
      if (e instanceof BlobQuotaError) return fail(reply, 413, 'quota', e.message);
      throw e;
    }
  });

  return app;
}
