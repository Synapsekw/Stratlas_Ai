/** A file a 360 camera wrote itself, stitched in the app and so played unstabilised. */
const RAW_CAMERA = /\.(insv|lrv)$/i;

/** The import brought in at least one raw 360 camera file. */
export function rawCameraImported(items: readonly { file: string; status: string }[]): boolean {
  return items.some((i) => i.status === 'imported' && RAW_CAMERA.test(i.file));
}
