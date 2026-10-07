/**
 * Exchange file problems a person can act on. `code` lets main and tests tell them apart; the
 * message is the exact sentence shown (plain British English, no file contents).
 */
export type ExchangeErrorCode =
  /** Not an exchange file at all (wrong format). */
  | 'not-exchange'
  /** Damaged or cut short (truncated directory, bad CRC, a member past the end). */
  | 'damaged'
  /** Built to attack the reader: `..` or absolute names, links, duplicates, overlapping members. */
  | 'hostile'
  /** Over the 2 GB limit. */
  | 'too-large'
  /** Encrypted and no passphrase given. */
  | 'needs-passphrase'
  /** The passphrase does not open it. */
  | 'passphrase'
  /** The header signature does not verify, or an op is not what it claims. */
  | 'signature'
  /** The header or an op is not valid for this build. */
  | 'schema'
  /** For another team project. */
  | 'wrong-project';

export class ExchangeError extends Error {
  override name = 'ExchangeError';
  constructor(
    readonly code: ExchangeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Exchange files are refused above this size: use a hub folder or a patch plus a USB copy. */
export const EXCHANGE_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** "2.0 GB", "512 KB": sizes in messages. */
export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

export function tooLarge(bytes: number): ExchangeError {
  return new ExchangeError(
    'too-large',
    `This exchange file would be ${formatBytes(bytes)}. Exchange files are limited to 2 GB: export changes only (a patch) and move large files through a shared folder or a USB copy of the project.`,
  );
}
