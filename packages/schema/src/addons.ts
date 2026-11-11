import { z } from 'zod';

/*
 * Add-on model packs (intelligence review Wave 3, N1; founder decision 4): small packs of model
 * files outside the Analytics pack, downloaded on demand from Settings > Models and detection
 * (one click, the size shown first, progress, a SHA-256 check, removable) or chosen from a file on
 * a computer that is offline. Nobody installs one by hand.
 *
 * - An add-on archive (`<id>-<version>.aioaddon`) is a gzipped tar with `addon.json`
 *   (`aio.addon/1`, `AddonManifest`) at its root and the files the manifest lists beside it.
 * - The catalogue (`aio.addon-catalogue/1`, `AddonCatalogue`) is `catalogue.json` at the add-on
 *   base URL (Settings `addons.baseUrl`, or `QUADRION_ADDONS_URL`). Each entry is a manifest plus
 *   the archive's address, size and SHA-256, so the size shows before a download and the archive is
 *   checked before it is opened.
 * - Installed add-ons live in `<dataRoot>/runtime/addons/<id>/` (`addon.json` and its files). Every
 *   file is checked against the manifest's size and SHA-256 when it is installed.
 */

export const ADDON_SCHEMA = 'aio.addon/1';
export const ADDON_CATALOGUE_SCHEMA = 'aio.addon-catalogue/1';
export const ADDON_MANIFEST_FILE = 'addon.json';
export const ADDON_ARCHIVE_EXT = '.aioaddon';
export const ADDONS_DIR = 'addons';
/** Largest add-on archive or unpacked add-on accepted. */
export const MAX_ADDON_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_ADDON_FILES = 64;

/**
 * What an add-on does, which says where the app uses it:
 * - `detector`: `model.onnx` and `model.json` (`aio.detector/1`), listed with the detection models
 *   (`DetectorModelInfo.where: 'addon'`) and run by the local ONNX detection.
 * - `segmenter`: a SAM-class `encoder.onnx`, `decoder.onnx` and `model.json`, used by Suggest
 *   boundaries and the Review mask assist in place of the pipeline pack's model, and the switch for
 *   lifting photo masks onto a point cloud (`segment.lift`).
 * - `point-classifier`: `classifier.json` (`aio.point-classifier/1`), the ground classification
 *   a point cloud noise run adds (`pointcloud.clean` `ground`).
 */
export const AddonKind = z.enum(['detector', 'segmenter', 'point-classifier']);
export type AddonKind = z.infer<typeof AddonKind>;

export const AddonId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'An add-on id is lower case letters, digits and hyphens.');
export type AddonId = z.infer<typeof AddonId>;

const Semver = z.string().regex(/^\d+\.\d+\.\d+$/, 'A version is three numbers, like 1.2.0.');
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'A SHA-256 is 64 lower case hex digits.');
/** A file inside the add-on: forward slashes, no leading slash, no `..`, no backslash. */
const AddonPath = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'An add-on file path is relative, with forward slashes.')
  .refine((p) => !p.split('/').includes('..') && !p.includes('//'), 'No ".." in add-on paths.')
  .refine((p) => p !== ADDON_MANIFEST_FILE, 'addon.json is the manifest, not a listed file.');

export const AddonFile = z
  .object({
    path: AddonPath,
    sizeBytes: z.number().int().nonnegative(),
    sha256: Sha256,
  })
  .strict();
export type AddonFile = z.infer<typeof AddonFile>;

export const AddonManifest = z
  .object({
    schema: z.literal(ADDON_SCHEMA),
    id: AddonId,
    name: z.string().min(1).max(80),
    version: Semver,
    kind: AddonKind,
    description: z.string().max(400).optional(),
    /** SPDX expression, or a named licence (for example `SAM License`), shown before download. */
    licence: z.string().min(2).max(80),
    /** Where the weights come from (a model card or paper link). */
    source: z.string().min(1).max(500),
    /** Sum of the files' sizes: the space the add-on takes once installed. */
    sizeBytes: z.number().int().nonnegative().max(MAX_ADDON_BYTES),
    files: z.array(AddonFile).min(1).max(MAX_ADDON_FILES),
    /** The oldest pipeline pack the add-on works with, when it needs one. */
    minPipelinePack: Semver.optional(),
  })
  .strict()
  .refine((m) => new Set(m.files.map((f) => f.path.toLowerCase())).size === m.files.length, {
    message: 'A file is listed twice.',
  })
  .refine((m) => m.files.reduce((s, f) => s + f.sizeBytes, 0) === m.sizeBytes, {
    message: 'sizeBytes is not the sum of the files.',
  });
