import { ipc, type IpcChannel, type IpcRequest, type IpcResponse } from '@aio/schema';

export type Handler<C extends IpcChannel> = (
  request: IpcRequest<C>,
) => Promise<IpcResponse<C>> | IpcResponse<C>;

/**
 * What `validated` needs of a contract's schemas. Reading `ipc[channel]` through this plain shape
 * (rather than indexing the contract with the generic channel) keeps type checking linear in the
 * number of channels: the generic index made the type-aware linter build the union of every
 * channel's schemas and run out of memory once the contract grew.
 */
interface Schema {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: unknown }
    | { success: false; error: { issues: readonly { message: string }[] } };
  parse(value: unknown): unknown;
}

const contracts = ipc as unknown as Record<IpcChannel, { request: Schema; response: Schema }>;

/**
 * Wrap a handler so every request is validated against the frozen contract before the handler
 * runs, and every response is validated before it leaves main.
 */
export function validated<C extends IpcChannel>(channel: C, handler: Handler<C>) {
  const contract = contracts[channel];
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
