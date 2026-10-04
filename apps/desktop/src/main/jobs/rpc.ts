import type { Readable, Writable } from 'node:stream';

/** A JSON-RPC error answer from the pipeline runtime. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** Error codes the Python runtime uses (python/src/aio_pipelines/rpc.py). */
export const RPC = {
  JOB_FAILED: -32000,
  CANCELLED: -32001,
  JOB_EXISTS: -32002,
  INVALID_PARAMS: -32602,
} as const;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}
type Notify = (method: string, params: unknown) => void;

/**
 * JSON-RPC 2.0 client over a pair of streams, one JSON object per line (the pipeline runtime's
 * stdout and stdin). Bulk data never crosses here; only requests, answers and notifications.
 */
export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notifyListeners: Notify[] = [];
  private readonly junkListeners: ((line: string) => void)[] = [];
  private buffer = '';
  private closed = false;

  constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      this.feed(chunk);
    });
    input.on('end', () => {
      this.close();
    });
    input.on('close', () => {
      this.close();
    });
    input.on('error', () => {
      this.close();
    });
    output.on('error', () => {
      this.close();
    });
  }

  onNotification(fn: Notify): void {
    this.notifyListeners.push(fn);
  }

  /** Lines on the protocol stream that are not JSON-RPC (should not happen; logged). */
  onJunk(fn: (line: string) => void): void {
    this.junkListeners.push(fn);
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('The pipeline runtime connection is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.output.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error('The pipeline runtime connection closed.');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).replace(/\r$/, '');
      this.buffer = this.buffer.slice(i + 1);
      if (line.trim()) this.handle(line);
    }
  }

  private handle(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      for (const fn of this.junkListeners) fn(line);
      return;
    }
    if (typeof msg !== 'object' || msg === null) {
      for (const fn of this.junkListeners) fn(line);
      return;
    }
    const m = msg as {
      id?: unknown;
      method?: unknown;
      params?: unknown;
      result?: unknown;
      error?: { code?: unknown; message?: unknown; data?: unknown };
    };
    if (typeof m.method === 'string' && m.id === undefined) {
      for (const fn of this.notifyListeners) fn(m.method, m.params);
      return;
    }
    if (typeof m.id !== 'number') {
      for (const fn of this.junkListeners) fn(line);
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) {
      const code = typeof m.error.code === 'number' ? m.error.code : -32603;
      const message = typeof m.error.message === 'string' ? m.error.message : 'Unknown error';
      p.reject(new RpcError(code, message, m.error.data));
    } else {
      p.resolve(m.result);
    }
  }
}
