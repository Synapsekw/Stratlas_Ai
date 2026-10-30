import type { MessageKey } from '@aio/ui';
import type { CoverageStatus } from '../../mapCoverage/plan';

/** The sentence for the open project's street map; a project outside the check (a demo) says how the check works. */
export function projectMapKey(status: CoverageStatus | undefined): MessageKey {
  switch (status) {
    case 'detail':
      return 'settings.project.maps.detail';
    case 'overview':
      return 'settings.project.maps.overview';
    case 'none':
      return 'settings.project.maps.none';
    case 'no-location':
      return 'settings.project.maps.noLocation';
    default:
      return 'settings.project.maps.unknown';
  }
}
