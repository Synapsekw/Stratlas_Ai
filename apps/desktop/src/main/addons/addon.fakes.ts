/**
 * Tiny add-on archives for the unit tests and the e2e spec of the add-on installer (install.ts):
 * the synthetic marker detector, the synthetic colour segmenter and a ground classifier file, as
 * `tools/addons/build-addon.mjs` packs them. The tar is written entry by entry (`fakeTarGz`), so a
 * test can also hold what the builder never writes: a tampered file, an unlisted entry, a `..`.
 */
import {
  ADDON_SCHEMA,
  ADDON_CATALOGUE_SCHEMA,
  POINT_CLASSIFIER_SCHEMA,
  type AddonCatalogue,
  type AddonCatalogueEntry,
  type AddonKind,
  type AddonManifest,
} from '@aio/schema';
import { createHash } from 'node:crypto';
import { colourSegmenterOnnx } from '../inference/fixtures/colourSegmenter';
import { markerCard, markerDetectorOnnx } from '../inference/fixtures/markerDetector';
import { fakeTarGz, type FakeTarEntry } from '../jobs/packArchive.fakes';

const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The files of a working add-on of each kind (a few kilobytes). */
export function fakeAddonFiles(kind: AddonKind, name = 'Test add-on'): Record<string, Buffer> {
  switch (kind) {
    case 'detector': {
      const onnx = markerDetectorOnnx();
      return {
        'model.onnx': Buffer.from(onnx),
        'model.json': Buffer.from(JSON.stringify(markerCard(onnx, { name }))),
      };
    }
    case 'segmenter': {
      const m = colourSegmenterOnnx();
      return {
        'encoder.onnx': Buffer.from(m.encoder),
        'decoder.onnx': Buffer.from(m.decoder),
        'model.json': Buffer.from(JSON.stringify({ ...m.card, name })),
      };
    }
    case 'point-classifier':
      return {
        'classifier.json': Buffer.from(
          JSON.stringify({
            schema: POINT_CLASSIFIER_SCHEMA,
            method: 'smrf',
            smrf: { cell: 2, slope: 0.2, window: 16, threshold: 0.45, scalar: 1.2 },
          }),
        ),
      };
  }
}

export interface FakeAddonOptions {
  id: string;
  version?: string;
  kind: AddonKind;
  name?: string;
  licence?: string;
  minPipelinePack?: string;
  /** The add-on's files; `fakeAddonFiles(kind)` by default. */
  files?: Record<string, string | Buffer>;
  /** Change the manifest before it is written (a wrong size or SHA-256). */
  manifest?: (m: AddonManifest) => void;
  /** Files written into the archive after the manifest was made (a tampered or unlisted file). */
  override?: Record<string, string | Buffer>;
  /** More raw tar entries (a link, a `..`, an absolute path). */
  extraEntries?: readonly FakeTarEntry[];
}

export interface FakeAddon {
  /** The `.aioaddon` bytes. */
  bytes: Buffer;
  manifest: AddonManifest;
  /** The archive's SHA-256 and size, as a catalogue lists them. */
  sha256: string;
  sizeBytes: number;
  /** `<id>-<version>.aioaddon`. */
  fileName: string;
}

/** An add-on archive: `addon.json` first, then each file, at the archive's root. */
export function fakeAddonArchive(o: FakeAddonOptions): FakeAddon {
  const version = o.version ?? '1.0.0';
  const name = o.name ?? `Test ${o.id}`;
  const files = o.files ?? fakeAddonFiles(o.kind, name);
  const listed = Object.entries(files).map(([path, data]) => {
    const b = Buffer.from(data);
    return { path, sizeBytes: b.length, sha256: sha(b) };
  });
  const manifest: AddonManifest = {
    schema: ADDON_SCHEMA,
    id: o.id,
    name,
    version,
    kind: o.kind,
    licence: o.licence ?? 'MIT',
    source: 'Quadrion AI test fixture',
    sizeBytes: listed.reduce((s, f) => s + f.sizeBytes, 0),
    files: listed,
    ...(o.minPipelinePack ? { minPipelinePack: o.minPipelinePack } : {}),
  };
  o.manifest?.(manifest);
  const written = { ...files, ...o.override };
  const entries: FakeTarEntry[] = [
    { path: 'addon.json', data: JSON.stringify(manifest, null, 2) },
    ...Object.entries(written).map(([path, data]) => ({ path, data })),
    ...(o.extraEntries ?? []),
  ];
  const bytes = fakeTarGz(entries);
  return {
    bytes,
    manifest,
    sha256: sha(bytes),
    sizeBytes: bytes.length,
    fileName: `${o.id}-${version}.aioaddon`,
  };
}

/** The catalogue entry of a fake add-on served at `url` (absolute, or relative to the base). */
export const fakeCatalogueEntry = (a: FakeAddon, url = a.fileName): AddonCatalogueEntry => ({
  manifest: a.manifest,
  archive: { url, sizeBytes: a.sizeBytes, sha256: a.sha256 },
});

export const fakeCatalogue = (entries: readonly AddonCatalogueEntry[]): AddonCatalogue => ({
  schema: ADDON_CATALOGUE_SCHEMA,
  addons: [...entries],
});
