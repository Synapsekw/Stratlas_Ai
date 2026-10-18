/**
 * How one detection is drawn in the review and over the 360 view: the same colour, chip text and
 * tooltip in both (`@aio/annotate/detections` `classStyle` holds the rules).
 */
import { chipLabel, detectionColor, type Detection } from '@aio/annotate/detections';

export interface DetectionLook {
  color: string;
  /** Chip text: readable class and confidence ("No safety jacket 88%"). */
  label: string;
  /** Tooltip: the class as the project or the model names it, and the confidence. */
  title: string;
}

/** The look of `d`; `cls` is its project class when it has one. */
export function detectionLook(
  d: Detection,
  cls: { label: string; color?: string } | undefined,
): DetectionLook {
  const name = cls?.label ?? d.label ?? '?';
  const conf = d.confidence !== undefined ? ` ${String(Math.round(d.confidence * 100))}%` : '';
  return {
    color: detectionColor(cls?.color, name),
    label: chipLabel(name, d.confidence),
    title: `${name}${conf}`,
  };
}
