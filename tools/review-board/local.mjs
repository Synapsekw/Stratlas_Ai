// Only this machine's browser may talk to the review board: the Host header must name the board on
// 127.0.0.1 or localhost (a DNS rebinding page names its own host), and a request that changes
// anything must come from the board's own page (its Origin, when the browser sends one).

/** The hosts the board answers to on `port`. */
export const localHosts = (port) => [`127.0.0.1:${port}`, `localhost:${port}`];

/**
 * Whether a request may be served: `null` when it may, else the reason it is refused.
 * @param {{ method?: string, headers: Record<string, string | string[] | undefined> }} req
 * @param {number} port
 */
export function refuseNonLocal(req, port) {
  const hosts = localHosts(port);
  const host = String(req.headers.host ?? '').toLowerCase();
  if (!hosts.includes(host)) return 'Host is not this machine';
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return null;
  const origin = req.headers.origin;
  if (origin === undefined) {
    // no Origin: only a same-origin fetch from the board's page (Sec-Fetch-Site), or a tool
    const site = req.headers['sec-fetch-site'];
    return site === undefined || site === 'same-origin' || site === 'none'
      ? null
      : 'Request from another site';
  }
  return hosts.map((h) => `http://${h}`).includes(String(origin).toLowerCase())
    ? null
    : 'Request from another site';
}
