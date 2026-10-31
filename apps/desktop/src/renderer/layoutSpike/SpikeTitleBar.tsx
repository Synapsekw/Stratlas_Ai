/**
 * The 40 px title bar (D1): Layers toggle, the breadcrumb "Customer > Project > Date" with full
 * names, then search, the connection and AI status (where W2's one AI chip goes), the Jobs chip
 * and the window buttons' room. The preset picker and the stage share readout are the spike's
 * own: they let the founder try the seven presets and read the stage's share of the window.
 */
import { PURPOSE_TYPE, type ProjectPurpose } from '@aio/schema';
import { Button, Icon, IconButton, Tip, t, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { ProcessingChip } from '../processing/ProcessingChip';
import { shell } from '../shell';
import { PANEL_ID, panelHandleLabel } from '../shell/PanelHandle';
import { AiStatusChip } from '../shell/AiStatusChip';
import { DatePicker } from '../workspace/DatePicker';
import { toggleLayoutSpike } from './flag';
import { PURPOSES } from './model';
import { spike, useSpike } from './spikeStore';

export function SpikeTitleBar({
  own,
  layersOpen,
  rightOpen,
  share,
}: {
  /** The project's own preset (its purpose, else its type's fallback). */
  own: ProjectPurpose;
  layersOpen: boolean;
  /** The right panel shows (the shell's `rightCollapsed`, folded as today's is). */
  rightOpen: boolean;
  /** The stage's share of the window width, in per cent (null until measured). */
  share: number | null;
}) {
  useT();
  const manifest = useWorkspace((s) => s.project?.manifest);
  const pick = useSpike((s) => s.pick);
  const dated = useWorkspace((s) => (s.project?.manifest.captures.length ?? 0) > 0);
  const slots = useSpike((s) => s.slots);
  const customer = manifest?.customer ?? manifest?.site?.split(',').pop()?.trim();
  const ownName = t(`layoutSpike.preset.${own}`);
  return (
    <header className="spk-title" aria-label={t('layoutSpike.titlebar')} data-testid="spike-title">
      <IconButton
        icon="sidebar"
        label={t('layoutSpike.toggleLayers')}
        tip={t('layoutSpike.toggleLayers')}
        shortcut="global.sidebar"
        pressed={layersOpen}
        data-testid="spike-layers-toggle"
        onClick={() => {
          spike.getState().setLayers(!layersOpen);
        }}
      />
      <nav className="spk-crumbs" aria-label={t('layoutSpike.breadcrumb')}>
        <span className="spk-crumb-customer">{customer ?? t('layoutSpike.noCustomer')}</span>
        <span className="spk-crumb-sep" aria-hidden="true">
          /
        </span>
        <button
          type="button"
          className="spk-crumb-project"
          data-testid="spike-crumb-project"
          onClick={() => {
            shell.getState().go('projects');
          }}
        >
          {manifest?.name}
        </button>
        {dated && (
          <>
            <span className="spk-crumb-sep" aria-hidden="true">
              /
            </span>
            <DatePicker />
          </>
        )}
      </nav>
      <span className="spk-title-fill" />
      {/* debug readout: only while the overlay slots are outlined */}
      {slots && share !== null && (
        <Tip content={t('layoutSpike.stageShareTip')}>
          <span className="spk-share mono" tabIndex={0} data-testid="spike-stage-share">
            {t('layoutSpike.stageShare', { pct: String(share) })}
          </span>
        </Tip>
      )}
      <Tip content={t('layoutSpike.presetNote')}>
        <label className="spk-preset">
          <span className="sr-only">{t('layoutSpike.preset')}</span>
          <select
            className="input"
            data-testid="spike-preset"
            value={pick ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              spike.getState().pickPreset(v === '' ? null : (v as ProjectPurpose));
            }}
          >
            <option value="">{t('layoutSpike.presetFromProject', { name: ownName })}</option>
            {PURPOSES.map((p) => (
              <option key={p} value={p} data-type={PURPOSE_TYPE[p]}>
                {t(`layoutSpike.preset.${p}`)}
              </option>
            ))}
          </select>
        </label>
      </Tip>
      <IconButton
        icon="target"
        label={t('layoutSpike.slots')}
        pressed={slots}
        data-testid="spike-slots"
        onClick={() => {
          spike.getState().setSlots(!slots);
        }}
      />
      <IconButton
        icon="search"
        label={t('layoutSpike.search')}
        shortcut="global.palette"
        onClick={() => {
          shell.getState().setPalette(true);
        }}
      />
      {/* where W2's one AI chip goes: today's cloud AI chip stands in for it */}
      <span className="spk-status" role="group" aria-label={t('layoutSpike.aiChip')}>
        <AiStatusChip store={shell} className="spk-ai" testId="spike-ai-chip" placement="bottom" />
      </span>
      <ProcessingChip />
      {/* the right panel's fold, as on today's stage (Ctrl+Alt+B) */}
      <Button
        variant="icon"
        pressed={rightOpen}
        aria-label={t(panelHandleLabel('right', !rightOpen))}
        aria-controls={PANEL_ID.right}
        tip={t(panelHandleLabel('right', !rightOpen))}
        shortcut="global.rightPanel"
        data-testid="spike-right-toggle"
        onClick={shell.getState().toggleRight}
      >
        <Icon name="sidebar" size={16} className="flip" />
      </Button>
      <Tip content={t('layoutSpike.badgeTip')}>
        <button
          type="button"
          className="spk-badge"
          data-testid="spike-badge"
          aria-keyshortcuts="Control+Alt+L"
          onClick={() => {
            toggleLayoutSpike();
          }}
        >
          {t('layoutSpike.badge')}
        </button>
      </Tip>
    </header>
  );
}
