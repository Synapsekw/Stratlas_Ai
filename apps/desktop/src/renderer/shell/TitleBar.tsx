import { brand } from '@aio/brand';
import { ariaKeys, formatDate, Icon, shortcutHint, t, useT, type MessageKey } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { Fragment } from 'react';
import { cloudAiBlocked } from '../player';
import { shell, useShell } from '../shell';
import type { Screen } from '../store';
import { help } from '../help/store';
import { SyncStatus } from '../team/SyncStatus';
import { BrandSymbol, BrandWordmark } from './BrandMark';

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

export function TitleBar() {
  useT();
  const screen = useShell((s) => s.screen);
  const cloudSetting = useShell((s) => s.settings.cloudAi);
  const pkg = useShell((s) => s.pkg);
  const origin = useShell((s) => s.origin);
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
        <BrandSymbol small />
        <BrandWordmark />
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
        aria-keyshortcuts={ariaKeys('global.palette')}
      >
        <Icon name="search" size={14} />
        {t('titlebar.search')}
        <span className="kbd">{shortcutHint('global.palette')}</span>
      </button>
      <button
        className="help-btn"
        type="button"
        onClick={() => {
          help.getState().openHelp();
        }}
        aria-keyshortcuts="F1"
        aria-label={t('help.open')}
        title={t('help.open')}
        data-testid="help-open"
      >
        ?
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
        {!pkg && origin && (
          <span
            className="chip-status"
            title={t('titlebar.copyOfTip', {
              file: origin.package,
              exported: formatDate(origin.exportedAt),
              extracted: formatDate(origin.extractedAt),
            })}
            data-testid="origin-chip"
          >
            <Icon name="copy" size={14} />
            {t('titlebar.copyOf', { file: origin.package })}
          </span>
        )}
        <SyncStatus />
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
