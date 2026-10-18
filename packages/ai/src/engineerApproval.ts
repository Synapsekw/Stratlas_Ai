import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { EngineerCall } from './engineer';
import type { ModelRoute } from './routes';

/** Exact evidence pool, settings and effective source frame; generated comparisons may evolve. */
export function approvalScopeKey(c: EngineerCall, route: ModelRoute, sourceStamp = ''): string {
  const images = c.images
    .filter((i) => i.kind !== 'generated')
    .map((i) => ({
      id: i.id,
      kind: i.kind,
      view: i.view,
      hash: createHash('sha256').update(i.dataUrl).digest('hex'),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256')
    .update(
      JSON.stringify({
        route,
        setup: c.setup,
        summary: c.summary,
        observations: c.observations ?? [],
        images,
        sourceStamp,
      }),
    )
    .digest('hex');
}
export const RunApproval = z
  .object({
    token: z.string(),
    key: z.string(),
    photos: z.boolean(),
    scans: z.boolean(),
    expires: z.number(),
    budgetUsd: z.number(),
    costConfirmed: z.boolean(),
  })
  .strict();
export type RunApproval = z.infer<typeof RunApproval>;
export async function readApproval(dir: string): Promise<RunApproval | null> {
  try {
    return RunApproval.parse(JSON.parse(await readFile(join(dir, 'ai', 'approval.json'), 'utf8')));
  } catch {
    return null;
  }
}
export async function writeApproval(dir: string, approval: RunApproval): Promise<void> {
  await mkdir(join(dir, 'ai'), { recursive: true });
  const path = join(dir, 'ai', 'approval.json');
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(approval), 'utf8');
  await rename(tmp, path);
}
