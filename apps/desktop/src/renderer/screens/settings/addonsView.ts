/**
 * What a row of Settings, Models and detection, Add-ons says: the name (the manifest's, else the
 * app's own word for a known add-on), what it does, the version, licence and size, which button it
 * offers and the progress line of a running install. Pure, so it is tested without a window.
 */
import type { AddonKind, AddonProgress, AddonStatus } from '@aio/schema';
import { formatBytes, t, type MessageKey } from '@aio/ui';

const KNOWN_NAME: Readonly<Record<string, MessageKey>> = {
  'road-defects': 'detect.addons.name.roadDefects',
  segmentation: 'detect.addons.name.segmentation',
  'ground-classifier': 'detect.addons.name.groundClassifier',
};

const WHAT: Readonly<Record<AddonKind, MessageKey>> = {
  detector: 'detect.addons.what.detector',
  segmenter: 'detect.addons.what.segmenter',
  'point-classifier': 'detect.addons.what.pointClassifier',
};

const manifestOf = (s: AddonStatus) => s.installed?.manifest ?? s.available?.manifest ?? null;

export function addonName(s: AddonStatus): string {
  const m = manifestOf(s);
  if (m) return m.name;
  const key = KNOWN_NAME[s.id];
  return key ? t(key) : s.id;
}

export const addonWhat = (kind: AddonKind): string => t(WHAT[kind]);

/** The version, licence and size line: installed figures once installed, else the offer's. */
export function addonFacts(s: AddonStatus): {
  version: string | null;
  licence: string | null;
  size: string | null;
} {
  const m = manifestOf(s);
  return {
    version: s.installed?.manifest.version ?? s.available?.manifest.version ?? null,
    licence: m?.licence ?? null,
    size: s.installed
      ? formatBytes(s.installed.sizeBytes)
      : s.available
        ? formatBytes(s.available.archive.sizeBytes)
        : null,
  };
}

/** The button of a row: Download (with the archive size), Update, or none. */
export function addonOffer(s: AddonStatus): { kind: 'download' | 'update'; label: string } | null {
  if (!s.available) return null;
  const size = formatBytes(s.available.archive.sizeBytes);
  if (!s.installed) return { kind: 'download', label: t('detect.addons.download', { size }) };
  if (s.update)
    return {
      kind: 'update',
      label: t('detect.addons.update', { version: s.available.manifest.version, size }),
    };
  return null;
}

/** The sentence over the progress bar and how far it is (null: no figure to show). */
export function addonProgressText(p: AddonProgress | null): { text: string; pct: number | null } {
  if (!p) return { text: t('detect.addons.progress.starting'), pct: null };
  if (p.phase === 'download') {
    if (p.bytesTotal <= 0) return { text: t('detect.addons.progress.starting'), pct: null };
    const done = Math.min(p.bytesDone, p.bytesTotal);
    return {
      text: t('detect.addons.progress.download', {
        done: formatBytes(done),
        total: formatBytes(p.bytesTotal),
      }),
      pct: Math.round((done / p.bytesTotal) * 100),
    };
  }
  if (p.phase === 'check') return { text: t('detect.addons.progress.check'), pct: 100 };
  if (p.phase === 'unpack') {
    const pct =
      p.bytesTotal > 0
        ? Math.round((Math.min(p.bytesDone, p.bytesTotal) / p.bytesTotal) * 100)
        : null;
    return { text: t('detect.addons.progress.unpack'), pct };
  }
  return { text: t('detect.addons.progress.finishing'), pct: 100 };
}
