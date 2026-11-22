/**
 * Pure geometry for the selected antenna's measurements in the 3D view: its box corners, the
 * width / height / depth dimension lines and the label anchors (name, values, angles), all in the
 * local frame (x east, y up, z south) and moved by the survey date's line-up shift, exactly as the
 * box mesh in `antennaScene` is placed.
 */
import { shiftEN, type AntennaUnit, type DateShift, type Vec3 } from '@aio/schema';
import { t } from '@aio/ui';
import type { Frame } from '../survey/measureScene';
import { formatAngle, formatHeight, formatSize, trueAzimuth } from './antennaFormat';
import { isNotMeasured } from './antennaTyped';
import type { AntennaLabelSpot } from './antennaVisibility';

/** How far a dimension line sits off its box edge, metres. */
export const DIM_OFFSET_M = 0.08;
/** Length of the tick across each end of a dimension line, metres. */
export const DIM_TICK_M = 0.05;
/** A size as label text, the shared size format: '2.60 m'. */
const metres = (v: number): string =>
  t('telecom.antennas.label.metres', { value: formatSize(v, false) });
/** An altitude as label text, the shared height format the list uses: '31.2 m'. */
const altitude = (v: number): string =>
  t('telecom.antennas.label.metres', { value: formatHeight(v, false) });

/** Gap between the box top and its name label, metres. */
const NAME_LIFT_M = 0.3;

