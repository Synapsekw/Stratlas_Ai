/**
 * Hub folders (M9 T5): a shared folder where each device writes only its own files that never
 * change (op chunks and blobs, temp name then rename), plus advisory presence. Copes with a slow
 * share (every call has a time limit) and one that goes away mid-write (temp files are never read
 * and are swept by their writer later).
 */
import { HUB_FILE, HUB_PATHS } from '@aio/schema';

export { HUB_FILE, HUB_PATHS };
export { presenceFresh } from './presence';
export { HubUnreachable, nodeHubFs, withTimeouts, type HubFs } from './fs';
export { createHubTransport, type HubOptions, type HubPull, type HubTransport } from './transport';