export type AddonManifest = z.infer<typeof AddonManifest>;

export const AddonArchive = z
  .object({
    /** Absolute `https://` (or loopback `http://`) address, or a path relative to the base URL. */
    url: z.string().min(1).max(1000),
    sizeBytes: z.number().int().positive().max(MAX_ADDON_BYTES),
    sha256: Sha256,
  })
  .strict();
export type AddonArchive = z.infer<typeof AddonArchive>;

export const AddonCatalogueEntry = z
  .object({ manifest: AddonManifest, archive: AddonArchive })
  .strict();
export type AddonCatalogueEntry = z.infer<typeof AddonCatalogueEntry>;

export const AddonCatalogue = z
  .object({
    schema: z.literal(ADDON_CATALOGUE_SCHEMA),
    addons: z.array(AddonCatalogueEntry).max(100),
  })
  .strict();
export type AddonCatalogue = z.infer<typeof AddonCatalogue>;

/** The add-ons the app knows how to use, shown in Settings even before the catalogue is read. */
export const KNOWN_ADDONS: readonly { id: string; kind: AddonKind }[] = [
  { id: 'road-defects', kind: 'detector' },
  { id: 'segmentation', kind: 'segmenter' },
  { id: 'ground-classifier', kind: 'point-classifier' },
];

/** One row of Settings > Models and detection > Add-ons. */
export const AddonStatus = z.object({
  id: AddonId,
  kind: AddonKind,
  /** The installed add-on, when there is one. */
  installed: z
    .object({ manifest: AddonManifest, dir: z.string(), sizeBytes: z.number().int() })
    .nullable(),
  /** What the catalogue offers (absent when it could not be read). */
  available: AddonCatalogueEntry.nullable(),
  /** A newer version than the installed one is offered. */
  update: z.boolean(),
  /** Why it cannot be used or installed right now (old pipeline pack, offline only), or absent. */
  problem: z.string().optional(),
});
export type AddonStatus = z.infer<typeof AddonStatus>;

export const AddonListResponse = z.object({
  addons: z.array(AddonStatus),
  /** Where the catalogue was read from; null when no base URL is set. */
  baseUrl: z.string().nullable(),
  /** Why the catalogue could not be read (offline only, no address, a network error), or absent. */
  catalogueError: z.string().optional(),
});
export type AddonListResponse = z.infer<typeof AddonListResponse>;

/** Progress of `addons:install` / `addons:installFile`. */
export const AddonProgress = z.object({
  id: AddonId,
  phase: z.enum(['download', 'check', 'unpack', 'done', 'failed', 'cancelled']),
  bytesDone: z.number().nonnegative(),
  bytesTotal: z.number().nonnegative(),
  error: z.string().optional(),
});
export type AddonProgress = z.infer<typeof AddonProgress>;

export const AddonInstallResult = z.union([
  z.object({ ok: z.literal(true), manifest: AddonManifest }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.string(),
      code: z.enum(['busy', 'cancelled', 'refused', 'network', 'offline']).optional(),
    })
    .strict(),
]);
export type AddonInstallResult = z.infer<typeof AddonInstallResult>;

/** `classifier.json` of a `point-classifier` add-on: PDAL SMRF settings for ground (class 2). */
export const POINT_CLASSIFIER_SCHEMA = 'aio.point-classifier/1';
export const SmrfParams = z
  .object({
    /** Cell size, metres. */
    cell: z.number().min(0.1).max(20),
    /** Slope, rise over run. */
    slope: z.number().min(0.01).max(5),
    /** Largest window, metres. */
    window: z.number().min(1).max(200),
    /** Elevation threshold, metres. */
    threshold: z.number().min(0.05).max(10),
    /** Elevation scaling factor. */
    scalar: z.number().min(0).max(10),
  })
  .strict();
export type SmrfParams = z.infer<typeof SmrfParams>;
export const PointClassifier = z
  .object({
    schema: z.literal(POINT_CLASSIFIER_SCHEMA),
    method: z.literal('smrf'),
    smrf: SmrfParams,
  })
  .strict();
export type PointClassifier = z.infer<typeof PointClassifier>;
export const GROUND_CLASS = 2;
/**
 * What the window sends as `pointcloud.clean` noise `ground` to ask for ground: main replaces it
 * with the installed Ground classifier add-on's `smrf` (or refuses when there is none), so the
 * settings the pipeline uses always come from the add-on. PDAL's own SMRF defaults.
 */
export const GROUND_REQUEST: SmrfParams = {
  cell: 1,
  slope: 0.15,
  window: 18,
  threshold: 0.5,
  scalar: 1.25,
};