/** A project axis (E, N, Z) as a unit local direction: x = E, y = Z, z = -N. */
export function axisToLocal(a: Vec3): Vec3 {
  const v: Vec3 = [a[0], a[2], -a[1]];
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

const add = (p: Vec3, d: Vec3, s: number): Vec3 => [
  p[0] + d[0] * s,
  p[1] + d[1] * s,
  p[2] + d[2] * s,
];
/** The point a fraction `k` of the way from `a` to `b`. */
const lerp = (a: Vec3, b: Vec3, k: number): Vec3 => [
  a[0] + (b[0] - a[0]) * k,
  a[1] + (b[1] - a[1]) * k,
  a[2] + (b[2] - a[2]) * k,
];

/**
 * How far along its dimension line a value label sits. Not the middle: the drag handles stand on
 * the face centres, which a middle label would cover from most views.
 */
export const DIM_LABEL_AT = 0.2;

/** The box centre in the local frame, moved by the line-up shift. */
export function antennaCentre(unit: AntennaUnit, frame: Frame, shift: DateShift | null): Vec3 {
  return frame.toLocal(shiftEN(unit.box.centre, shift));
}

/**
 * The box's axes (across, up, outward) as local directions: the stored axes, also on a date lined
 * up with a turn, because the view does not turn a point cloud with its date (it moves it by the
 * shift only).
 */
export function boxAxes(unit: AntennaUnit): [Vec3, Vec3, Vec3] {
  const [x, y, z] = unit.box.axes;
  return [axisToLocal(x), axisToLocal(y), axisToLocal(z)];
}

/** A point of the box from its centre by signs along (across, up, outward): -1 .. 1 each. */
function boxPoint(unit: AntennaUnit, axes: readonly Vec3[], centre: Vec3, s: Vec3): Vec3 {
  const [w, h, d] = unit.box.extents;
  const [x, y, z] = axes as [Vec3, Vec3, Vec3];
  let p = add(centre, x, (s[0] * w) / 2);
  p = add(p, y, (s[1] * h) / 2);
  return add(p, z, (s[2] * d) / 2);
}

/** The 8 corners of the unit's box in the local frame; corner i has bit 0/1/2 = +across/up/out. */
export function antennaCorners(unit: AntennaUnit, frame: Frame, shift: DateShift | null): Vec3[] {
  const centre = antennaCentre(unit, frame, shift);
  const axes = boxAxes(unit);
  const corners: Vec3[] = [];
  for (let i = 0; i < 8; i++)
    corners.push(boxPoint(unit, axes, centre, [i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1]));
  return corners;
}

/**
 * The tip of the facing arrow (as `antennaScene` draws it): from the centre toward the grid
 * azimuth in the horizontal plane, clamp(height, 0.5, 5) m long. Null without an azimuth.
 */
export function facingTip(unit: AntennaUnit, centre: Vec3): Vec3 | null {
  if (!unit.azimuthGridDeg || isNotMeasured(unit)) return null;
  const az = (unit.azimuthGridDeg.value * Math.PI) / 180;
  const length = Math.max(0.5, Math.min(unit.heightM?.value ?? unit.box.extents[1], 5));
  return [centre[0] + Math.sin(az) * length, centre[1], centre[2] - Math.cos(az) * length];
}

/** Where the unit's name label sits: `NAME_LIFT_M` over the top of its box, above the centre. */
export function nameAnchor(unit: AntennaUnit, frame: Frame, shift: DateShift | null): Vec3 {
  const centre = antennaCentre(unit, frame, shift);
  const top = Math.max(...antennaCorners(unit, frame, shift).map((p) => p[1]));
  return [centre[0], top + NAME_LIFT_M, centre[2]];
}

/** The azimuth (true where the file has convergence) and downtilt, or elevation for a dish. */
function angleText(unit: AntennaUnit): string | null {
  const grid = unit.azimuthGridDeg;
  if (!grid) return null;
  const az =
    unit.convergenceDeg === null ? grid.value : trueAzimuth(grid.value, unit.convergenceDeg);
  const azText = formatAngle(az);
  if (unit.kind === 'dish' && unit.elevationDeg)
    return t('telecom.antennas.label.angleDish', {
      az: azText,
      elev: formatAngle(unit.elevationDeg.value),
    });
  if (unit.kind !== 'dish' && unit.downtiltDeg)
    return t('telecom.antennas.label.angle', {
      az: azText,
      tilt: formatAngle(unit.downtiltDeg.value),
    });
  return t('telecom.antennas.label.azimuth', { az: azText });
}

/** The centre altitude as the list's Alt m column has it: the typed value, else the box centre. */
function centreAltitude(unit: AntennaUnit): number {
  return unit.centreHeightM?.value ?? unit.box.centre[2];
}

/**
 * The name label: the name and the centre altitude, the same figure as the list's Alt m column
 * (the stored centre, not the drawn one: the line-up shift moves only east and north).
 */
function nameText(unit: AntennaUnit): string {
  const height = altitude(centreAltitude(unit));
  return isNotMeasured(unit)
    ? t('telecom.antennas.label.nameNotMeasured', { name: unit.name, height })
    : t('telecom.antennas.label.name', { name: unit.name, height });
}

/**
 * The selected unit's dimension lines and labels. Width runs along the box's across axis on its
 * top-front edge, pushed up and out, and height along its up axis on the right-front edge, pushed
 * out along the outward axis (so the width and depth labels stay apart); depth runs along the
 * outward axis on the bottom-right edge, pushed out to the right. Each line is `DIM_OFFSET_M` off
 * its edge with a `DIM_TICK_M` tick across each end. The height and depth values sit
 * `DIM_LABEL_AT` of the way along their lines (height from the bottom, depth from the back), clear
 * of the face centres where the drag handles are; the width value sits beside the line's right
 * end as seen from the front, so on a narrow panel it never meets the top face's arrow. A dish has a diameter, not three
 * sizes: one line across its top-front edge carries it, and nothing else.
 */
export function antennaMeasure(
  unit: AntennaUnit,
  frame: Frame,
  shift: DateShift | null,
): { segments: [Vec3, Vec3][]; spots: AntennaLabelSpot[] } {
  const centre = antennaCentre(unit, frame, shift);
  if (isNotMeasured(unit)) {
    // no sizes to draw: only the name, with what is missing said plainly
    return {
      segments: [],
      spots: [
        {
          key: `${unit.id}:name`,
          text: nameText(unit),
          at: nameAnchor(unit, frame, shift),
          kind: 'name',
          selected: true,
          align: 'above',
        },
      ],
    };
  }
  const axes = boxAxes(unit);
  const [across, up, out] = axes;
  const upOut: Vec3 = [out[0] + up[0], out[1] + up[1], out[2] + up[2]];
  const n = Math.hypot(...upOut) || 1;
  const pushUpOut: Vec3 = [upOut[0] / n, upOut[1] / n, upOut[2] / n];
  const at = (s: Vec3) => boxPoint(unit, axes, centre, s);
  // seen from the front (the outward face toward the eye), the +across end is on the right when
  // (across, up, outward) is right-handed; a file may hold either hand
  const cross: Vec3 = [
    across[1] * up[2] - across[2] * up[1],
    across[2] * up[0] - across[0] * up[2],
    across[0] * up[1] - across[1] * up[0],
  ];
  const rightHanded = cross[0] * out[0] + cross[1] * out[1] + cross[2] * out[2] >= 0;

  const top = { from: at([-1, 1, 1]), to: at([1, 1, 1]), push: pushUpOut };
  const lines: {
    key: string;
    from: Vec3;
    to: Vec3;
    push: Vec3;
    value: number | undefined;
  }[] =
    unit.kind === 'dish'
      ? [{ key: 'diameter', ...top, value: unit.diameterM?.value }]
      : [
          { key: 'w', ...top, value: unit.widthM?.value },
          {
            key: 'h',
            from: at([1, -1, 1]),
            to: at([1, 1, 1]),
            push: out,
            value: unit.heightM?.value,
          },
          {
            key: 'd',
            from: at([1, -1, -1]),
            to: at([1, -1, 1]),
            push: across,
            value: unit.depthM?.value,
          },
        ];

  const main: [Vec3, Vec3][] = [];
  const ticks: [Vec3, Vec3][] = [];
  const spots: AntennaLabelSpot[] = [];
  for (const l of lines) {
    // a size nobody measured or typed gets no line and no number
    if (l.value === undefined) continue;
    const a = add(l.from, l.push, DIM_OFFSET_M);
    const b = add(l.to, l.push, DIM_OFFSET_M);
    main.push([a, b]);
    for (const end of [a, b])
      ticks.push([add(end, l.push, -DIM_TICK_M / 2), add(end, l.push, DIM_TICK_M / 2)]);
    if (l.key === 'diameter') {
      // no handles on a dish: the value hangs under the middle of its line
      spots.push({
        key: `${unit.id}:dim:diameter`,
        text: t('telecom.antennas.label.diameter', { value: metres(l.value) }),
        at: lerp(a, b, 0.5),
        kind: 'dim',
        selected: true,
        align: 'below',
      });
      continue;
    }
    spots.push({
      key: `${unit.id}:dim:${l.key}`,
      text: metres(l.value),
      // the width sits beside its line's right end as seen from the front (`.sv-label`'s
      // offset: right and up), clear of the top face's arrow in the middle of the edge
      at: l.key === 'w' ? (rightHanded ? b : a) : lerp(a, b, DIM_LABEL_AT),
      kind: 'dim',
      selected: true,
    });
  }

  const tip = facingTip(unit, centre);
  const angle = angleText(unit);
  if (tip && angle)
    spots.push({ key: `${unit.id}:angle`, text: angle, at: tip, kind: 'angle', selected: true });

  spots.push({
    key: `${unit.id}:name`,
    text: nameText(unit),
    at: nameAnchor(unit, frame, shift),
    kind: 'name',
    selected: true,
    align: 'above',
  });

  return { segments: [...main, ...ticks], spots };
}
