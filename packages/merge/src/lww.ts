/** A value written by an op at a clock reading. */
export interface Stamped<T> {
  value: T;
  hlc: string;
  op: string;
}

/**
 * The last writer of two: the later clock reading; on an equal reading (never between devices,
 * the device id is part of it) the larger op id. Commutative and idempotent.
 */
export function lww<T>(a: Stamped<T>, b: Stamped<T>): Stamped<T> {
  if (a.hlc !== b.hlc) return a.hlc > b.hlc ? a : b;
  return a.op >= b.op ? a : b;
}
