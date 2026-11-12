/**
 * The add-on catalogue read in the app, over Electron's `net.request` with `redirect: 'manual'`.
 *
 * Electron's `net.fetch` with `redirect: 'manual'` never answers a 3xx: it rejects ("Redirect was
 * cancelled"), so `fetchHopByHop` alone would refuse every redirecting address. `net.request`
 * instead raises `redirect` before it follows one; this adapter puts each hop through the same
 * rule (`checkHop`: an allowed address, never down from https, at most `MAX_HOPS`) and then calls
 * `followRedirect()` or aborts. It answers only the final response, as a `Response`, so
 * `fetchHopByHop` passes it straight through. Everything but the Electron objects is here and
 * tested with a fake request (`netCatalogueFetch.test.ts`).
 */
import type { FetchLike } from '../update/download';
import { checkHop } from './catalogue';

/** The part of Electron's `IncomingMessage` this uses. */
export interface IncomingLike {
  statusCode: number;
  headers: Record<string, string | string[]>;
  on(event: 'data', cb: (chunk: Buffer) => void): unknown;
  on(event: 'end', cb: () => void): unknown;
  on(event: 'error', cb: (e: Error) => void): unknown;
}

/** The part of Electron's `ClientRequest` this uses. */
export interface ClientRequestLike {
  on(event: 'response', cb: (res: IncomingLike) => void): unknown;
  on(
    event: 'redirect',
    cb: (statusCode: number, method: string, redirectUrl: string) => void,
  ): unknown;
  on(event: 'error', cb: (e: Error) => void): unknown;
  followRedirect(): void;
  abort(): void;
  end(): void;
}

export type RequestFactory = (o: { url: string; redirect: 'manual' }) => ClientRequestLike;

/** A `FetchLike` for the catalogue (GET only) that checks every redirect before following it. */
export function netCatalogueFetch(request: RequestFactory): FetchLike {
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      let at = url;
      let hop = 0;
      let settled = false;
      const req = request({ url, redirect: 'manual' });
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        try {
          req.abort();
        } catch {
          // already finished
        }
        reject(e);
      };
      const signal = init?.signal;
      if (signal?.aborted) {
        fail(new Error('The request was cancelled.'));
        return;
      }
      signal?.addEventListener(
        'abort',
        () => {
          fail(new Error('The request was cancelled.'));
        },
        {
          once: true,
        },
      );
      req.on('redirect', (_status, _method, redirectUrl) => {
        const next = checkHop(at, redirectUrl, hop);
        if (!next.ok) {
          fail(new Error(next.error));
          return;
        }
        hop++;
        at = next.url;
        req.followRedirect();
      });
      req.on('error', (e) => {
        fail(e);
      });
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', (e) => {
          fail(e);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers))
            for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
          // a status a Response cannot carry (1xx, 0) is a failed read
          const status = res.statusCode >= 200 && res.statusCode <= 599 ? res.statusCode : 502;
          const body = status === 204 || status === 304 ? null : Buffer.concat(chunks);
          resolve(new Response(body, { status, headers }));
        });
      });
      req.end();
    });
}
