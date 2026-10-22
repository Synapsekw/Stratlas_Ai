import type { AioBridge, DetectQueued } from '@aio/schema';
import { Button, useT } from '@aio/ui';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { bridge } from '../../shell';

export interface DetectorQueueViewProps {
  items: readonly DetectQueued[];
  /** A waiting run that did not start when its turn came, and why. */
  failed: { run: string; error: string } | null;
  /** Runs whose Cancel is in flight. */
  cancelling: ReadonlySet<string>;
  onCancel: (run: string) => void;
  onDismiss: () => void;
}

/** The waiting runs and the one that failed to start; nothing at all when there are none. */
export function DetectorQueueView({
  items,
  failed,
  cancelling,
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
            disabled={cancelling.has(q.run)}
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

  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());
  const evented = useRef(false);
  const inFlight = useRef(new Set<string>());

  useEffect(() => {
    let live = true;
    void bridge
      .call('detect:queue', {})
      .then((r) => {
        // an event that arrived first is newer than this answer
        if (live && r.ok && !evented.current) setItems(r.value.items);
      })
      .catch(() => undefined);
    const aio = window.aio as AioBridge | undefined;
    const off = aio?.on('detect:queue', (e) => {
      evented.current = true;
      setItems(e.items);
      inFlight.current.clear();
      setCancelling(new Set());
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
      cancelling={cancelling}
      onCancel={(run) => {
        if (inFlight.current.has(run)) return;
        inFlight.current.add(run);
        setCancelling((cur) => new Set(cur).add(run));
        // a run that already left the queue answers not-waiting; the next event sets the list
        const settled = () => {
          inFlight.current.delete(run);
          setCancelling((cur) => {
            const next = new Set(cur);
            next.delete(run);
            return next;
          });
        };
        bridge.call('detect:queueCancel', { run }).then(settled, settled);
      }}
      onDismiss={() => {
        setFailed(null);
      }}
    />
  );
}
