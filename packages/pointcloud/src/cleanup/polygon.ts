/** Point in polygon by the even-odd rule, the same loop as python `in_polygon` (evaluate.py). */
export type Ring = Float64Array;

export function ringOf(poly: readonly (readonly [number, number])[]): Ring {
  const ring = new Float64Array(poly.length * 2);
  poly.forEach(([x, y], i) => {
    ring[2 * i] = x;
    ring[2 * i + 1] = y;
  });
  return ring;
}

export function pointInPolygon(ring: Ring, x: number, y: number): boolean {
  const n = ring.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i] ?? 0;
    const yi = ring[2 * i + 1] ?? 0;
    const xj = ring[2 * j] ?? 0;
    const yj = ring[2 * j + 1] ?? 0;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
