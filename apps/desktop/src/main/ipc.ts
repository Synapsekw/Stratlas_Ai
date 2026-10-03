import { ipc, type IpcChannel, type IpcRequest, type IpcResponse } from '@aio/schema';

export type Handler<C extends IpcChannel> = (
  request: IpcRequest<C>,
) => Promise<IpcResponse<C>> | IpcResponse<C>;

/**
 * Wrap a handler so every request is validated against the frozen contract before the handler
 * runs, and every response is validated before it leaves main.
 */
export function validated<C extends IpcChannel>(channel: C, handler: Handler<C>) {
  const contract = ipc[channel];
  return async (raw: unknown): Promise<IpcResponse<C>> => {
    const parsed = contract.request.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new Error(`Invalid request on ${channel}: ${first?.message ?? 'unknown error'}`);
    }
    const result = await handler(parsed.data as IpcRequest<C>);
    return contract.response.parse(result) as IpcResponse<C>;
  };
}
