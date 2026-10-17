import { useVolumetric, volumetric, type BodyMode, type SurfaceMode } from '@aio/volumetric';
import { PopTool, Tool } from './StageTools';
import { surveyDateLabel } from './surveyDateLabel';

const SURFACES: { v: SurfaceMode; t: string; d: string }[] = [
  { v: 'photo', t: 'Photo', d: 'Orthomosaic draped on the terrain' },
  { v: 'elev', t: 'Elevation', d: 'Colour relief of the ground' },
  { v: 'change', t: 'Cut / fill', d: 'Height change between the first and last survey' },
];

const BODIES: { v: BodyMode; t: string; d: string }[] = [
  { v: 'lift', t: 'Lifted', d: 'Each volume floats above its base' },
  { v: 'place', t: 'In place', d: 'Volume tinted on the pile itself' },
  { v: 'off', t: 'Hidden', d: 'Terrain and toe lines only' },
];

const NO_CAPTURES: readonly { epoch: string; date: string; label: string }[] = [];

/** The survey dates and Swipe, one switch. */
export function VolumeDateSwipe() {
  const captures = useVolumetric((s) => s.file?.captures ?? NO_CAPTURES);
  const epoch = useVolumetric((s) => s.epoch);
  const swipe = useVolumetric((s) => s.swipe);
  const surface = useVolumetric((s) => s.surface);
  const editing = useVolumetric((s) => s.edit !== null);
  const v = volumetric.getState();
  return (
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
          {surveyDateLabel(c)}
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
  );
}

/** The surface colours: photo, elevation, cut and fill. */
export function VolumeSurfaces() {
  const swipe = useVolumetric((s) => s.swipe);
  const surface = useVolumetric((s) => s.surface);
  const editing = useVolumetric((s) => s.edit !== null);
  const v = volumetric.getState();
  return (
    <div className="seg vol-surface" role="group" aria-label="Surface colours">
      {SURFACES.map((s) => (
        <button
          key={s.v}
          type="button"
          aria-pressed={surface === s.v}
          title={s.d}
          disabled={s.v === 'change' && editing}
          onClick={() => {
            if (swipe) v.setSwipe(false);
            v.setSurface(s.v);
          }}
        >
          {s.t}
        </button>
      ))}
    </div>
  );
}

/** The volume bodies choice: each with its line of explanation, or `compact`, one switch. */
export function VolumeBodies({ compact = false }: { compact?: boolean }) {
  const body = useVolumetric((s) => s.body);
  const v = volumetric.getState();
  if (compact)
    return (
      <div className="seg vol-bodies" role="group" aria-label="Volume bodies">
        {BODIES.map((b) => (
          <button
            key={b.v}
            type="button"
            aria-pressed={body === b.v}
            onClick={() => {
              v.setBody(b.v);
            }}
          >
            {b.t}
          </button>
        ))}
      </div>
    );
  return (
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
  );
}

/** Start or clear the section line between the surveys. */
export function toggleVolumeSection(): void {
  const s = volumetric.getState();
  if (s.section.mode !== 'idle') s.clearSection();
  else s.startSection();
}

export const SECTION_LINE_LABEL = 'Section line between the surveys';

/**
 * Stage tools of a volumetric project: survey date and swipe, surface colours (photo, elevation,
 * cut and fill, always on the toolbar), volume bodies and the section line. State lives in the volumetric store (@aio/volumetric).
 */
export function VolumeTools() {
  const body = useVolumetric((s) => s.body);
  const picking = useVolumetric((s) => s.section.mode !== 'idle');
  const editing = useVolumetric((s) => s.edit !== null);
  return (
    <>
      <VolumeDateSwipe />
      <VolumeSurfaces />
      <PopTool icon="pile" label="Volume bodies" pressed={body !== 'off'}>
        <VolumeBodies />
      </PopTool>
      <Tool
        icon="path"
        label={SECTION_LINE_LABEL}
        pressed={picking}
        disabled={editing}
        onClick={toggleVolumeSection}
      />
    </>
  );
}
