/**
 * The build stamp: when this renderer bundle was built and from which commit, so a stale
 * installed copy is obvious (Settings, About; the Projects screen). electron.vite.config.ts
 * injects `__STRATLAS_BUILD__` at build time.
 */
export interface BuildInfo {
  /** When the bundle was built, ISO 8601 in UTC. Empty when not stamped (unit tests). */
  time: string;
  /** Short git commit, or "dev" when git was unavailable at build time. */
  commit: string;
  /** apps/desktop package version. */
  version: string;
}

export const build: BuildInfo =
  typeof __STRATLAS_BUILD__ === 'undefined'
    ? { time: '', commit: 'dev', version: '' }
    : __STRATLAS_BUILD__;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A build time in local time: "4 Oct 2026, 16:00", or "4 Oct 16:00" with `year: false`.
 * Empty for a missing or unparseable time.
 */
export function formatBuildTime(iso: string, { year = true }: { year?: boolean } = {}): string {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  const day = `${String(d.getDate())} ${MONTHS[d.getMonth()] ?? ''}`;
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return year ? `${day} ${String(d.getFullYear())}, ${clock}` : `${day} ${clock}`;
}
