import type { AssetRef, PanoRef, PhotoRef } from '@aio/schema';
import { actionsFor, Button, Chip, ContextMenu, useT, type MenuTarget } from '@aio/ui';
import { assetUrl, workspace } from '@aio/workspace';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { mediaItem, type MediaKey } from '../pins/pinModel';
import { mediaName } from '../pins/placePin';
import { usePinActionCtx } from '../shell/actions/pinActions';
import { photoSize } from '../thumbs/photoSize';
import { isNear2to1 } from './mediaModel';
import { mediaPicks, menuPicks, tileTarget } from './mediaSelect';
import './MediaPins.css';

/*
 * Pinned media on the Media tiles (pinned media design): "Not placed" on a photo or 360 with no
 * place on the site, "Not lined up yet" on a pinned 360 with no heading, "Looks like a 360" with
 * Treat as 360 on a 2:1 photo, "Edited" on a photo moved with Edit position, and the pin and
 * photo actions on a right-click of a tile (of every picked photo when it is among the picks).
 */

/** The menu target of one tile on its own (its chips, Place on site from a click). */
const targetOf = (k: MediaKey): MenuTarget => tileTarget(k);

/**
 * The menu target of a right-click on a tile: every picked photo when the tile is among the
 * picks, else that tile alone, and the picks are reset to it.
 */
function menuTargetOf(k: MediaKey): MenuTarget {
  if (k.kind !== 'photo') return targetOf(k);
  const projectId = workspace.getState().project?.id;
  const s = mediaPicks.getState();
  const picks = projectId !== undefined && s.projectId === projectId ? s.picks : [];
  const hit = { layerId: k.layerId, photoId: k.itemId };
  const m = menuPicks(picks, hit);
  if (m.reset && projectId !== undefined) s.reset(projectId, m.picks);
  return { kind: 'photos', picks: m.picks };
}

/** One observer per scroll list: a tile's header is read once it comes into view. */
const observers = new WeakMap<Element | Document, IntersectionObserver>();
const onSeen = new WeakMap<Element, () => void>();

function watchSeen(el: Element, cb: () => void): () => void {
  const root = el.closest('[data-thumb-root]') ?? document;
  let io = observers.get(root);
  if (!io) {
    const made = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          made.unobserve(e.target);
          onSeen.get(e.target)?.();
          onSeen.delete(e.target);
        }
      },
      { root: root === document ? null : root },
    );
    observers.set(root, made);
    io = made;
  }
  onSeen.set(el, cb);
  io.observe(el);
  const observer = io;
  return () => {
    observer.unobserve(el);
    onSeen.delete(el);
  };
}

/**
 * Whether a photo's image is near 2:1: from its lens when known, else from the file's header,
 * read only once the tile has been in view (`seen`).
 */
function useLooks360(projectId: string, photo: PhotoRef, seen: boolean): boolean {
  const aspect = photo.lens?.aspect;
  const src = photo.src;
  const [read, setRead] = useState<{ src: AssetRef; wide: boolean } | null>(null);
  useEffect(() => {
    if (aspect !== undefined || !seen) return;
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
  }, [projectId, src, aspect, seen]);
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

/**
 * A photo tile of Media: the tile (`children`) with its chips under it, and the pin actions on a
 * right-click.
 */
export function PhotoTile({
  projectId,
  layerId,
  photo,
  edited = false,
  onMenu,
  children,
}: {
  projectId: string;
  layerId: string;
  photo: PhotoRef;
  /** Moved with Edit position (`isPhotoEdited`): the tile shows "Edited". */
  edited?: boolean;
  onMenu: (e: MouseEvent, k: MediaKey) => void;
  children: ReactNode;
}): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  // only a photo whose size is unknown (no lens) is watched for its header read
  const watch = photo.lens === undefined && !seen;
  useEffect(() => {
    const el = box.current;
    if (!el || !watch) return;
    return watchSeen(el, () => {
      setSeen(true);
    });
  }, [watch]);
  return (
    <div
      ref={box}
      className="m-tile"
      onContextMenu={(e) => {
        onMenu(e, { kind: 'photo', layerId, itemId: photo.id });
      }}
    >
      {children}
      <PhotoPinChips
        projectId={projectId}
        layerId={layerId}
        photo={photo}
        seen={seen}
        edited={edited}
      />
    </div>
  );
}

/** The chips under a photo tile, or nothing. */
function PhotoPinChips({
  projectId,
  layerId,
  photo,
  seen,
  edited,
}: {
  projectId: string;
  layerId: string;
  photo: PhotoRef;
  seen: boolean;
  edited: boolean;
}): ReactElement | null {
  const t = useT();
  const looks360 = useLooks360(projectId, photo, seen);
  const ctxOf = usePinActionCtx();
  const placed = photo.pos !== undefined;
  if (placed && !looks360 && !edited) return null;
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
      {edited && (
        <span className="m-pin-chip" data-testid="media-tile-edited" data-item={photo.id}>
          <Chip kind="tag">{t('position.edited')}</Chip>
        </span>
      )}
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

/**
 * The right-click menu of the tiles: `open` on a tile's contextmenu, `menu` drawn once. `place`
 * runs Place on site for an unplaced item (a click on its tile), or notes why it cannot.
 */
export function useTileMenu(): {
  open: (e: MouseEvent, k: MediaKey) => void;
  place: (k: MediaKey) => void;
  menu: ReactElement | null;
} {
  const ctxOf = usePinActionCtx();
  const [at, setAt] = useState<{
    x: number;
    y: number;
    k: MediaKey;
    target: MenuTarget;
  } | null>(null);
  const open = useCallback((e: MouseEvent, k: MediaKey) => {
    e.preventDefault();
    setAt({ x: e.clientX, y: e.clientY, k, target: menuTargetOf(k) });
  }, []);
  const close = useCallback(() => {
    setAt(null);
  }, []);
  const place = useCallback(
    (k: MediaKey) => {
      const c = ctxOf(k);
      const item = c ? actionsFor(targetOf(k), c).find((a) => a.id === 'media.place') : undefined;
      if (!c || !item) return;
      if (item.disabled === false) item.run();
      else c.host.note(item.disabled);
    },
    [ctxOf],
  );
  const ctx = at ? ctxOf(at.k) : null;
  const item = at && ctx ? mediaItem(ctx.manifest, at.k) : null;
  const items = at && ctx ? actionsFor(at.target, ctx) : [];
  const menu =
    at && item && items.length > 0 ? (
      <ContextMenu items={items} x={at.x} y={at.y} label={mediaName(item)} onClose={close} />
    ) : null;
  return { open, place, menu };
}
