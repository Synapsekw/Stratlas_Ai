/**
 * The pile last picked in the Volumes view's list. The view shows it in its own detail card, so
 * the sidebar's "a picked measurement brings the Measure tab" (`followMeasureTool`) leaves the
 * view in front for that pick; a pick anywhere else (the tree, the stage) still brings Measure.
 */
let picked: string | null = null;

/** Say the next focus on `id` comes from the Volumes view's list. */
export function pickInVolumesView(id: string): void {
  picked = id;
}

/** Whether the focus on `id` was the Volumes view's pick; the note is used up either way. */
export function takeVolumesPick(id: string | null): boolean {
  const hit = id !== null && picked === id;
  picked = null;
  return hit;
}
