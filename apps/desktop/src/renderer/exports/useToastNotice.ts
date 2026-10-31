import { dismissToast, toast, type ToastOptions } from '@aio/ui';
import { useEffect, useRef } from 'react';

/** A notice as a toast: its message and the toast options, without the id (the hook's). */
export interface ToastNotice extends Omit<ToastOptions, 'id'> {
  message: string;
}

/**
 * Keeps the toast `id` on the toast host while `notice` is not null and takes it off when it goes
 * null or the caller unmounts: a notice whose state lives in a store shows through the one host,
 * one at a time. It stays until its store lets it go (ttl 0 unless the notice gives one). The
 * toast is replaced in place when its message, tone, icon, detail, labels or body change; its
 * callbacks always run the latest ones. A new `event` (a new deletion, a new drop: any value that
 * differs from the last) brings it to the front again, as a new toast would come.
 */
export function useToastNotice(id: string, notice: ToastNotice | null, event?: unknown): void {
  const latest = useRef(notice);
  const lastEvent = useRef(event);
  useEffect(() => {
    latest.current = notice;
  });
  const key =
    notice &&
    JSON.stringify([
      notice.message,
      notice.tone,
      notice.icon,
      notice.detail,
      notice.testId,
      notice.ttlMs,
      notice.placement,
      notice.closeLabel,
      notice.closeTestId,
      notice.closable,
      notice.actionable,
      notice.action?.label,
      notice.action?.testId,
      notice.onDismiss !== undefined,
    ]);
  const body = notice?.body;
  useEffect(() => {
    const n = latest.current;
    if (!n) {
      dismissToast(id);
      return;
    }
    if (lastEvent.current !== event) {
      lastEvent.current = event;
      dismissToast(id);
    }
    const { message, action, onDismiss, ...rest } = n;
    toast(message, {
      ttlMs: 0,
      ...rest,
      id,
      ...(action && {
        action: { ...action, run: () => latest.current?.action?.run() },
      }),
      ...(onDismiss && { onDismiss: () => latest.current?.onDismiss?.() }),
    });
  }, [id, key, body, event]);
  useEffect(
    () => () => {
      dismissToast(id);
    },
    [id],
  );
}
