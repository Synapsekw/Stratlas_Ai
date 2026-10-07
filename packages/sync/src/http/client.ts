/**
 * The low-level team server client: one HTTP/1.1 request per connection over TLS, with the
 * server certificate pinned by its SHA-256 fingerprint (accepted by the person at enrolment), and
 * every request signed by the device key (`signature.ts`). Plain HTTP is allowed only to this
 * computer (tests, a trial server); anything else needs TLS.
 *
 * The TLS socket is made first and checked against the pin before a single byte of the request is
 * written (`createConnection` with a callback), so a wrong server never sees a signed request.
 */
import { createHash } from 'node:crypto';
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions as HttpRequestOptions,
} from 'node:http';
import { isIP, type Socket } from 'node:net';
import * as tls from 'node:tls';
import type { Signer } from '@aio/journal';
import { signRequest } from './signature';

/** Why a call to the team server failed, for exact messages in the app. */
export type TeamServerErrorCode =
  | 'unreachable'
  | 'insecure'
  | 'fingerprint'
  | 'protocol'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'rate-limited'
  | 'http';

export class TeamServerError extends Error {
  constructor(
    readonly code: TeamServerErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TeamServerError';
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Is this host this computer (plain HTTP allowed)? */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase());
}

/** The origin of a team server address, checked: https, or http only to this computer. */
export function serverOrigin(address: string): string {
  let u: URL;
  try {
    u = new URL(address.trim());
  } catch {
    throw new TeamServerError('insecure', 'That is not a web address.');
  }
  if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) {
    throw new TeamServerError('insecure', 'A team server needs a secure address (https).');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new TeamServerError('insecure', 'A team server address starts with https://.');
  }
  return u.origin;
}

/** SHA-256 of a certificate in DER form, lower-case hex: the fingerprint people compare. */
export function certFingerprint(der: Uint8Array): string {
  return createHash('sha256').update(der).digest('hex');
}

/** Node's CA list plus the operating system's (corporate CAs), where this Node has both. */
function trustedCas(): string[] | undefined {
  const get = (tls as { getCACertificates?: (type?: string) => string[] }).getCACertificates;
  if (typeof get !== 'function') return undefined;
  try {
    return [...get('default'), ...get('system')];
  } catch {
    return undefined;
  }
}

const socketHost = (hostname: string) => hostname.replace(/^\[(.*)\]$/, '$1');

function networkError(e: unknown, origin: string): TeamServerError {
  if (e instanceof TeamServerError) return e;
  const code = (e as { code?: string }).code ?? '';
  return new TeamServerError(
    'unreachable',
    `The team server at ${origin} did not answer${code ? ` (${code})` : ''}.`,
  );
}

export interface PinOptions {
  /** The pinned fingerprint; null only to read it on first contact (`probeFingerprint`). */
  fingerprint: string | null;
  /**
   * Also accept a different certificate that chains to a trusted CA (Node's or the system's) and
   * names this host: a corporate CA renewing the server certificate. The new fingerprint is
   * reported through `onFingerprint`.
   */
  trustCaOnChange?: boolean;
  timeoutMs?: number;
}

interface Pinned {
  socket: tls.TLSSocket;
  fingerprint: string;
}

/**
 * Open a TLS connection and check the certificate before anything is sent. `probe`: accept any
 * certificate only to read its fingerprint (nothing is ever sent on a probe).
 */
function connectPinned(url: URL, pin: PinOptions, probe = false): Promise<Pinned> {
  const host = socketHost(url.hostname);
  const port = Number(url.port || 443);
  const timeoutMs = pin.timeoutMs ?? 15_000;
  return new Promise((resolve, reject) => {
    const ca = pin.trustCaOnChange ? trustedCas() : undefined;
    const socket = tls.connect({
      host,
      port,
      ...(isIP(host) ? {} : { servername: host }),
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
      ...(ca ? { ca } : {}),
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy(
        new TeamServerError('unreachable', `The team server at ${url.origin} timed out.`),
      );
    });
    socket.once('error', (e) => {
      reject(networkError(e, url.origin));
    });
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const raw = cert.raw as Buffer | undefined; // empty object when the server sent none
      const fingerprint = raw ? certFingerprint(raw) : '';
      const pinned = pin.fingerprint !== null && fingerprint === pin.fingerprint;
      const trustedChange = pin.trustCaOnChange === true && socket.authorized;
      if (!probe && !pinned && !trustedChange) {
        socket.destroy();
        reject(
          new TeamServerError(
            'fingerprint',
            `The team server at ${url.origin} shows a different certificate than the one you accepted. Ask your IT team before you connect again.`,
          ),
        );
        return;
      }
      socket.setTimeout(0);
      resolve({ socket, fingerprint });
    });
  });
}

