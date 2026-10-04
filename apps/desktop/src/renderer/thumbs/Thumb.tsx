/**
 * Image tiles for grids of project media (Media screen). A tile loads nothing until it scrolls
 * near the view, then shows a small thumbnail: `aio://thumb/...` (the project's own `thumbs/`
 * copy or main's cache), else one made in a worker and stored for next time. Full-resolution
 * originals are never decoded for a tile unless no thumbnail can be made.
 */
import type { AssetRef } from '@aio/schema';
import { Icon, type IconName } from '@aio/ui';
import { assetUrl } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import { bridge } from '../shell';
import { createThumbQueue, type ThumbJob, type ThumbReply, type ThumbRequest } from './queue';

/** Longest side of a generated thumbnail: sharp in a 112 to 200 px tile on a 2x display. */
export const THUMB_PX = 320;
const WORKERS = 2;

function safeUrl(projectId: string, ref: AssetRef | undefined): string | undefined {
  if (!ref) return undefined;
  try {
    return assetUrl(projectId, ref);
  } catch {
    return undefined;
  }
}

/** `aio://thumb/<id>/<path>` for an image the protocol serves as `aio://project/<id>/<path>`. */
export function thumbUrl(full: string): string {
  return full.replace(/^aio:\/\/project\//, 'aio://thumb/');
}

/** Project-relative path of an asset, for the thumbnail cache key. */
const relPath = (ref: AssetRef) =>
  'hash' in ref ? `assets/sha256/${ref.hash}` : ref.path.replace(/\\/g, '/');

interface Slot {
  w: Worker;
  busy: number;
}
let slots: Slot[] | null = null;
const waiting = new Map<
  number,
  { resolve: (b: ArrayBuffer) => void; reject: (e: Error) => void }
>();
let nextId = 1;

function workers(): Slot[] {
  if (slots) return slots;
  slots = Array.from({ length: WORKERS }, (_, i) => {
    const w = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: `thumbs-${String(i)}`,
    });
    const slot: Slot = { w, busy: 0 };
    w.onmessage = (e: MessageEvent<ThumbReply>) => {
      slot.busy--;
      const p = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      if (!p) return;
      if ('error' in e.data) p.reject(new Error(e.data.error));
      else p.resolve(e.data.data);
    };
    return slot;
  });
  return slots;
}

function makeInWorker(url: string): Promise<ArrayBuffer> {
  const pool = workers();
  const slot = pool.reduce((a, b) => (b.busy < a.busy ? b : a));
  const job: ThumbJob = { id: nextId++, url, maxPx: THUMB_PX };
  slot.busy++;
  return new Promise((resolve, reject) => {
    waiting.set(job.id, { resolve, reject });
    slot.w.postMessage(job);
  });
}

const queue = createThumbQueue({
  make: makeInWorker,
  store: (req, data) =>
    bridge.call('thumbs:put', { projectId: req.projectId, path: req.path, data }),
  toUrl: (bytes) => URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })),
  concurrency: WORKERS,
});

// One IntersectionObserver per scroll container: tiles start loading 1.5 screens ahead.
const observers = new WeakMap<Element | Document, IntersectionObserver>();
const onNear = new WeakMap<Element, () => void>();

function watchNear(el: Element, cb: () => void): () => void {
  const root = el.closest('[data-thumb-root]') ?? document;
  let io = observers.get(root);
  if (!io) {
    const made = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          made.unobserve(e.target);
          onNear.get(e.target)?.();
          onNear.delete(e.target);
        }
      },
      { root: root === document ? null : root, rootMargin: '150% 0px' },
    );
    observers.set(root, made);
    io = made;
  }
  onNear.set(el, cb);
  io.observe(el);
  const observer = io;
  return () => {
    observer.unobserve(el);
    onNear.delete(el);
  };
}

/**
 * One media tile picture. `thumb` false shows the image itself (already small, such as a video
 * poster), still loaded only near the view.
 */
export function MediaThumb({
  projectId,
  asset,
  icon,
  thumb = true,
}: {
  projectId: string;
  asset: AssetRef | undefined;
  icon: IconName;
  thumb?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const full = safeUrl(projectId, asset);
  const req: ThumbRequest | null =
    thumb && asset && full ? { projectId, path: relPath(asset), source: full } : null;
  const first = req ? (queue.made(req) ?? thumbUrl(req.source)) : full;
  const [src, setSrc] = useState<string | null | undefined>(first);
  const [failed, setFailed] = useState(false);
  const cancel = useRef<(() => void) | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el || near) return;
    return watchNear(el, () => {
      setNear(true);
    });
  }, [near]);
  useEffect(
    () => () => {
      cancel.current?.();
    },
    [],
  );

  const onError = () => {
    // No thumbnail served yet: make one off the main thread, else fall back to the image.
    if (req && src === thumbUrl(req.source)) {
      setSrc(null);
      cancel.current = queue.request(req, (url) => {
        cancel.current = null;
        setSrc(url ?? full);
      });
      return;
    }
    setFailed(true);
  };

  return (
    <div className="m-thumb" ref={box}>
      {failed || !full ? (
        <Icon name={icon} size={20} />
      ) : near && src ? (
        <img src={src} alt="" decoding="async" draggable={false} onError={onError} />
      ) : null}
    </div>
  );
}
