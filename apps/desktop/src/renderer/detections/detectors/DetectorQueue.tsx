import type { AioBridge, DetectQueued } from '@aio/schema';
import { Button, useT } from '@aio/ui';
import { useEffect, useState, type ReactElement } from 'react';
import { bridge } from '../../shell';

export interface DetectorQueueViewProps {
  items: readonly DetectQueued[];
  /** A waiting run that did not start when its turn came, and why. */
  failed: { run: string; error: string } | null;
  onCancel: (run: string) => void;
  onDismiss: () => void;
}

/** The waiting runs and the one that failed to start; nothing at all when there are none. */
export function DetectorQueueView({
  items,
  failed,
  onCancel,
  onDismiss,
}: DetectorQueueViewProps): ReactElement | null {
  const t = useT();
  if (items.length === 0 && !failed) return null;
  return (
    <section className="det-vlm-queue" aria-label={t('detect.preset.queue.label')}>
      {failed && (
        <p className="det-vlm-queue-failed" role="alert">
          <span>{t('detect.preset.queue.failed', { error: failed.error })}</span>
          <Button variant="quiet" onClick={onDismiss}>
            {t('detect.preset.queue.dismiss')}
          </Button>
        </p>
      )}
      {items.map((q) => (
        <div key={q.run} className="det-vlm-queued" data-testid="det-vlm-queued">
          <span>
            {t('detect.preset.queue.row', {
              names: q.detectors.join(', '),
              count: q.photos,
            })}
          </span>
          <Button
            variant="quiet"
            onClick={() => {
              onCancel(q.run);
            }}
          >
            {t('detect.preset.queue.cancel')}
          </Button>
        </div>
      ))}
    </section>
  );
}

/** Detector runs waiting for the graphics card: read once, then follow `detect:queue`. */
export function DetectorQueue(): ReactElement | null {
  const [items, setItems] = useState<readonly DetectQueued[]>([]);
  const [failed, setFailed] = useState<{ run: string; error: string } | null>(null);

  useEffect(() => {
    let live = true;
    void bridge.call('detect:queue', {}).then((r) => {
      // an event that arrived first is newer than this answer
      if (live && r.ok) setItems((cur) => (cur.length > 0 ? cur : r.value.items));
    });
    const aio = window.aio as AioBridge | undefined;
    const off = aio?.on('detect:queue', (e) => {
      setItems(e.items);
      if (e.failed) setFailed(e.failed);
    });
    return () => {
      live = false;
      off?.();
    };
  }, []);

  return (
    <DetectorQueueView
      items={items}
      failed={failed}
      onCancel={(run) => {
        // a run that already left the queue answers not-waiting; the next event sets the list
        void bridge.call('detect:queueCancel', { run });
      }}
      onDismiss={() => {
        setFailed(null);
      }}
    />
  );
}
