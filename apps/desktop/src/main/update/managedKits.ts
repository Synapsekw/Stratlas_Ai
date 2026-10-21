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
async function read(root: string, strict = false): Promise<z.infer<typeof Selections>> {
  try {
    const raw = await readJson(file(root));
    if (raw === undefined) return { schema: 'quadrion.kit-selection/1', apps: {} };
    return Selections.parse(raw);
  } catch (error) {
    if (strict) throw error;
    return { schema: 'quadrion.kit-selection/1', apps: {} };
  }
}
export async function readManagedSelection(
  root: string,
  version: string,
  strict = false,
): Promise<ManagedKit | null> {
  const kit = (await read(root, strict)).apps[version]?.current;
  if (strict && kit && packRangeRefusal(kit.appRange, version))
    throw new Error('The selected processing kit is incompatible.');
  return kit && !packRangeRefusal(kit.appRange, version) ? kit : null;
}
export async function managedKitRecovery(root: string, version: string) {
  return (await read(root)).apps[version]?.previous !== undefined;
}
/** Repair is destructive: unreadable selection state protects every digest, across app versions. */
export async function managedKitProtected(root: string, sha256: string): Promise<boolean> {
  try {
    const raw = await readJson(file(root));
    if (raw === undefined) return false;
    const selections = Selections.parse(raw);
    return Object.values(selections.apps).some(
      (entry) => entry.current.sha256 === sha256 || entry.previous?.sha256 === sha256,
    );
  } catch {
    return true;
  }
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