/** First contact: read the server certificate's fingerprint, to show and confirm. */
export async function probeFingerprint(address: string, timeoutMs = 15_000): Promise<string> {
  const url = new URL(serverOrigin(address));
  if (url.protocol !== 'https:') {
    throw new TeamServerError('insecure', 'This address has no certificate to check (http).');
  }
  const { socket, fingerprint } = await connectPinned(url, { fingerprint: null, timeoutMs }, true);
  socket.destroy();
  return fingerprint;
}

export interface HttpClientOptions extends PinOptions {
  /** The server origin (`https://team.example.com`). */
  baseUrl: string;
  /** The device signer; without one, requests are not signed (health only). */
  signer?: Signer;
  /** A changed certificate accepted through `trustCaOnChange`. */
  onFingerprint?: (fingerprint: string) => void;
  /** Largest buffered response body (ops pages, members). */
  maxBodyBytes?: number;
}

export interface RequestOptions {
  body?: Uint8Array | string;
  headers?: Record<string, string>;
  /** Sign the request (default: when the client has a signer). */
  sign?: boolean;
}

export interface BufferedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface StreamResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: IncomingMessage;
}

export interface HttpClient {
  readonly origin: string;
  /** Send a request and read the whole answer (JSON routes). */
  request(method: string, path: string, opts?: RequestOptions): Promise<BufferedResponse>;
  /** Send a request and stream the answer (blob downloads). */
  stream(method: string, path: string, opts?: RequestOptions): Promise<StreamResponse>;
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const origin = serverOrigin(options.baseUrl);
  const base = new URL(origin);
  const secure = base.protocol === 'https:';
  if (secure && options.fingerprint === null && options.trustCaOnChange !== true) {
    throw new TeamServerError('fingerprint', 'Accept the server certificate first.');
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBody = options.maxBodyBytes ?? 256 * 1024 * 1024;

  function send(method: string, path: string, opts: RequestOptions): Promise<IncomingMessage> {
    const url = new URL(path, origin);
    const body = opts.body ?? '';
    const signed =
      (opts.sign ?? true) && options.signer
        ? signRequest(options.signer, { method, url: url.href, body })
        : {};
    const headers: Record<string, string> = {
      host: url.host,
      accept: 'application/json',
      ...(opts.headers ?? {}),
      ...signed,
    };
    if (method !== 'GET' && method !== 'HEAD')
      headers['content-length'] = String(Buffer.byteLength(body));
    return new Promise((resolve, reject) => {
      const createConnection = secure
        ? (_opts: unknown, oncreate: (err: Error | null, socket?: Socket) => void) => {
            connectPinned(url, { ...options, timeoutMs }).then(
              ({ socket, fingerprint }) => {
                if (fingerprint !== options.fingerprint) options.onFingerprint?.(fingerprint);
                oncreate(null, socket);
              },
              (e: unknown) => {
                oncreate(e instanceof Error ? e : new Error(String(e)));
              },
            );
            return undefined;
          }
        : undefined;
      let req: ClientRequest;
      try {
        req = httpRequest({
          host: socketHost(url.hostname),
          port: Number(url.port || (secure ? 443 : 80)),
          method,
          path: url.pathname + url.search,
          headers,
          timeout: timeoutMs,
          ...(createConnection ? { createConnection } : {}),
        } as unknown as HttpRequestOptions);
      } catch (e) {
        reject(networkError(e, origin));
        return;
      }
      req.on('timeout', () => {
        req.destroy(new TeamServerError('unreachable', `The team server at ${origin} timed out.`));
      });
      req.on('error', (e) => {
        reject(networkError(e, origin));
      });
      req.on('response', resolve);
      req.end(method === 'GET' || method === 'HEAD' ? undefined : body);
    });
  }

  return {
    origin,
    async request(method, path, opts = {}) {
      const res = await send(method, path, opts);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of res as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > maxBody) {
          res.destroy();
          throw new TeamServerError('http', 'The team server sent more than this app accepts.');
        }
        chunks.push(chunk);
      }
      return { status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) };
    },
    async stream(method, path, opts = {}) {
      const res = await send(method, path, opts);
      return { status: res.statusCode ?? 0, headers: res.headers, body: res };
    },
  };
}

/** Turn a non-2xx answer into an exact error (the server's own message when it sent one). */
export function errorFor(res: { status: number; body: Buffer }, what: string): TeamServerError {
  let message = '';
  try {
    const parsed = JSON.parse(res.body.toString('utf8')) as { error?: unknown };
    if (typeof parsed.error === 'string') message = parsed.error;
  } catch {
    // not JSON: use the status
  }
  const code: TeamServerErrorCode =
    res.status === 401
      ? 'unauthorized'
      : res.status === 403
        ? 'forbidden'
        : res.status === 404
          ? 'not-found'
          : res.status === 409
            ? 'conflict'
            : res.status === 429
              ? 'rate-limited'
              : 'http';
  return new TeamServerError(
    code,
    message || `${what} failed: the team server answered ${res.status}.`,
    res.status,
  );
}
