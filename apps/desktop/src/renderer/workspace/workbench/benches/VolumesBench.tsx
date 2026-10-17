/**
 * The Volumes workbench, the fixed `volumes` tab (stage island D12): the survey date and Swipe,
 * the surface colours, the volume bodies and the section line above the stockpile inventory
 * (`VolumesPanel`). The switches are the stage toolbar's own (workspace/VolumeTools.tsx), so their
 * names ("Cut / fill" and the rest) are unchanged. The tab is at least 470 px wide (D17, the
 * workbench store's `minWidth`).
 */
import { Button } from '@aio/ui';
import { useVolumetric, VolumesPanel } from '@aio/volumetric';
import {
  SECTION_LINE_LABEL,
  toggleVolumeSection,
  VolumeBodies,
  VolumeDateSwipe,
  VolumeSurfaces,
} from '../../VolumeTools';
import './benches.css';

export function VolumesBench() {
  const picking = useVolumetric((s) => s.section.mode !== 'idle');
  const editing = useVolumetric((s) => s.edit !== null);
  return (
    <div className="vol-bench" data-testid="volumes-bench">
      <div className="vol-bench-controls">
        <VolumeDateSwipe />
        <VolumeSurfaces />
        <VolumeBodies compact />
        <Button icon="path" pressed={picking} disabled={editing} onClick={toggleVolumeSection}>
          {SECTION_LINE_LABEL}
        </Button>
      </div>
      <VolumesPanel className="ctx-fill" />
    </div>
  );
}
