import type { AssetRef, Layer } from '@aio/schema';
import type { IconName } from '@aio/ui';
import { MediaThumb } from '../../thumbs/Thumb';
import type { SpotItem, SpotKind, SpotMatch } from './spotTypes';

const ICON: Record<SpotKind, IconName> = {
  photo: 'photo',
  drone: 'drone',
  pano: 'pano',
  walk: 'pano',
  video: 'video',
};

/** The picture a slot shows: the photo or panorama itself, a clip's or walk's poster. */
export function itemAsset(layers: readonly Layer[], item: SpotItem): AssetRef | undefined {
  const l = layers.find((x) => x.id === item.layer);
  if (item.kind === 'photo' && l?.kind === 'photos')
    return l.items.find((p) => p.id === item.photo)?.src;
  if (item.kind === 'pano' && l?.kind === 'panoramas')
    return l.items.find((p) => p.id === item.pano)?.src;
  if (
    (item.kind === 'video' && l?.kind === 'video') ||
    (item.kind === 'walk' && l?.kind === 'walk')
  )
    return l.poster;
  return undefined;
}

export function SpotThumb(p: { projectId: string; layers: readonly Layer[]; match: SpotMatch }) {
  return (
    <MediaThumb
      projectId={p.projectId}
      asset={itemAsset(p.layers, p.match.item)}
      icon={ICON[p.match.kind]}
    />
  );
}
