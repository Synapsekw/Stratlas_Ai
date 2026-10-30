/**
 * The one toast queue. `toast(message)` from anywhere; a `<ToastHost />` shows one toast at a
 * time: the newest wins, older ones wait and show when it goes. A toast with the id of one that
 * is still queued or showing replaces it in place (a notice that updates its text).
 */
import type { IconName } from '../icons/Icon';

export type ToastTone = 'info' | 'ok' | 'warn' | 'error';

/** Where a toast shows: the stage slot (bottom left of the 3D view) or the window corner. */
export type ToastPlacement = 'stage' | 'window';

export interface ToastAction {
  label: string;
  run: () => void;
  testId?: string;
}

export interface ToastOptions {
  tone?: ToastTone;
  /** One button; pressing it runs it and dismisses the toast. */
  action?: ToastAction;
  /** A stable id: a later toast with the same id replaces this one. Default a new id. */
  id?: string;
  /** How long it shows once visible; 0 keeps it until dismissed. Default by tone. */
  ttlMs?: number;
  /** A second, quieter line. */
  detail?: string;
  /** The leading icon; default by tone. */
  icon?: IconName;
  /** The host to show on (the other one while it is not mounted). Default: the stage first. */
  placement?: ToastPlacement;
  /** Called when the person dismisses it (the close button or Escape), not when it times out. */
  onDismiss?: () => void;
  testId?: string;
}

export interface Toast {
  id: string;
  message: string;
  tone: ToastTone;
  ttlMs: number;
  /** Bumped on every replace, so a host restarts the timer of a toast that changed. */
  version: number;
  action?: ToastAction;
  detail?: string;
  icon?: IconName;
  placement?: ToastPlacement;
  onDismiss?: () => void;
  testId?: string;
}

/** Time on screen by tone: errors and warnings stay longer, they may need acting on. */
export const TOAST_TTL: Readonly<Record<ToastTone, number>> = {
  info: 5000,
  ok: 4000,
  warn: 8000,
  error: 10000,
};

/** Toasts kept waiting at most; the oldest is dropped beyond this. */
export const TOAST_QUEUE_MAX = 20;

let queue: readonly Toast[] = [];
const mounted = new Map<ToastPlacement, number>();
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/** Show `message`; returns its id (the one given, or a new one). */
export function toast(message: string, opts: ToastOptions = {}): string {
  const tone = opts.tone ?? 'info';
  const at = opts.id === undefined ? -1 : queue.findIndex((x) => x.id === opts.id);
  const id = opts.id ?? `toast-${String(++seq)}`;
  const prev = at >= 0 ? queue[at] : undefined;
  const next: Toast = {
    id,
    message,
    tone,
    ttlMs: opts.ttlMs ?? TOAST_TTL[tone],
    version: (prev?.version ?? 0) + 1,
    ...(opts.action && { action: opts.action }),
    ...(opts.detail !== undefined && { detail: opts.detail }),
    ...(opts.icon && { icon: opts.icon }),
    ...(opts.placement && { placement: opts.placement }),
    ...(opts.onDismiss && { onDismiss: opts.onDismiss }),
    ...(opts.testId !== undefined && { testId: opts.testId }),
  };
  if (prev) queue = queue.map((x, i) => (i === at ? next : x));
  else queue = [...queue, next].slice(-TOAST_QUEUE_MAX);
  emit();
  return id;
}

/** Remove a toast, showing or waiting. Unknown ids are ignored. */
export function dismissToast(id: string): void {
  if (!queue.some((x) => x.id === id)) return;
  queue = queue.filter((x) => x.id !== id);
  emit();
}

/** Remove every toast (tests, a project closed). */
export function clearToasts(): void {
  if (queue.length === 0) return;
  queue = [];
  emit();
}

/** The queue, oldest first (tests and hosts). */
export function toastQueue(): readonly Toast[] {
  return queue;
}

const isMounted = (p: ToastPlacement) => (mounted.get(p) ?? 0) > 0;

/**
 * The host a toast goes to: its placement while that host is on screen, else the other one (a
 * stage toast while no project is open shows in the window corner); unplaced, the stage first.
 */
function hostOf(x: Toast): ToastPlacement {
  const want = x.placement ?? 'stage';
  const other = want === 'stage' ? 'window' : 'stage';
  return isMounted(want) || !isMounted(other) ? want : other;
}

/** The toast a host shows now: the newest routed to it. */
export function visibleToast(placement: ToastPlacement): Toast | undefined {
  for (let i = queue.length - 1; i >= 0; i--) {
    const x = queue[i];
    if (x && hostOf(x) === placement) return x;
  }
  return undefined;
}

/** Toasts waiting behind the visible one on a host. */
export function waitingCount(placement: ToastPlacement): number {
  return Math.max(0, queue.filter((x) => hostOf(x) === placement).length - 1);
}

/** A host mounts and unmounts here, so unplaced toasts find the stage while it is on screen. */
export function registerHost(placement: ToastPlacement): () => void {
  mounted.set(placement, (mounted.get(placement) ?? 0) + 1);
  emit();
  return () => {
    mounted.set(placement, Math.max(0, (mounted.get(placement) ?? 0) - 1));
    emit();
  };
}

export function subscribeToasts(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** A snapshot that changes whenever the queue or the mounted hosts change. */
let stamp = 0;
listeners.add(() => {
  stamp += 1;
});
export function toastStamp(): number {
  return stamp;
}
