import { brand } from '@aio/brand';
import { Icon } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { Fragment } from 'react';
import { shell, useShell } from '../shell';
import type { Screen } from '../store';

const VIEW_LABEL: Record<Screen, string> = {
  projects: 'Projects',
  scene: 'Scene',
  review: 'Original review',
  issues: 'Issues',
  media: 'Media',
  reports: 'Reports',
  jobs: 'Jobs',
  settings: 'Settings',
};

/** The Stratlas mark: four stacked strata, the top one in jade. */
export function BrandMark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 17.6h11.2l3-3.2H8z" fill="oklch(0.96 0.008 250 / .26)" />
      <path d="M4 13.3h11.2l3-3.2H7z" fill="oklch(0.96 0.008 250 / .55)" />
      <path d="M6 9h11.2l3-3.2H9z" fill="oklch(0.79 0.115 172)" />
      <path d="M3 21.9h11.2l3-3.2H6z" fill="oklch(0.96 0.008 250 / .12)" />
    </svg>
  );
}

export function TitleBar() {
  const screen = useShell((s) => s.screen);
  const cloudAi = useShell((s) => s.settings.cloudAi);
  const manifest = useWorkspace((s) => s.project?.manifest);

  const crumbs: string[] =
    manifest && screen !== 'projects' && screen !== 'settings'
      ? [manifest.customer ?? manifest.site ?? 'Project', manifest.name, VIEW_LABEL[screen]]
      : [screen === 'settings' ? brand.productName : brand.company, VIEW_LABEL[screen]];

  return (
    <header className="titlebar">
      <div className="brand">
        <BrandMark />
        <span className="wordmark">{brand.productName.toUpperCase()}</span>
      </div>
      <nav className="crumbs" aria-label="Location">
        {crumbs.map((c, i) => (
          <Fragment key={`${String(i)}-${c}`}>
            {i > 0 && <span className="sep">/</span>}
            {i === crumbs.length - 1 ? <b aria-current="page">{c}</b> : <span>{c}</span>}
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
        Search projects, layers, issues
        <span className="kbd">Ctrl K</span>
      </button>
      <div className="tb-status">
        <span
          className="chip-status"
          title="Runs with no network. Projects, maps and models are local."
        >
          <Icon name="offline" size={14} />
          Offline
        </span>
        <button
          type="button"
          className="chip-status"
          title={
            cloudAi
              ? 'Cloud AI is allowed. Change in Settings.'
              : 'Cloud AI is off. Change in Settings.'
          }
          onClick={() => {
            shell.getState().go('settings');
          }}
          data-testid="cloud-chip"
        >
          <span className={cloudAi ? 'dot' : 'dot off'} />
          {cloudAi ? 'Cloud AI' : 'Cloud AI off'}
        </button>
      </div>
    </header>
  );
}
