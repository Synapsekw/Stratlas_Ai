/**
 * The Globe's Map button and menu: the shared `MapMenu` over `globe.json` (base map, packs,
 * terrain, issue pins) and the person's online maps switch, with the key to the pins' colours
 * under On top. The menu stays open while a setting changes, so a map can be tried and changed
 * again; a press away or Esc closes it.
 */
import type { GlobeTierName } from '@aio/globe';
import {
  ONLINE_SOURCES,
  type BaseMapId,
  type GlobeSettings,
  type RasterPackInfo,
} from '@aio/schema';
import { t, useT } from '@aio/ui';
import { useMemo } from 'react';
import { MapMenu } from '../maps/MapMenu';
import { mapMenuModel, type OnTopKey } from '../maps/mapMenuModel';
import { bridge, shell, useShell } from '../shell';
import { pickBase } from '../workspace/onlineSatellite';
import { OnlineSatelliteNotice } from '../workspace/OnlineSatelliteNotice';
import { useRasterPacks } from '../workspace/siteTiles';
import { withBase } from './globeBase';
import './globe-map-menu.css';

export interface GlobeMenuProps {
  prefs: GlobeSettings;
  base: BaseMapId;
  packsOn: boolean;
  tier: GlobeTierName;
  imagery: readonly RasterPackInfo[];
  /** How many street map packs are installed: none shows the note that the Globe has no streets. */
  streetPacks: number;
  streetCredit: string;
  onSave: (next: GlobeSettings) => void;
}

export function GlobeMenu({
  prefs,
  base,
  packsOn,
  tier,
  imagery,
  streetPacks,
  streetCredit,
  onSave,
}: GlobeMenuProps) {
  useT();
  const enabled = useRasterPacks((s) => s.prefs.onlineSatellite);
  const keys = useRasterPacks((s) => s.online.keys);
  const offlineOnly = useShell((s) => s.settings.offlineOnly === true);
  const model = useMemo(
    () =>
      mapMenuModel(
        'globe',
        {
          base,
          onTop: {
            packs: packsOn,
            terrain: prefs.terrain !== 'off',
            issues: prefs.showIssues !== false,
          },
          pack: prefs.imagery && prefs.imagery !== 'auto' ? prefs.imagery : null,
        },
        ONLINE_SOURCES,
        { imagery: imagery.map((p) => ({ id: p.id, label: p.label })), terrain: 0 },
        { enabled, offlineOnly },
        keys,
        { terrainOffered: tier !== 'low', streetsCredit: streetCredit },
      ),
    [base, packsOn, prefs, imagery, enabled, offlineOnly, keys, tier, streetCredit],
  );
  const onToggle = (key: OnTopKey, on: boolean) => {
    if (key === 'packs') onSave(withBase(prefs, base, on));
    else if (key === 'terrain') onSave({ ...prefs, terrain: on ? 'auto' : 'off' });
    else if (key === 'issues') onSave({ ...prefs, showIssues: on });
  };
  return (
    <MapMenu
      model={model}
      testIds={{ chip: 'globe-map-button', pop: 'globe-map-menu' }}
      className="globe-map"
      chipClassName="globe-map-chip"
      place="free"
      onPick={(id) => {
        pickBase(id, (b) => {
          onSave(withBase(prefs, b, packsOn));
        });
      }}
      onToggle={onToggle}
      onPack={(id) => {
        onSave({ ...prefs, imagery: id ?? 'auto' });
      }}
      onOpenSources={() => {
        shell.getState().openSettingsPage('map-sources');
      }}
      onImproveMap={() => {
        void bridge.call('onlineTiles:openFeedback', { provider: 'mapbox' });
      }}
      notice={<OnlineSatelliteNotice className="mm-notice" />}
      extra={
        <>
          {streetPacks === 0 && <p className="mm-note">{t('globe.noStreetPacks')}</p>}
          <ul className="globe-key" aria-label={t('globe.key')}>
            <li data-tone="clear">
              <span className="globe-dot" aria-hidden="true" />
              {t('globe.keyClear')}
            </li>
            <li data-tone="attention">
              <span className="globe-dot" aria-hidden="true" />
              {t('globe.keyAttention')}
            </li>
          </ul>
        </>
      }
    />
  );
}
