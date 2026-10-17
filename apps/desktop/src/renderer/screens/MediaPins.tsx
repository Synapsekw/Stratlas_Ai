import type { AssetRef, PanoRef, PhotoRef } from '@aio/schema';
import { actionsFor, Button, Chip, ContextMenu, useT, type MenuTarget } from '@aio/ui';
import { assetUrl } from '@aio/workspace';
import { useCallback, useEffect, useState, type MouseEvent, type ReactElement } from 'react';
import { mediaItem, type MediaKey } from '../pins/pinModel';
import { mediaName } from '../pins/placePin';
import { usePinActionCtx } from '../shell/actions/pinActions';
import { photoSize } from '../thumbs/photoSize';
import { isNear2to1 } from './mediaModel';
import './MediaPins.css';

/*
 * Pinned media on the Media tiles (pinned media design): "Not placed" on a photo or 360 with no
 * place on the site, "Not lined up yet" on a pinned 360 with no heading, "Looks like a 360" with
 * Treat as 360 on a 2:1 photo, and the pin actions on a right-click of a tile.
 */

/** The menu target of a tile: a photo keeps `photos`, a 360 is `media`. */
function targetOf(k: MediaKey): MenuTarget {
  return k.kind === 'photo'
    ? { kind: 'photos', picks: [{ layerId: k.layerId, photoId: k.itemId }] }
    : { kind: 'media', picks: [k] };
}

/** Whether a photo's image is near 2:1: from its lens when known, else from the file's header. */
function useLooks360(projectId: string, photo: PhotoRef): boolean {
  const aspect = photo.lens?.aspect;
  const src = photo.src as AssetRef | undefined;
  const [read, setRead] = useState<{ src: AssetRef; wide: boolean } | null>(null);
  useEffect(() => {
    if (aspect !== undefined || !src) return;
    let url: string;
    try {
      url = assetUrl(projectId, src);
    } catch {
      return;
    }
    let live = true;
    void photoSize(url).then((wh) => {
      if (live) setRead({ src, wide: wh !== null && isNear2to1(wh[0], wh[1]) });
    });
    return () => {
      live = false;
    };
  }, [projectId, src, aspect]);
  if (aspect !== undefined) return isNear2to1(aspect, 1);
  return read !== null && read.src === src && read.wide;
}

function NotPlaced({ itemId }: { itemId: string }) {
  const t = useT();
  return (
    <span className="m-pin-chip" data-testid="media-not-placed" data-item={itemId}>
      <Chip kind="status" tone="warn">
        {t('pin.notPlaced')}
      </Chip>
    </span>
  );
}

/** The chips under a photo tile, or nothing. */
export function PhotoPinChips({
  projectId,
  layerId,
  photo,
}: {
  projectId: string;
  layerId: string;
  photo: PhotoRef;
}): ReactElement | null {
  const t = useT();
  const looks360 = useLooks360(projectId, photo);
  const ctxOf = usePinActionCtx();
  const placed = photo.pos !== undefined;
  if (placed && !looks360) return null;
  const key: MediaKey = { kind: 'photo', layerId, itemId: photo.id };
  const as360 = looks360
    ? (() => {
        const ctx = ctxOf(key);
        return ctx ? actionsFor(targetOf(key), ctx).find((i) => i.id === 'media.as360') : undefined;
      })()
    : undefined;
  return (
    <div className="m-pin-chips">
      {!placed && <NotPlaced itemId={photo.id} />}
      {looks360 && (
        <>
          <Chip kind="tag" tone="acc">
            {t('pin.looks360')}
          </Chip>
          {as360 && (
            <Button
              size="sm"
              variant="quiet"
              icon="pano"
              data-testid="media-treat-360"
              data-item={photo.id}
              {...(as360.disabled ? { disabledReason: as360.disabled } : {})}
              onClick={() => {
                as360.run();
              }}
            >
              {t('pin.as360')}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

/** The chips inside a 360 tile's caption, or nothing. */
export function PanoPinChips({ pano }: { pano: PanoRef }): ReactElement | null {
  const t = useT();
  if (pano.pos === undefined) return <NotPlaced itemId={pano.id} />;
  if (pano.pin && pano.pin.headingDeg === undefined)
    return (
      <span className="m-pin-chip" data-testid="media-not-lined-up" data-item={pano.id}>
        <Chip kind="status" tone="off">
          {t('pin.notLinedUp')}
        </Chip>
      </span>
    );
  return null;
}

/** The right-click menu of the tiles: `open` on a tile's contextmenu, `menu` drawn once. */
export function useTileMenu(): {
  open: (e: MouseEvent, k: MediaKey) => void;
  menu: ReactElement | null;
} {
  const ctxOf = usePinActionCtx();
  const [at, setAt] = useState<{ x: number; y: number; k: MediaKey } | null>(null);
  const open = useCallback((e: MouseEvent, k: MediaKey) => {
    e.preventDefault();
    setAt({ x: e.clientX, y: e.clientY, k });
  }, []);
  const close = useCallback(() => {
    setAt(null);
  }, []);
  const ctx = at ? ctxOf(at.k) : null;
  const item = at && ctx ? mediaItem(ctx.manifest, at.k) : null;
  const items = at && ctx ? actionsFor(targetOf(at.k), ctx) : [];
  const menu =
    at && item && items.length > 0 ? (
      <ContextMenu items={items} x={at.x} y={at.y} label={mediaName(item)} onClose={close} />
    ) : null;
  return { open, menu };
}
