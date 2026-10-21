import { WebsiteVersion, WebsiteAppRange, packRangeRefusal } from '@aio/schema';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readJson, writeJsonAtomic } from '../fsutil';
const Kit = z
  .object({
    version: WebsiteVersion,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    appRange: WebsiteAppRange,
  })
  .strict();
export type ManagedKit = z.infer<typeof Kit>;
const Selections = z
  .object({
    schema: z.literal('quadrion.kit-selection/1'),
    apps: z.record(
      WebsiteVersion,
      z.object({ current: Kit, previous: Kit.nullable().optional() }).strict(),
    ),
  })
  .strict();
const base = (root: string) => join(root, 'runtime', '.website-kits');
const file = (root: string) => join(base(root), 'selection-v1.json');
export const managedKitDataRoot = (root: string, kit: ManagedKit) =>
  join(base(root), Kit.parse(kit).sha256);
export const managedKitDirectory = (root: string, kit: ManagedKit) =>
  join(managedKitDataRoot(root, kit), 'runtime', 'pipeline-pack-' + kit.version);
async function read(root: string): Promise<z.infer<typeof Selections>> {
  try {
    return Selections.parse(await readJson(file(root)));
  } catch {
    return { schema: 'quadrion.kit-selection/1', apps: {} };
  }
}
export async function readManagedSelection(
  root: string,
  version: string,
): Promise<ManagedKit | null> {
  const kit = (await read(root)).apps[version]?.current;
  return kit && !packRangeRefusal(kit.appRange, version) ? kit : null;
}
export async function managedKitRecovery(root: string, version: string) {
  return (await read(root)).apps[version]?.previous !== undefined;
}
export async function selectManagedKit(
  root: string,
  version: string,
  kit: ManagedKit,
  recoverable = true,
) {
  WebsiteVersion.parse(version);
  Kit.parse(kit);
  if (packRangeRefusal(kit.appRange, version))
    throw new Error('The processing kit is incompatible with the target app.');
  const s = await read(root);
  s.apps[version] = {
    current: kit,
    ...(recoverable ? { previous: s.apps[version]?.current ?? null } : {}),
  };
  await mkdir(base(root), { recursive: true });
  await writeJsonAtomic(file(root), s);
}
export async function clearManagedSelection(root: string, version: string) {
  const s = await read(root);
  Reflect.deleteProperty(s.apps, version);
  await mkdir(base(root), { recursive: true });
  await writeJsonAtomic(file(root), s);
}
export async function rollbackManagedKit(root: string, version: string) {
  const s = await read(root);
  const previous = s.apps[version]?.previous;
  if (previous === undefined) throw new Error('There is no previous processing kit selection.');
  if (previous) s.apps[version] = { current: previous };
  else Reflect.deleteProperty(s.apps, version);
  await writeJsonAtomic(file(root), s);
}

export const managedKitSnapshot = read;
export async function restoreManagedKitSnapshot(root: string, snapshot: unknown) {
  await writeJsonAtomic(file(root), Selections.parse(snapshot));
}
