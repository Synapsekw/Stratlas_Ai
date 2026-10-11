import { lastCapture } from '@aio/globe';
import type { GlobeSite } from '@aio/schema';
import { t } from '@aio/ui';

/** A site's facts in the search list and on its card: its last capture, its open issues, its tilesets. */
export function SiteFacts({ site, tilesets }: { site: GlobeSite; tilesets?: boolean }) {
  return (
    <span className="globe-facts">
      <span>{lastCapture(site) ?? t('globe.noCapture')}</span>
      <span data-tone={site.issues.open > 0 ? 'attention' : undefined}>
        {t('globe.openIssues', { count: site.issues.open })}
      </span>
      {tilesets && <span>{t('globe.tilesets', { count: site.tilesets.length })}</span>}
    </span>
  );
}
