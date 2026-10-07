import { BASE32_ALPHABET, type ApprovalId, type CommentId } from '@aio/schema';

/** 16 base32 letters from 80 random bits (Web Crypto: main and renderer alike). */
function letters16(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  // one letter per byte, 5 of its bits: 80 bits in all, no modulo bias (32 divides 256)
  return [...bytes].map((b) => BASE32_ALPHABET.charAt(b & 31)).join('');
}

export function newCommentId(): CommentId {
  return `cm_${letters16()}`;
}

export function newApprovalId(): ApprovalId {
  return `ap_${letters16()}`;
}

/** Wall time of a clock reading (`<ms>.<counter>.<device>`), or null when it is not one. */
export function hlcTime(hlc: string): Date | null {
  const ms = /^(\d{13})\./.exec(hlc)?.[1];
  return ms ? new Date(Number(ms)) : null;
}

/** `2026-10-07` from a clock reading; empty when it is not one. */
export function hlcDate(hlc: string): string {
  return hlcTime(hlc)?.toISOString().slice(0, 10) ?? '';
}
