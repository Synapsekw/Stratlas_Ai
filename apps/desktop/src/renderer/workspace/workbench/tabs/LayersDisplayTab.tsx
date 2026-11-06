/**
 * Layers & display (D2): Display, Point cloud, Terrain overlays and Section planes, and at its foot
 * "Reset layout to project defaults" (D7): the tab, strip, island mode, view and Layers column the
 * project's type opens on.
 */
import { Button, Icon, Tip, useT } from '@aio/ui';
import { resetLayout } from '../../../layout/useApplyPreset';
import { PanelSections } from './PanelSections';

function ResetLayout() {
  const t = useT();
  return (
    <div className="wb-layout-foot">
      <Tip content={t('wb.layout.resetTip')} placement="top">
        <Button variant="quiet" data-testid="layout-reset" onClick={resetLayout}>
          <Icon name="undo" size={14} />
          {t('wb.layout.reset')}
        </Button>
      </Tip>
    </div>
  );
}

export function LayersDisplayTab() {
  return <PanelSections tab="layers" foot={<ResetLayout />} />;
}
