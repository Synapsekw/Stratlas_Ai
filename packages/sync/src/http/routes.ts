import { SYNC_ROUTES } from '@aio/schema';

/** A route of `aio.sync/1` with its parameters filled in (`/v1/projects/t_.../heads`). */
export function routePath(
  route: keyof typeof SYNC_ROUTES,
  params: Partial<Record<'id' | 'sha256', string>> = {},
): string {
  return SYNC_ROUTES[route].replace(/:(id|sha256)/g, (_, name: 'id' | 'sha256') => {
    const v = params[name];
    if (v === undefined) throw new Error(`Missing route parameter ${name}`);
    return encodeURIComponent(v);
  });
}
