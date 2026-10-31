import { Icon, t, useT, type IconName, type MessageKey } from '@aio/ui';
import { brand } from '@aio/brand';
import { useWorkspace } from '@aio/workspace';
import { help, useHelp } from '../help/store';
import { processing, useProcessing } from '../processing/store';
import { shell, useShell } from '../shell';
import { isSidebarFolded, type Screen } from '../store';
import { photoUi } from '../photogrammetry/store';
import { WebsiteUpdateNotice } from '../updates/WebsiteUpdates';
import { BrandSymbol } from './BrandMark';
import { PanelHandle } from './PanelHandle';
import { useCanCreateMaps } from './SidebarProcessing';

/**
 * The Layers column's tab, on the Scene: at the main area's start, so it rides the column's inner
 * edge while the column shows and the rail's once it is folded. One element either way, so it
 * keeps the focus as the column folds (App.tsx mounts it in the main area).
 */
export function LayersHandle() {
  const scene = useShell((s) => s.screen === 'scene');
  const collapsed = useShell(isSidebarFolded);
  if (!scene) return null;
  return (
    <PanelHandle
      side="left"
      collapsed={collapsed}
      shortcut="global.sidebar"
      onToggle={() => {
        void shell.getState().toggleSidebar();
      }}
    />
  );
}

interface RailDef {
  screen: Screen;
  label: MessageKey;
  icon: IconName;
}

/** The screens, in the rail's order (D1). */
export const RAIL_SCREENS: readonly RailDef[] = [
  { screen: 'projects', label: 'nav.projects', icon: 'projects' },
  { screen: 'globe', label: 'globe.nav', icon: 'globe' },
  { screen: 'scene', label: 'nav.scene', icon: 'scene' },
  { screen: 'issues', label: 'nav.issues', icon: 'issues' },
  { screen: 'inspect', label: 'nav.inspect', icon: 'media' },
  { screen: 'reports', label: 'nav.reports', icon: 'report' },
];

/**
 * One rail button: its glyph, its name for screen readers and in a tip on hover and focus, and a
 * count where there is one (the open project's issues).
 */
function RailItem({
  icon,
  label,
  current,
  count,
  pressed,
  testId,
  keys,
  onClick,
}: {
  icon: IconName;
  label: string;
  current?: boolean;
  count?: number | undefined;
  pressed?: boolean;
  testId?: string;
  keys?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="nav-item"
      aria-current={current ? 'page' : undefined}
      aria-pressed={pressed}
      aria-keyshortcuts={keys}
      data-testid={testId}
      onClick={onClick}
    >
      <Icon name={icon} />
      <span className="lbl">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="count" aria-hidden="true">
          {count > 99 ? '99+' : count}
        </span>
      )}
      <span className="tip" aria-hidden="true">
        {label}
      </span>
    </button>
  );
}

/**
 * The 52 px rail on every screen (UI revision W11, D1): the logo, the screens, then at its foot
 * the Processing group (the drawer, and **Create maps from photos** whenever a project may make
 * maps: in sight on every screen and with Layers folded, founder 31 Oct 2026), the user guide and
 * Settings. Names show as tips on hover and focus. It never folds: the Layers column beside it
 * does (Ctrl+B, Ctrl+L).
 */
export function Rail() {
  useT();
  const screen = useShell((s) => s.screen);
  const issues = useWorkspace((s) => (s.project ? s.issues.length : undefined));
  const drawer = useProcessing((s) => s.open);
  const guide = useHelp((s) => s.open);
  const library = useShell((s) => s.library?.length);
  const canMake = useCanCreateMaps();
  return (
    <nav className="rail" aria-label={t('nav.primary')} data-testid="rail">
      <span className="rail-logo" data-testid="brand-mark">
        <BrandSymbol small label={brand.productName} />
      </span>
      <div className="sb-nav" role="group" aria-label={t('nav.sections')}>
        {RAIL_SCREENS.map((d) => (
          <RailItem
            key={d.screen}
            icon={d.icon}
            label={t(d.label)}
            current={screen === d.screen}
            count={d.screen === 'issues' ? issues : d.screen === 'projects' ? library : undefined}
            testId={`rail-${d.screen}`}
            onClick={() => {
              shell.getState().go(d.screen);
            }}
          />
        ))}
      </div>
      <span className="rail-fill" />
      <div className="rail-foot">
        <WebsiteUpdateNotice />
        <div
          className="rail-proc"
          role="group"
          aria-label={t('processing.title')}
          data-testid="rail-processing-group"
        >
          <RailItem
            icon="refresh"
            label={t('nav.processing')}
            pressed={drawer}
            testId="rail-processing"
            onClick={() => {
              const p = processing.getState();
              if (p.open) p.closeDrawer();
              else p.openDrawer();
            }}
          />
          {canMake && (
            <RailItem
              icon="photo"
              label={t('processing.createMaps')}
              testId="rail-create-maps"
              onClick={() => {
                photoUi.getState().openWizard();
              }}
            />
          )}
        </div>
        <RailItem
          icon="flag"
          label={t('nav.help')}
          pressed={guide}
          keys="F1"
          testId="help-open"
          onClick={() => {
            const h = help.getState();
            if (h.open) h.closeHelp();
            else h.openHelp();
          }}
        />
        <RailItem
          icon="settings"
          label={t('nav.settings')}
          current={screen === 'settings'}
          testId="rail-settings"
          onClick={() => {
            shell.getState().go('settings');
          }}
        />
      </div>
    </nav>
  );
}
