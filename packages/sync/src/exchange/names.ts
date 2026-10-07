import { EXCHANGE_HEADER_FILE, blobPath, opChunkName } from '@aio/schema';

/** The members of an exchange file, as `aio-exchange.json` lists them. */
export const exchangeMembers = {
  header: EXCHANGE_HEADER_FILE,
  device: (device: string) => `journal/devices/${device}.json`,
  ops: (chain: string, from: number, to: number) => `journal/ops/${chain}/${opChunkName(from, to)}`,
  blob: (sha256: string) => blobPath(sha256),
} as const;

/**
 * Is a member name one an exchange file may carry: relative, forward slashes, no `..`, no drive,
 * no empty or dot segment, under one of the known folders. Anything else is refused on import.
 */
export function isSafeMemberName(name: string): boolean {
  if (name.length === 0 || name.length > 400) return false;
  if (name.includes('\\') || name.includes('\0') || name.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(name)) return false;
  const parts = name.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  return (
    name === EXCHANGE_HEADER_FILE ||
    /^journal\/devices\/d_[a-z2-7]{52}\.json$/.test(name) ||
    /^journal\/ops\/d_[a-z2-7]{52}\.r_[a-z2-7]{16}\/\d{6}-\d{6}\.jsonl$/.test(name) ||
    /^blobs\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(name)
  );
}
