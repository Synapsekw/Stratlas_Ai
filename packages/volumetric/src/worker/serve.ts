import { VolumeCompute } from '../model/compute';
import {
  transferables,
  type PortLike,
  type VolumeOps,
  type WorkerReply,
  type WorkerRequest,
} from './protocol';

const fill = (pattern: string, key: string, value: string) =>
  pattern.split(`{${key}}`).join(encodeURIComponent(value));

/** Answer volume requests arriving on `port` (the worker's global scope, or a test channel). */
export function serveVolumes(port: PortLike, fetchText: (url: string) => Promise<string>): void {
  let compute: VolumeCompute | null = null;
  port.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as WorkerRequest;
    if (msg.kind === 'init') {
      const { patterns, epochs, deadband } = msg.init;
      compute = new VolumeCompute({
        fetchText,
        sources: {
          pile: (id) => fill(patterns.pile, 'id', id),
          dsm: (e) => fill(patterns.dsm, 'epoch', e),
          coarse: patterns.coarse,
        },
        epochs,
        deadband,
      });
      return;
    }
    const c = compute;
    const reply = (r: WorkerReply, transfer: Transferable[] = []) => {
      port.postMessage(r, transfer);
    };
    if (!c) {
      reply({ id: msg.id, ok: false, error: 'The volume worker is not initialised' });
      return;
    }
    const fn = c[msg.op].bind(c) as (...a: unknown[]) => Promise<unknown>;
    fn(...msg.args).then(
      (value) => {
        reply({ id: msg.id, ok: true, value }, [...transferables(value)]);
      },
      (e: unknown) => {
        reply({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) });
      },
    );
  };
}

export type { VolumeOps };
