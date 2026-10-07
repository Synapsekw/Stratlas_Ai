/**
 * Exchange files (`.aiosync`, M9 T5): patch and bundle; signed header; preview and idempotent
 * import planning; passphrase encryption (AES-256-GCM, scrypt); a strict archive reader that
 * refuses hostile files with an exact message; the 2 GB limit.
 */
export { exchangeMembers, isSafeMemberName } from './names';
export { EXCHANGE_MAX_BYTES, ExchangeError, formatBytes, type ExchangeErrorCode } from './errors';
export {
  DEFAULT_SCRYPT,
  decryptExchange,
  encryptExchange,
  isEncryptedExchange,
  type ScryptParams,
} from './envelope';
export { deviceRecordValid, headerHash, signHeader, verifyHeader } from './header';
export {
  chainRuns,
  headsOf,
  mergeHeads,
  opsSince,
  planIngest,
  type IngestPlan,
  type LocalChains,
} from './ingest';
export { estimateConflicts, planFor, previewExchange, touches, type LocalView } from './preview';
export {
  openExchange,
  type OpenedExchange,
  type OpenExchangeOptions,
  type SignatureState,
} from './read';
export { exchangeSize, writeExchange, type BundleBlob, type WriteExchangeOptions } from './write';
export { openExchangeZip, writeExchangeZip, type ExchangeZip, type ZipMember } from './zip';
