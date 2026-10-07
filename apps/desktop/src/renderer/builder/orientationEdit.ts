import {
  emptyOrientation,
  type DirectionKey,
  type OrientationFile,
  type PhotoCorrection,
} from '@aio/schema';

/* Edits of an orientation.json (aio.orientation/1) as new objects; other entries keep theirs. */

/** The file with a clip's keyframes set (`null` or none: removed). Other entries kept as they are. */
export function withClipKeys(
  file: OrientationFile | null,
  layerId: string,
  keys: readonly DirectionKey[] | null,
): OrientationFile {
  const base = file ?? emptyOrientation();
  const clips = { ...base.clips };
  if (keys?.length) clips[layerId] = { keys: [...keys] };
  else Reflect.deleteProperty(clips, layerId);
  return { ...base, clips };
}

/** The file with photo corrections of one set changed (`null`: removed). */
export function withPhotoFixes(
  file: OrientationFile | null,
  layerId: string,
  fixes: Readonly<Record<string, PhotoCorrection | null>>,
): OrientationFile {
  const base = file ?? emptyOrientation();
  const set: Record<string, PhotoCorrection> = { ...(base.photos[layerId] ?? {}) };
  for (const [id, c] of Object.entries(fixes)) {
    if (c) set[id] = c;
    else Reflect.deleteProperty(set, id);
  }
  const photos = { ...base.photos };
  if (Object.keys(set).length) photos[layerId] = set;
  else Reflect.deleteProperty(photos, layerId);
  return { ...base, photos };
}
