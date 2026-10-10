import { describe, expect, it } from 'vitest';
import { connectEngine, EngineStopped, RunCancelled } from './engineClient';
import type { EngineContext, EnginePort, EngineRequest } from './engineProtocol';

/** A port that answers nothing: what it was sent, and the handlers the client put on it. */
function deadPort() {
  const sent: EngineRequest[] = [];
  let terminated = 0;
  const port: EnginePort & { terminate(): void } = {
    postMessage: (m) => {
      sent.push(m as EngineRequest);
    },
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    terminate: () => {
      terminated++;
    },
  };
  return { port, sent, terminated: () => terminated };
}

const context: EngineContext = {
  base: 'aio://project/p1/',
  surfaces: [],
  captures: ['c1'],
  designs: [],
  site: { verticalDatum: { kind: 'project' } },
};
const req = { ring: [], items: [] };

/** What a Worker hands its `onerror` (only the message matters here). */
const errorEvent = (message?: string) => ({ message }) as ErrorEvent;

describe('the engine client when the engine dies', () => {
  it('fails every request that is out, with what happened, and says it stopped', async () => {
    const { port, terminated } = deadPort();
    const client = connectEngine(port);
    expect(client.stopped()).toBeNull();
    const run = client.run(req, 'm1');
    const prints = client.fingerprints(req);
    port.onerror?.(errorEvent('Uncaught RangeError: Array buffer allocation failed'));
    await expect(run).rejects.toBeInstanceOf(EngineStopped);
    await expect(prints).rejects.toThrow(
      /comparison engine stopped.*Array buffer allocation failed/,
    );
    expect(client.stopped()).toBeInstanceOf(EngineStopped);
    // the dead worker is put away, once
    expect(terminated()).toBe(1);
    // and nothing more is sent to it
    await expect(client.run(req)).rejects.toBeInstanceOf(EngineStopped);
  });

  it('takes a message that could not be read the same way, and an error without words', async () => {
    const a = deadPort();
    const first = connectEngine(a.port);
    const run = first.run(req);
    a.port.onmessageerror?.({} as MessageEvent);
    await expect(run).rejects.toThrow(/a message from it could not be read/);

    const b = deadPort();
    const second = connectEngine(b.port);
    const other = second.site({ from: { kind: 'previous' }, to: { kind: 'current' }, cellM: 1 });
    b.port.onerror?.(errorEvent());
    await expect(other).rejects.toThrow(/^The comparison engine stopped\. /);
  });

  it('keeps the context it was given, for the engine started in its place', () => {
    const { port, sent } = deadPort();
    const client = connectEngine(port);
    expect(client.context()).toBeNull();
    client.setContext(context);
    expect(client.context()).toBe(context);
    expect(sent).toEqual([{ kind: 'context', context }]);
  });

  it('still cancels what is out when it is put away on purpose', async () => {
    const { port } = deadPort();
    const client = connectEngine(port);
    const run = client.run(req);
    client.dispose();
    await expect(run).rejects.toBeInstanceOf(RunCancelled);
    // put away is not "stopped": nothing to start again
    expect(client.stopped()).toBeNull();
    // a late error from the terminated worker changes nothing
    port.onerror?.(errorEvent('late'));
    expect(client.stopped()).toBeNull();
  });
});
