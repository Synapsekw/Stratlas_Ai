/**
 * The dataset's thermal photos in a row under the bench (only the thermal ones: their visual twins
 * stay out). A click shows a photo; Ctrl or Cmd and a click marks it too, for "apply to selected
 * photos" in the settings editor. Room is kept for the hot-spot dot (M3).
 */
import type { AssetRef } from '@aio/schema';
import { useT } from '@aio/ui';
import { MediaThumb } from '../thumbs/Thumb';

export interface StripPhoto {
  id: string;
  src: AssetRef;
}

/** The file name of a photo, for its accessible name. */
const nameOf = (p: StripPhoto): string =>
  'path' in p.src ? (p.src.path.split(/[\\/]/).pop() ?? p.id) : p.id;

export function Filmstrip({
  projectId,
  photos,
  current,
  marked,
  onPick,
}: {
  projectId: string;
  photos: readonly StripPhoto[];
  current: string | null;
  marked: ReadonlySet<string>;
  /** `add`: Ctrl or Cmd was held, mark or unmark it. */
  onPick: (photoId: string, add: boolean) => void;
}) {
  const t = useT();
  return (
    <div
      className="th-strip"
      role="group"
      aria-label={t('thermal.filmstrip')}
      data-testid="thermal-filmstrip"
      data-thumb-root
    >
      {photos.map((p) => (
        <button
          key={p.id}
          type="button"
          className={`th-thumb${marked.has(p.id) ? ' marked' : ''}`}
          aria-label={nameOf(p)}
          aria-pressed={p.id === current}
          data-testid={`thermal-thumb-${p.id}`}
          onClick={(e) => {
            onPick(p.id, e.ctrlKey || e.metaKey);
          }}
        >
          <MediaThumb projectId={projectId} asset={p.src} icon="photo" />
        </button>
      ))}
    </div>
  );
}
