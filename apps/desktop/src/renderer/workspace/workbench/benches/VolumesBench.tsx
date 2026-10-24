/**
 * The Volumes workbench, the fixed `volumes` tab (volumetrics redesign, spec section 6, board 1):
 * on Inventory the header (the date in focus, Volume, Tonnes, the change since the previous
 * survey, Export), then the segmented Inventory | Cut & fill | Materials and the pane it picks.
 * The pane is the one `volumesPane` store, which the stage's Show control, the sidebar's
 * Stockpiles group and the Measure tab's Site materials entry read and write too.
 *
 * A pile picked anywhere (a row here, 3D, the map, the sidebar) opens in the pile panel in place
 * of all of it, with "‹ Inventory" back. The surface, date, bodies and section line switches the
 * tab used to carry are gone: the stage's Show control and the notch carry them. The tab is at
 * least 470 px wide (D17, the workbench store's `minWidth`).
 */
import { inventoryPiles } from '@aio/survey';
import { useT, type MessageKey } from '@aio/ui';
import { useMemo, type ReactElement } from 'react';
import { useStore } from 'zustand';
import { useMeasure } from '../../../survey/measureStore';
import { openPile } from '../../../survey/pile/openPile';
import { PilePanel } from '../../../survey/pile/PilePanel';
import { CutFillPane } from '../../../survey/volumes/CutFillPane';
import {
  InventoryPane,
  inventoryOrder,
  useInventoryModel,
  useSeriesRun,
  VolumesEmpty,
} from '../../../survey/volumes/InventoryPane';
import { MaterialsPane } from '../../../survey/volumes/MaterialsPane';
import { VolumesHeader } from '../../../survey/volumes/VolumesHeader';
import { volumesPane, type VolumesPane } from '../../../survey/volumes/volumesPane';
import './benches.css';

const PANES: readonly { id: VolumesPane; label: MessageKey }[] = [
  { id: 'inventory', label: 'volumes.segment.inventory' },
  { id: 'cutFill', label: 'volumes.segment.cutFill' },
  { id: 'materials', label: 'volumes.segment.materials' },
];

function Segments({ pane }: { pane: VolumesPane }): ReactElement {
  const t = useT();
  return (
    <div className="seg vb-seg" role="group" aria-label={t('wb.tab.volumes')}>
      {PANES.map((p) => (
        <button
          key={p.id}
          type="button"
          aria-pressed={pane === p.id}
          data-testid="volumes-segment"
          data-pane={p.id}
          onClick={() => {
            volumesPane.getState().setPane(p.id);
          }}
        >
          {t(p.label)}
        </button>
      ))}
    </div>
  );
}

export function VolumesBench(): ReactElement {
  const file = useMeasure((s) => s.file);
  const focus = useMeasure((s) => s.focus);
  const pane = useStore(volumesPane, (s) => s.pane);
  const piles = useMemo(() => inventoryPiles(file.measurements), [file]);
  // every pile's dates are worked out while the tab is up, whichever pane shows
  useSeriesRun(piles);
  const model = useInventoryModel(piles);
  const focused = piles.find((m) => m.id === focus) ?? null;

  return (
    <div className="vol-bench" data-testid="volumes-bench">
      <div
        className={['vb-view', 'ctx-fill', focused ? 'vb-open' : ''].filter(Boolean).join(' ')}
        data-testid="volumes-view"
      >
        {focused ? (
          <PilePanel id={focused.id} order={inventoryOrder(model, piles)} />
        ) : (
          <>
            {pane === 'inventory' && piles.length > 0 && (
              <VolumesHeader model={model} piles={piles} />
            )}
            <Segments pane={pane} />
            {pane === 'cutFill' ? (
              <CutFillPane onPile={openPile} />
            ) : pane === 'materials' ? (
              <MaterialsPane />
            ) : piles.length === 0 ? (
              <VolumesEmpty />
            ) : (
              <InventoryPane model={model} piles={piles} onPile={openPile} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
