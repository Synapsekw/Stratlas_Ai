#!/usr/bin/env node
// Write the update feed (`stratlas-update.json`, schema aio.update-feed/1, ADR 0003) for the
// installers in apps/desktop/dist: version, release notes, and per platform the file name,
// SHA-256 and size. File URLs are relative to the feed, so the folder can be copied to any web
// server, share or USB stick as is. A feed already in dist for the same version is merged, so the
// Windows and macOS builds can fill one feed.
//
// Usage (from the repository root or apps/desktop):
//   node tools/release/feed.mjs [--dist apps/desktop/dist] [--base-url https://host/path/]
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appVersion, releaseNotes } from './notes.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

// The file name stays from before the rename: installed 0.9.0 builds look for it.
export const FEED_FILE = 'stratlas-update.json';
export const FEED_SCHEMA = 'aio.update-feed/1';

/**
 * The feed platform an installer file serves, or null. Names follow electron-builder.yml
 * (`<executable>-<version>-win-x64-setup.exe`, `<executable>-<version>-mac-arm64.dmg`, as
 * tools/release/brand-config.mjs names them; any prefix matches, so older names work too).
 * @param {string} name
 * @param {string} version
 */
export function platformOf(name, version) {
  const v = version.replaceAll('.', '\\.');
  const win = new RegExp(`-${v}-win-(x64|arm64)-setup\\.exe$`).exec(name);
  if (win) return `win-${win[1]}`;
  const mac = new RegExp(`-${v}-mac-(arm64|x64)\\.dmg$`).exec(name);
  if (mac) return `mac-${mac[1]}`;
  return null;
}

/** SHA-256 (hex) of a file, streamed. */
export function sha256File(path) {
  return new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', fail)
      .on('end', () => {
        ok(h.digest('hex'));
      });
  });
}

/**
 * Build the feed object for the installers in `dist`.
 * @param {{ dist: string, version: string, notes?: string, baseUrl?: string, previous?: unknown, now?: Date }} o
 */
export async function buildFeed({ dist, version, notes, baseUrl, previous, now = new Date() }) {
  /** @type {Record<string, { url: string, sha256: string, size: number }>} */
  const files = {};
  const prev = /** @type {{ version?: string, files?: Record<string, unknown> } | undefined} */ (
    previous
  );
  if (prev?.version === version && prev.files) Object.assign(files, prev.files);
  for (const name of readdirSync(dist).sort()) {
    const platform = platformOf(name, version);
    if (!platform) continue;
    const path = join(dist, name);
    const url = baseUrl
      ? new URL(encodeURIComponent(name), baseUrl).href
      : encodeURIComponent(name);
    files[platform] = { url, sha256: await sha256File(path), size: statSync(path).size };
  }
  return {
    schema: FEED_SCHEMA,
    version,
    releasedAt: now.toISOString().slice(0, 10),
    ...(notes ? { notes } : {}),
    files,
  };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dist = resolve(arg('--dist') ?? join(root, 'apps/desktop/dist'));
  const version = appVersion(root);
  const out = join(dist, FEED_FILE);
  const previous = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : undefined;
  const feed = await buildFeed({
    dist,
    version,
    notes: releaseNotes({ version }).markdown,
    ...(arg('--base-url') ? { baseUrl: arg('--base-url') } : {}),
    previous,
  });
  writeFileSync(out, `${JSON.stringify(feed, null, 2)}\n`);
  const platforms = Object.keys(feed.files);
  process.stdout.write(
    `[feed] ${version}: ${platforms.length ? platforms.join(', ') : 'no installers found'} -> ${out}\n`,
  );
}
