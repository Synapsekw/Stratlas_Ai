/** What to do when a page asks for a new window (window.open, `<a target="_blank">`). */
export type PopupAction = { kind: 'external'; url: string } | { kind: 'deny' };

/**
 * The hosts the app links to, and the only ones it hands to the system browser: the product
 * site, the ODM licence and site (Settings, Processing engine), the map providers' attribution and
 * feedback pages, the AI providers' consoles and Microsoft's runtime download. A link anywhere else
 * (a page or a project file asking to open a URL) is refused.
 */
export const EXTERNAL_HOSTS: readonly string[] = [
  'quadrion.ai',
  'www.quadrion.ai',
  'synapse-solutions.ai',
  'www.synapse-solutions.ai',
  'github.com',
  'opendronemap.org',
  'www.opendronemap.org',
  'apps.mapbox.com',
  'www.mapbox.com',
  'cloudless.eox.at',
  'eox.at',
  'www.openstreetmap.org',
  'openstreetmap.org',
  'protomaps.com',
  'docs.protomaps.com',
  'console.anthropic.com',
  'platform.openai.com',
  'aistudio.google.com',
  'aka.ms',
];

/**
 * Whether `raw` may open in the system browser: https on the default port, no user name or
 * password, a host from `EXTERNAL_HOSTS` or one of `extraHosts` (the configured privacy policy).
 */
export function externalLinkAllowed(raw: string, extraHosts: readonly string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return EXTERNAL_HOSTS.includes(host) || extraHosts.includes(host);
}

/** The host of an https link, for `extraHosts` (null when it is not one). */
export function linkHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Decide a popup request. Links to the app's own link hosts go to the system browser. Everything
 * else is refused, project files included: nothing in the app opens a window of its own.
 */
export function popupAction(raw: string, extraHosts: readonly string[] = []): PopupAction {
  return externalLinkAllowed(raw, extraHosts) ? { kind: 'external', url: raw } : { kind: 'deny' };
}
