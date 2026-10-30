/**
 * The 52 px rail (D1): the screens, then Processing, Help and Settings at its foot. Labels show
 * on hover and focus. The status dots leave it for the title bar.
 */
import { Icon, t, useT, type IconName, type MessageKey } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { help } from '../help/store';
import { processing, useProcessing } from '../processing/store';
import { shell, useShell } from '../shell';
import type { Screen } from '../store';

interface RailDef {
  screen: Screen;
  label: MessageKey;
  icon: IconName;
}

const TOP: readonly RailDef[] = [
  { screen: 'projects', label: 'nav.projects', icon: 'projects' },
  { screen: 'globe', label: 'globe.nav', icon: 'globe' },
  { screen: 'scene', label: 'nav.scene', icon: 'scene' },
  { screen: 'issues', label: 'nav.issues', icon: 'issues' },
  { screen: 'inspect', label: 'nav.inspect', icon: 'media' },
  { screen: 'reports', label: 'nav.reports', icon: 'report' },
];

function RailButton({
  icon,
  label,
  current,
  count,
  pressed,
  testId,
  onClick,
}: {
  icon: IconName;
  label: string;
  current?: boolean;
  count?: number | undefined;
  pressed?: boolean;
  testId?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="spk-rail-item"
      aria-label={label}
      aria-current={current ? 'page' : undefined}
      aria-pressed={pressed}
      data-testid={testId}
      onClick={onClick}
    >
      <Icon name={icon} size={20} />
      {count !== undefined && count > 0 && <span className="spk-rail-count">{count}</span>}
      <span className="spk-rail-tip" aria-hidden="true">
        {label}
      </span>
    </button>
  );
}

export function SpikeRail() {
  useT();
  const screen = useShell((s) => s.screen);
  const issues = useWorkspace((s) => (s.project ? s.issues.length : undefined));
  const drawer = useProcessing((s) => s.open);
  return (
    <nav className="spk-rail" aria-label={t('layoutSpike.rail')} data-testid="spike-rail">
      {TOP.map((d) => (
        <RailButton
          key={d.screen}
          icon={d.icon}
          label={t(d.label)}
          current={screen === d.screen}
          count={d.screen === 'issues' ? issues : undefined}
          testId={`spike-rail-${d.screen}`}
          onClick={() => {
            shell.getState().go(d.screen);
          }}
        />
      ))}
      <span className="spk-rail-fill" />
      <RailButton
        icon="refresh"
        label={t('layoutSpike.rail.processing')}
        pressed={drawer}
        onClick={() => {
          const p = processing.getState();
          if (p.open) p.closeDrawer();
          else p.openDrawer();
        }}
      />
      <RailButton
        icon="flag"
        label={t('layoutSpike.rail.help')}
        onClick={() => {
          help.getState().openHelp();
        }}
      />
      <RailButton
        icon="settings"
        label={t('nav.settings')}
        current={screen === 'settings'}
        onClick={() => {
          shell.getState().go('settings');
        }}
      />
    </nav>
  );
}
