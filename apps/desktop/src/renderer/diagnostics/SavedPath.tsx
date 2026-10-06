import { t } from '@aio/ui';

/** "Saved to <path>. Attach that file ..." with the path in monospace. */
export function SavedPath({ path }: { path: string }) {
  const [before = '', after = ''] = t('diag.saved').split('{path}');
  return (
    <span data-testid="diagnostics-saved">
      {before}
      <span className="mono">{path}</span>
      {after}
    </span>
  );
}
