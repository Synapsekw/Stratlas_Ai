/**
 * Pure geometry for the selected antenna's measurements in the 3D view: its box corners, the
 * width / height / depth dimension lines and the label anchors (name, values, angles), all in the
 * local frame (x east, y up, z south) and moved by the survey date's line-up shift, exactly as the
 * box mesh in `antennaScene` is placed.
 */
import { shiftEN, type AntennaUnit, type DateShift, type Vec3 } from '@aio/schema';
import { t } from '@aio/ui';
import type { Frame } from '../survey/measureScene';
import { formatDeg, trueAzimuth } from './antennaFormat';
import type { AntennaLabelSpot } from './antennaVisibility';

/** How far a dimension line sits off its box edge, metres. */
export const DIM_OFFSET_M = 0.08;
/** Length of the tick across each end of a dimension line, metres. */
export const DIM_TICK_M = 0.05;
/** A length as label text: '2.60 m'. */
const metres = (v: number): string => t('telecom.antennas.label.metres', { value: v.toFixed(2) });

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
const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

/** The box centre in the local frame, moved by the line-up shift. */
export function antennaCentre(unit: AntennaUnit, frame: Frame, shift: DateShift | null): Vec3 {
  return frame.toLocal(shiftEN(unit.box.centre, shift));
}

/** A point of the box from its centre by signs along (across, up, outward): -1 .. 1 each. */
function boxPoint(unit: AntennaUnit, centre: Vec3, s: Vec3): Vec3 {
  const [w, h, d] = unit.box.extents;
  let p = add(centre, axisToLocal(unit.box.axes[0]), (s[0] * w) / 2);
  p = add(p, axisToLocal(unit.box.axes[1]), (s[1] * h) / 2);
  return add(p, axisToLocal(unit.box.axes[2]), (s[2] * d) / 2);
}

/** The 8 corners of the unit's box in the local frame; corner i has bit 0/1/2 = +across/up/out. */
export function antennaCorners(unit: AntennaUnit, frame: Frame, shift: DateShift | null): Vec3[] {
  const centre = antennaCentre(unit, frame, shift);
  const corners: Vec3[] = [];
  for (let i = 0; i < 8; i++)
    corners.push(boxPoint(unit, centre, [i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1]));
  return corners;
}

/**
 * The tip of the facing arrow (as `antennaScene` draws it): from the centre toward the grid
 * azimuth in the horizontal plane, clamp(height, 0.5, 5) m long. Null without an azimuth.
 */
export function facingTip(unit: AntennaUnit, centre: Vec3): Vec3 | null {
  if (!unit.azimuthGridDeg) return null;
  const az = (unit.azimuthGridDeg.value * Math.PI) / 180;
  const length = Math.max(0.5, Math.min(unit.heightM.value, 5));
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
  const azText = formatDeg(az);
  if (unit.kind === 'dish' && unit.elevationDeg)
    return t('telecom.antennas.label.angleDish', {
      az: azText,
      elev: formatDeg(unit.elevationDeg.value),
    });
  if (unit.kind !== 'dish' && unit.downtiltDeg)
    return t('telecom.antennas.label.angle', {
      az: azText,
      tilt: formatDeg(unit.downtiltDeg.value),
    });
  return t('telecom.antennas.label.azimuth', { az: azText });
}

/**
 * The selected unit's dimension lines and labels. Width runs along the box's across axis on its
 * top-front edge, pushed up and out, and height along its up axis on the right-front edge, pushed
 * out along the outward axis (so the width and depth labels stay apart); depth runs along the
 * outward axis on the bottom-right edge, pushed out to the right. Each line is `DIM_OFFSET_M` off
 * its edge with a `DIM_TICK_M` tick across each end.
 */
export function antennaMeasure(
  unit: AntennaUnit,
  frame: Frame,
  shift: DateShift | null,
): { segments: [Vec3, Vec3][]; spots: AntennaLabelSpot[] } {
  const centre = antennaCentre(unit, frame, shift);
  const across = axisToLocal(unit.box.axes[0]);
  const out = axisToLocal(unit.box.axes[2]);
  const up = axisToLocal(unit.box.axes[1]);
  const upOut: Vec3 = [out[0] + up[0], out[1] + up[1], out[2] + up[2]];
  const n = Math.hypot(...upOut) || 1;
  const pushUpOut: Vec3 = [upOut[0] / n, upOut[1] / n, upOut[2] / n];
  const at = (s: Vec3) => boxPoint(unit, centre, s);

  const lines: { key: string; from: Vec3; to: Vec3; push: Vec3; value: number }[] = [
    {
      key: 'w',
      from: at([-1, 1, 1]),
      to: at([1, 1, 1]),
      push: pushUpOut,
      value: unit.widthM.value,
    },
    { key: 'h', from: at([1, -1, 1]), to: at([1, 1, 1]), push: out, value: unit.heightM.value },
    { key: 'd', from: at([1, -1, -1]), to: at([1, -1, 1]), push: across, value: unit.depthM.value },
  ];

  const main: [Vec3, Vec3][] = [];
  const ticks: [Vec3, Vec3][] = [];
  const spots: AntennaLabelSpot[] = [];
  for (const l of lines) {
    const a = add(l.from, l.push, DIM_OFFSET_M);
    const b = add(l.to, l.push, DIM_OFFSET_M);
    main.push([a, b]);
    for (const end of [a, b])
      ticks.push([add(end, l.push, -DIM_TICK_M / 2), add(end, l.push, DIM_TICK_M / 2)]);
    spots.push({
      key: `${unit.id}:dim:${l.key}`,
      text: metres(l.value),
      at: mid(a, b),
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
    text: t('telecom.antennas.label.name', { name: unit.name, height: metres(unit.heightM.value) }),
    at: nameAnchor(unit, frame, shift),
    kind: 'name',
    selected: true,
  });

  return { segments: [...main, ...ticks], spots };
}
