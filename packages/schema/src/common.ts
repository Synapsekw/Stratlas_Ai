import { z } from 'zod';

export const Id = z.string().min(1).max(128);

export const Vec2 = z.tuple([z.number(), z.number()]);
export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export const Quat = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export const Mat4 = z.array(z.number()).length(16);
export const IsoTime = z.iso.datetime({ offset: true });
export const IsoDate = z.iso.date();
export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be #rrggbb');

/** A file in the project package (content hash) or a path relative to the package root / external.json. */
export const AssetRef = z.union([
  z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ path: z.string().min(1) }).strict(),
]);

export type Vec2 = z.infer<typeof Vec2>;
export type Vec3 = z.infer<typeof Vec3>;
export type Quat = z.infer<typeof Quat>;
export type Mat4 = z.infer<typeof Mat4>;
export type AssetRef = z.infer<typeof AssetRef>;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T>(error: string): Result<T> => ({ ok: false, error });

/** Refinement: every item in `key` has a unique `id`. */
export function uniqueIds<K extends string>(key: K) {
  return (value: Record<K, readonly { id: string }[]>, ctx: z.RefinementCtx) => {
    const seen = new Set<string>();
    for (const item of value[key]) {
      if (seen.has(item.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate id "${item.id}" in ${key}`,
          path: [key],
        });
      }
      seen.add(item.id);
    }
  };
}
