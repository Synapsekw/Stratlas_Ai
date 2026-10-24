/**
 * The review queue's zoomed crop of one suggestion: its shape in the full-size photo's pixels
 * (`inPixels`, so a normalized draft or one in another pixel grid frames the same spot), centred
 * in the crop with about three times its size of the photo around it. A photo is the CSS
 * background of the real image; a video or walk frame is a grabbed frame (`frameImage`).
 */
import { geomBounds, inPixels, type Detection } from '@aio/annotate/detections';
import type { Layer } from '@aio/schema';
import { assetUrl } from '@aio/workspace';
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react';
import { frameLayerSrc } from '../detections/frameMedia';
import { frameImage } from '../detections/prepare';

/** The crop shows the shape's bounds this many times over. */
export const CROP_PAD = 3;
/** The smallest stretch of the photo a crop shows (photo px), so a point or a tiny box is not a blur. */
const CROP_MIN_PX = 48;

/** Photo px to crop px: `crop = photo * scale + offset`, the bounds' centre at the crop's centre. */
export function cropView(
  b: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
): { scale: number; x: number; y: number } {
  const aspect = width / height;
  const regionW = Math.max(b.w * CROP_PAD, b.h * CROP_PAD * aspect, CROP_MIN_PX);
  const scale = width / regionW;
  return {
    scale,
    x: width / 2 - (b.x + b.w / 2) * scale,
    y: height / 2 - (b.y + b.h / 2) * scale,
  };
}

function photoUrl(projectId: string, layers: readonly Layer[], d: Detection): string | null {
  if (d.source.kind !== 'photo') return null;
  const { layer: layerId, photo } = d.source;
  const layer = layers.find((l) => l.id === layerId);
  const item = layer?.kind === 'photos' ? layer.items.find((p) => p.id === photo) : undefined;
  try {
    return item ? assetUrl(projectId, item.src) : null;
  } catch {
    return null;
  }
}

function videoUrl(projectId: string, layers: readonly Layer[], d: Detection): string | null {
  if (d.source.kind !== 'frame') return null;
  const src = frameLayerSrc(layers, d.source.layer);
  try {
    return src ? assetUrl(projectId, src) : null;
  } catch {
    return null;
  }
}

const isNormalized = (d: Detection) => d.size[0] <= 1 && d.size[1] <= 1;

export function Crop(p: {
  projectId: string;
  detection: Detection;
  /** The photo's (or frame's) pixel size; null while it is not known. */
  imageSize: readonly [number, number] | null;
  width: number;
  height: number;
  layers: readonly Layer[];
}): ReactElement {
  const d = p.detection;
  const video = videoUrl(p.projectId, p.layers, d);
  const frameT = d.source.kind === 'frame' ? d.source.t : null;
  const frameKey = video !== null && frameT !== null ? `${video}#${String(frameT)}` : null;
  const [frame, setFrame] = useState<{
    key: string;
    url: string;
    size: [number, number];
  } | null>(null);

  useEffect(() => {
    if (!frameKey || !video || frameT === null) return;
    let live = true;
    frameImage(video, frameT).then(
      (f) => {
        if (live) setFrame({ key: frameKey, url: f.dataUrl, size: [f.width, f.height] });
      },
      () => {
        // no frame: the crop stays empty, the viewer still shows the clip
      },
    );
    return () => {
      live = false;
    };
  }, [frameKey, video, frameT]);

  const shownFrame = frame?.key === frameKey ? frame : null;
  const image = video ? (shownFrame?.url ?? null) : photoUrl(p.projectId, p.layers, d);
  // a frame grab knows its video's size; a photo's comes from the caller
  const size = p.imageSize ?? shownFrame?.size ?? (isNormalized(d) ? null : d.size);
  const bounds = size ? geomBounds(inPixels(d, size)) : null;
  const view = size && bounds ? cropView(bounds, p.width, p.height) : null;

  const style: CSSProperties = { width: p.width, height: p.height };
  if (image && size && view) {
    style.backgroundImage = `url("${image}")`;
    style.backgroundSize = `${String(size[0] * view.scale)}px ${String(size[1] * view.scale)}px`;
    style.backgroundPosition = `${String(view.x)}px ${String(view.y)}px`;
  }

  return (
    <div className="queue-crop" data-testid="queue-crop" style={style}>
      {bounds && view && (
        <div
          className="queue-crop-box"
          data-testid="queue-crop-box"
          style={{
            left: `${String(bounds.x * view.scale + view.x)}px`,
            top: `${String(bounds.y * view.scale + view.y)}px`,
            width: `${String(bounds.w * view.scale)}px`,
            height: `${String(bounds.h * view.scale)}px`,
          }}
        />
      )}
    </div>
  );
}
