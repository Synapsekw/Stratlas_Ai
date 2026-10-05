import { z } from 'zod';

/**
 * Update feed and rollback contracts (ADR 0003). The feed is one static JSON file a release
 * publishes next to its installers; the app reads it only when the person presses Check now.
 */
export const UPDATE_FEED_SCHEMA = 'aio.update-feed/1';

/** File name the release tooling writes and the app appends to a folder address. */
export const UPDATE_FEED_FILE = 'stratlas-update.json';

/** Installer slot per operating system and CPU. */
export const UpdatePlatform = z.enum(['win-x64', 'win-arm64', 'mac-arm64', 'mac-x64']);
export type UpdatePlatform = z.infer<typeof UpdatePlatform>;

const Version = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'a version like 1.2.3');

export const UpdateFile = z.object({
  /** Absolute http(s) address, or a path relative to the feed's own address. */
  url: z.string().min(1),
  /** SHA-256 of the whole file, lowercase hex. */
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, '64 hex characters'),
  /** Size in bytes; the download stops when the server sends more. */
  size: z.number().int().positive(),
});
export type UpdateFile = z.infer<typeof UpdateFile>;

export const UpdateFeed = z.object({
  schema: z.literal(UPDATE_FEED_SCHEMA),
  version: Version,
  /** ISO date of the release. */
  releasedAt: z.string().optional(),
  /** Release notes in Markdown (headings and bullet lists), from `tools/release/notes.mjs`. */
  notes: z.string().max(200_000).optional(),
  files: z.partialRecord(UpdatePlatform, UpdateFile),
});
export type UpdateFeed = z.infer<typeof UpdateFeed>;

/** Release notes bundled with the app for the running version. */
export const ReleaseNotes = z.object({
  version: z.string(),
  /** Markdown: `#`/`##` headings and `- ` bullets. Empty when the build had no git history. */
  markdown: z.string(),
});
export type ReleaseNotes = z.infer<typeof ReleaseNotes>;

/** What the app knows about updates and rollback (`update:status`). */
export const UpdateStatus = z.object({
  current: z.string(),
  /** The kept copy of the version before the last update; the app can return to it. */
  previous: z
    .object({
      version: z.string(),
      /** Folder of the kept copy (inside the app settings folder). */
      dir: z.string(),
    })
    .optional(),
  /** An update is waiting for its first good start. */
  pending: z
    .object({
      from: z.string(),
      to: z.string(),
      /** Starts of the new version that never reported ready. */
      failures: z.number().int().nonnegative(),
    })
    .optional(),
  /** The last return to a kept version, shown until the next update. */
  rolledBack: z.object({ from: z.string(), to: z.string(), at: z.string() }).optional(),
  /** Why rollback is not possible here (development build, Store, portable). */
  rollbackUnavailable: z.string().optional(),
});
export type UpdateStatus = z.infer<typeof UpdateStatus>;
