/**
 * The AI's waiting suggestions as shapes on Inspect's photo viewer: dashed, in the AI colour, in
 * the pixels of the loaded photo. A draft keeps its geometry in its own grid (`size`: [1, 1] for a
 * normalized pass, or the pixels of the image the model saw), so it is scaled to the photo to be
 * drawn, and a Fix edit made on the photo is scaled back to the draft's grid before it is saved.
 */
import type { ShapeItem } from '@aio/annotate';
import { scaleGeom, type Detection } from '@aio/annotate/detections';
import type { DetectionGeom, ImageGeom } from '@aio/schema';

/** The colour of an AI suggestion: the app's warning orange (no token of its own). */
export const AI_COLOR = 'var(--warn)';

/** The key a draft's shape carries on the viewer (`PhotoViewer` passes it back on a click). */
export const draftKey = (id: string): string => `det:${id}`;

/** The draft id of a shape key, or null for a key that is not a draft's. */
export function draftIdOf(key: string): string | null {
  return key.startsWith('det:') ? key.slice(4) : null;
}

/** A draft's geometry in the photo's pixels. */
export function draftOnPhoto(
  d: Pick<Detection, 'geom' | 'size'>,
  natural: { width: number; height: number },
): DetectionGeom {
  const [w, h] = d.size;
  if (w === natural.width && h === natural.height) return d.geom;
  return scaleGeom(d.geom, natural.width / w, natural.height / h);
}

/** A shape edited on the photo, in the draft's own grid; null for a mask (a draft has none). */
export function photoToDraft(
  geom: ImageGeom,
  d: Pick<Detection, 'size'>,
  natural: { width: number; height: number },
): DetectionGeom | null {
  if (geom.type === 'mask') return null;
  const [w, h] = d.size;
  if (w === natural.width && h === natural.height) return geom;
  return scaleGeom(geom, w / natural.width, h / natural.height);
}

/** Waiting drafts of the photo as dashed shapes in photo pixels; the current one selected and, in Fix, editable. */
export function suggestionShapes(
  drafts: readonly Detection[],
  natural: { width: number; height: number },
  o: { currentId: string | null; fixing: boolean; classLabel: (id: string) => string },
): ShapeItem[] {
  return drafts
    .filter((d) => d.status === 'draft')
    .map((d) => {
      const current = d.id === o.currentId;
      const known = o.classLabel(d.classId);
      const name = known !== '' ? known : (d.label ?? '');
      const pct =
        d.confidence === undefined || d.unscored === true
          ? ''
          : ` ${String(Math.round(d.confidence * 100))}%`;
      return {
        key: draftKey(d.id),
        geom: draftOnPhoto(d, natural),
        color: AI_COLOR,
        dashed: true,
        selected: current,
        editable: current && o.fixing,
        title: `${name}${pct}`.trim(),
      };
    });
}
