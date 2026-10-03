import type { ProjectManifest, Vec3 } from '@aio/schema';

/** Short display name of the project CRS, e.g. "UTM 39N · WGS84". */
export function crsLabel(crs: ProjectManifest['crs']): string {
  if ('wkt' in crs) return 'Project CRS';
  const { epsg } = crs;
  if (epsg > 32600 && epsg <= 32660) return `UTM ${epsg - 32600}N · WGS84`;
  if (epsg > 32700 && epsg <= 32760) return `UTM ${epsg - 32700}S · WGS84`;
  return `EPSG ${epsg}`;
}

/** Local scene frame (Y up, X east, Z south) to project CRS [E, N, H]. See data-conventions.md. */
export function localToProject(origin: Vec3, p: Vec3): Vec3 {
  return [origin[0] + p[0], origin[1] - p[2], origin[2] + p[1]];
}

function grouped(v: number): string {
  const [int = '0', frac = '0'] = v.toFixed(1).split('.');
  const neg = int.startsWith('-');
  const digits = neg ? int.slice(1) : int;
  const g = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${neg ? '-' : ''}${g}.${frac}`;
}

/** "E 245 884.9  N 3 179 597.1" */
export function formatEastNorth(e: number, n: number): string {
  return `E ${grouped(e)}  N ${grouped(n)}`;
}

/** "X 1.23  Y -0.50  Z 12.00" in the local frame. */
export function formatLocal(p: Vec3): string {
  return `X ${p[0].toFixed(2)}  Y ${p[1].toFixed(2)}  Z ${p[2].toFixed(2)}`;
}

/** Heading of a horizontal direction, degrees clockwise from north (-Z), 0 to 360. */
export function headingDeg(dx: number, dz: number): number {
  const deg = (Math.atan2(dx, -dz) * 180) / Math.PI;
  return (deg + 360) % 360;
}
