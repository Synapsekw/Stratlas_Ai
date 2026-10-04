import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { RpcClient, RpcError } from './rpc';

function pair() {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const client = new RpcClient(fromServer, toServer);
  const sent: unknown[] = [];
  let buf = '';
  toServer.on('data', (c: Buffer) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      sent.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const reply = (obj: unknown) => fromServer.write(`${JSON.stringify(obj)}\n`);
  return { client, sent, reply, fromServer };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('RpcClient', () => {
  it('sends JSON-RPC 2.0 requests and resolves them by id', async () => {
    const { client, sent, reply } = pair();
    const p = client.request('version', {});
    await tick();
    expect(sent).toEqual([{ jsonrpc: '2.0', id: 1, method: 'version', params: {} }]);
    reply({ jsonrpc: '2.0', id: 1, result: { version: '0.1.0' } });
    await expect(p).resolves.toEqual({ version: '0.1.0' });
  });

  it('rejects with the error code and data', async () => {
    const { client, reply } = pair();
    const p = client.request('jobs.run', { jobId: 'a' });
    reply({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32001, message: 'Cancelled', data: { jobId: 'a' } },
    });
    const e = await p.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RpcError);
    expect(e).toMatchObject({ code: -32001, message: 'Cancelled', data: { jobId: 'a' } });
  });

  it('delivers notifications and survives lines split across chunks and CRLF', async () => {
    const { client, fromServer } = pair();
    const seen: [string, unknown][] = [];
    client.onNotification((m, p) => seen.push([m, p]));
    const line = JSON.stringify({ jsonrpc: '2.0', method: 'progress', params: { fraction: 0.5 } });
    fromServer.write(line.slice(0, 10));
    fromServer.write(`${line.slice(10)}\r\n`);
    await tick();
    expect(seen).toEqual([['progress', { fraction: 0.5 }]]);
  });

  it('reports stray output instead of crashing', async () => {
    const { client, fromServer } = pair();
    const junk: string[] = [];
    client.onJunk((l) => junk.push(l));
    fromServer.write('Traceback (most recent call last):\n');
    await tick();
    expect(junk).toEqual(['Traceback (most recent call last):']);
  });

  it('fails pending requests when the stream closes', async () => {
    const { client, fromServer } = pair();
    const p = client.request('jobs.run', {});
    fromServer.end();
    await expect(p).rejects.toThrow('closed');
    await expect(client.request('version', {})).rejects.toThrow('closed');
  });
});
