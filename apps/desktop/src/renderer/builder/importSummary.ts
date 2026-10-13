import type { ImportItem, Layer } from '@aio/schema';

/*
 * What the import panel says about each file: where it went (the group of the Datasets list it
 * was added to), or why it was skipped or failed. Founder, 13 Oct 2026: every import says where
 * each file went.
 */

export const QUEUED_NOTE = 'An import is running. These files are imported when it finishes.';

const GROUP: Record<Layer['kind'], string> = {
  mesh: 'Models',
  legacy: 'Models',
  pointcloud: 'Point clouds',
  basemap: 'Maps and rasters',
  raster: 'Maps and rasters',
  vector: 'Maps and rasters',
  video: 'Video',
  walk: '360 walks',
  photos: 'Photos',
  panoramas: 'Panoramas',
};

export function importDestination(item: ImportItem, layers: readonly Layer[]): string {
  switch (item.status) {
    case 'skipped':
      return `Skipped: ${item.message ?? 'not a file this app reads'}`;
    case 'error':
      return `Failed: ${item.message ?? 'the import stopped with an error'}`;
    case 'queued':
      return 'Processing; it appears when it is done';
    case 'needs-pipeline':
      return 'Needs the processing tools';
    case 'imported': {
      const layer = layers.find((l) => l.id === item.layerId);
      if (layer?.kind === 'walk') return 'Added as a walk under 360 walks';
      if (layer?.kind === 'raster' && layer.role === 'plan') return 'Added to Datasets, Drawings';
      if (layer) return `Added to Datasets, ${GROUP[layer.kind]}`;
      if (item.kind === 'photo') return 'Added to Datasets, Photos';
      return 'Imported';
    }
  }
}

export function importHeadline(items: readonly ImportItem[]): string {
  const n = (s: ImportItem['status']) => items.filter((i) => i.status === s).length;
  const imported = n('imported') + n('queued');
  if (imported > 0 || items.length === 0)
    return `Imported ${String(imported)} of ${String(items.length)} files`;
  const failed = n('error');
  const skipped = items.length - failed;
  const plural = (k: number) => (k === 1 ? 'file' : 'files');
  if (failed === 0) return `Nothing imported: ${String(skipped)} ${plural(skipped)} skipped`;
  return skipped === 0
    ? `Nothing imported: ${String(failed)} ${plural(failed)} failed`
    : `Nothing imported: ${String(failed)} ${plural(failed)} failed, ${String(skipped)} skipped`;
}
