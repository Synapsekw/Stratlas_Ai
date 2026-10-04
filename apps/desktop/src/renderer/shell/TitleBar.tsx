import { brand } from '@aio/brand';
import { Icon, t, useT, type MessageKey } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { Fragment } from 'react';
import { cloudAiBlocked } from '../player';
import { shell, useShell } from '../shell';
import type { Screen } from '../store';

const VIEW_LABEL: Record<Screen, MessageKey> = {
  projects: 'nav.projects',
  welcome: 'nav.welcome',
  scene: 'nav.scene',
  review: 'nav.review',
  issues: 'nav.issues',
  media: 'nav.media',
  detections: 'nav.detections',
  reports: 'nav.reports',
  jobs: 'nav.jobs',
  settings: 'nav.settings',
};

/** The Stratlas mark: four stacked strata, the top one in jade. */
export function BrandMark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 17.6h11.2l3-3.2H8z" fill="var(--fg-0)" fillOpacity={0.26} />
      <path d="M4 13.3h11.2l3-3.2H7z" fill="var(--fg-0)" fillOpacity={0.55} />
      <path d="M6 9h11.2l3-3.2H9z" fill="var(--acc)" />
      <path d="M3 21.9h11.2l3-3.2H6z" fill="var(--fg-0)" fillOpacity={0.12} />
    </svg>
  );
}

export function TitleBar() {
  useT();
  const screen = useShell((s) => s.screen);
  const cloudSetting = useShell((s) => s.settings.cloudAi);
  const pkg = useShell((s) => s.pkg);
  const blocked = cloudAiBlocked(pkg);
  const cloudAi = cloudSetting && !blocked;
  const manifest = useWorkspace((s) => s.project?.manifest);

  const crumbs: string[] =
    manifest && screen !== 'projects' && screen !== 'settings'
      ? [
          manifest.customer ?? manifest.site ?? t('titlebar.project'),
          manifest.name,
          t(VIEW_LABEL[screen]),
        ]
      : [screen === 'settings' ? brand.productName : brand.company, t(VIEW_LABEL[screen])];

  return (
    <header className="titlebar">
      <div className="brand">
        <BrandMark />
        <span className="wordmark">{brand.productName.toUpperCase()}</span>
      </div>
      <nav className="crumbs" aria-label={t('titlebar.location')}>
        {crumbs.map((c, i) => (
          <Fragment key={`${String(i)}-${c}`}>
            {i > 0 && <span className="sep">/</span>}
            {i === crumbs.length - 1 ? (
              <b aria-current="page" dir="auto">
                {c}
              </b>
            ) : (
              <span dir="auto">{c}</span>
            )}
          </Fragment>
        ))}
      </nav>
      <div className="tb-spacer" />
      <button
        className="search-btn"
        type="button"
        onClick={() => {
          shell.getState().setPalette(true);
        }}
        aria-keyshortcuts="Control+K"
      >
        <Icon name="search" size={14} />
        {t('titlebar.search')}
        <span className="kbd">Ctrl K</span>
      </button>
      <div className="tb-status">
        {pkg && (
          <span
            className="chip-status ro"
            title={t(pkg.header.readOnly ? 'titlebar.readOnlyPackageTip' : 'titlebar.packageTip', {
              file: pkg.file,
            })}
            data-testid="readonly-chip"
          >
            <Icon name="lock" size={14} />
            {t(pkg.header.readOnly ? 'titlebar.readOnlyPackage' : 'titlebar.package')}
          </span>
        )}
        <span className="chip-status" title={t('titlebar.offlineTip')}>
          <Icon name="offline" size={14} />
          {t('titlebar.offline')}
        </span>
        <button
          type="button"
          className="chip-status"
          title={t(
            blocked
              ? 'titlebar.cloudBlockedTip'
              : cloudAi
                ? 'titlebar.cloudOnTip'
                : 'titlebar.cloudOffTip',
          )}
          onClick={() => {
            shell.getState().go('settings');
          }}
          data-testid="cloud-chip"
        >
          <span className={cloudAi ? 'dot' : 'dot off'} />
          {t(
            blocked && cloudSetting
              ? 'titlebar.cloudBlocked'
              : cloudAi
                ? 'titlebar.cloudOn'
                : 'titlebar.cloudOff',
          )}
        </button>
      </div>
    </header>
  );
}
