/**
 * The app and the pipeline pack of this repository, by their real version numbers: the files a
 * version bump edits (`apps/desktop/package.json`, `python/pyproject.toml`) and the two rules
 * between them (`APP_RANGE` in the pack, `PHOTO_PACK` in the app). Every build handed over gets a
 * new number (docs/release/README.md), so these are read from the files, not written here twice.
 */
import { packRangeRefusal, type PackArchive } from '@aio/schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHOTO_PACK } from '../photogrammetry';
import { evidencePackRefusal } from '../evidencePack';
import { rfPackRefusal } from '../rfPack';
import { compareVersions } from './pack';
import { packNeeds, packOffer } from './packInstall';

const repo = join(import.meta.dirname, '..', '..', '..', '..', '..');
const read = (...path: string[]) => readFileSync(join(repo, ...path), 'utf8');
const first = (text: string, re: RegExp, what: string): string => {
  const m = re.exec(text)?.[1];
  if (!m) throw new Error(`${what} not found`);
  return m;
};

const app = (JSON.parse(read('apps', 'desktop', 'package.json')) as { version: string }).version;
const pack = first(
  read('python', 'pyproject.toml'),
  /^\[project\][^[]*?^version = "([^"]+)"/ms,
  'the version in python/pyproject.toml',
);
const appRange = first(
  read('python', 'src', 'aio_pipelines', '__init__.py'),
  /^APP_RANGE = "([^"]+)"/m,
  'APP_RANGE',
);
/** What this app needs of a pack by its number alone (index.ts passes the same to `packStatus`). */
const features = [{ label: 'Creating maps from photos', minVersion: PHOTO_PACK }];
/** The pack handed over before this one, with the range it declared. */
const BEFORE = { version: '0.7.0', appRange: '>=0.11.0 <2.0.0' };

const archive = (version: string): PackArchive => ({
  path: `pipeline-pack-${version}-win-x64.tar.gz`,
  version,
  where: 'downloads',
  bytes: 1,
});

describe('the app and the pipeline pack of this repository', () => {
  it('have plain three-part version numbers', () => {
    expect(app).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pack).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('accept each other: the pack takes this app, and is new enough for it', () => {
    expect(packRangeRefusal(appRange, app, 'Quadrion AI')).toBeNull();
    expect(packNeeds(pack, undefined, features)).toEqual([]);
  });

  it('do not turn away the pack handed over before, but photos need this one (ODM)', () => {
    expect(packRangeRefusal(BEFORE.appRange, app, 'Quadrion AI')).toBeNull();
    expect(PHOTO_PACK).toBe('0.8.0');
    expect(packNeeds(BEFORE.version, undefined, features)).toEqual([
      'Creating maps from photos needs version 0.8.0 or later.',
    ]);
  });

  it('offer this pack as newer than the one handed over before, and not the other way', () => {
    expect(compareVersions(pack, BEFORE.version)).toBeGreaterThan(0);
    expect(packOffer({ state: 'ok', version: BEFORE.version }, [archive(pack)])).toEqual(
      archive(pack),
    );
    expect(packOffer({ state: 'ok', version: pack }, [archive(BEFORE.version)])).toBeNull();
    // the same number again is nothing new: why every build handed over needs its own
    expect(packOffer({ state: 'ok', version: pack }, [archive(pack)])).toBeNull();
  });

  it('offers the component pack beyond shipped RF while retaining existing RF compatibility', () => {
    expect(evidencePackRefusal('model.evidence', '0.15.0')).not.toBeNull();
    expect(evidencePackRefusal('model.evidence', pack)).toBeNull();
    expect(rfPackRefusal('rf.coverage', '0.15.0')).toBeNull();
    expect(packOffer({ state: 'ok', version: '0.15.0' }, [archive(pack)])).toEqual(archive(pack));
  });
});
