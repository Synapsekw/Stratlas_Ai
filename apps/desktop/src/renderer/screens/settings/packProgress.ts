/** The progress line of a pack install, shared by the processing tools and the Analytics pack. */
import type { PackInstallProgress } from '@aio/schema';
import { formatBytes, t } from '@aio/ui';

/**
 * The sentence under the progress bar, and how far it is (null: no figure to show). `label` is
 * what shows before the first figure arrives.
 */
export function progressText(
  p: PackInstallProgress | null,
  label: string = t('tools.progress.label'),
): { text: string; pct: number | null } {
  if (!p || p.phase === 'unpack') {
    const total = p?.bytesTotal ?? 0;
    const done = Math.min(p?.bytesDone ?? 0, total);
    if (total <= 0) return { text: label, pct: null };
    const files = t('tools.progress.files', { files: (p?.entries ?? 0).toLocaleString('en-US') });
    return {
      text: `${t('tools.progress.unpack', { done: formatBytes(done), total: formatBytes(total) })}, ${files}`,
      pct: Math.round((done / total) * 100),
    };
  }
  if (p.phase === 'check') return { text: t('tools.progress.check'), pct: 100 };
  return { text: t('tools.progress.activate'), pct: 100 };
}
