import { useVolumetric, volumetric, type BodyMode, type SurfaceMode } from '@aio/volumetric';
import { PopTool, Tool } from './StageTools';

const SURFACES: { v: SurfaceMode; t: string; d: string }[] = [
  { v: 'photo', t: 'Photo', d: 'Orthomosaic draped on the terrain' },
  { v: 'elev', t: 'Elevation', d: 'Colour relief of the ground' },
  { v: 'change', t: 'Cut and fill', d: 'Height change between the first and last survey' },
];

const BODIES: { v: BodyMode; t: string; d: string }[] = [
  { v: 'lift', t: 'Lifted', d: 'Each volume floats above its base' },
  { v: 'place', t: 'In place', d: 'Volume tinted on the pile itself' },
  { v: 'off', t: 'Hidden', d: 'Terrain and toe lines only' },
];

/**
 * Stage tools of a volumetric project: survey date and swipe, surface colours, volume bodies and
 * the section line. State lives in the volumetric store (@aio/volumetric).
 */
export function VolumeTools() {
  const captures = useVolumetric((s) => s.file?.captures ?? []);
  const epoch = useVolumetric((s) => s.epoch);
  const swipe = useVolumetric((s) => s.swipe);
  const surface = useVolumetric((s) => s.surface);
  const body = useVolumetric((s) => s.body);
  const picking = useVolumetric((s) => s.section.mode !== 'idle');
  const editing = useVolumetric((s) => s.edit !== null);
  const v = volumetric.getState();
  return (
    <>
      <div className="seg vol-dates" role="group" aria-label="Survey date">
        {captures.map((c) => (
          <button
            key={c.epoch}
            type="button"
            aria-pressed={!swipe && surface !== 'change' && c.epoch === epoch}
            title={c.label}
            onClick={() => {
              if (surface === 'change') v.setSurface('photo');
              if (swipe) v.setSwipe(false);
              v.setEpoch(c.epoch);
            }}
          >
            {c.label.replace(/ 20\d\d$/, '')}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={swipe}
          disabled={captures.length < 2 || editing}
          title="Swipe between the first and last survey"
          onClick={() => {
            if (surface === 'change') v.setSurface('photo');
            v.setSwipe(!swipe);
          }}
        >
          Swipe
        </button>
      </div>
      <PopTool icon="raster" label="Surface colours" pressed={surface !== 'photo'}>
        <div className="pop-list" role="group" aria-label="Surface colours">
          {SURFACES.map((s) => (
            <button
              key={s.v}
              type="button"
              className="pop-item"
              aria-pressed={surface === s.v}
              disabled={s.v === 'change' && editing}
              onClick={() => {
                if (swipe) v.setSwipe(false);
                v.setSurface(s.v);
              }}
            >
              <b>{s.t}</b>
              <small>{s.d}</small>
            </button>
          ))}
        </div>
      </PopTool>
      <PopTool icon="pile" label="Volume bodies" pressed={body !== 'off'}>
        <div className="pop-list" role="group" aria-label="Volume bodies">
          {BODIES.map((b) => (
            <button
              key={b.v}
              type="button"
              className="pop-item"
              aria-pressed={body === b.v}
              onClick={() => {
                v.setBody(b.v);
              }}
            >
              <b>{b.t}</b>
              <small>{b.d}</small>
            </button>
          ))}
        </div>
      </PopTool>
      <Tool
        icon="path"
        label="Section line between the surveys"
        pressed={picking}
        disabled={editing}
        onClick={() => {
          if (picking) v.clearSection();
          else v.startSection();
        }}
      />
    </>
  );
}
