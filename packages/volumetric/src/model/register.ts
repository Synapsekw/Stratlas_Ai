import type { BoundaryEdit, PileEpoch, StockPile, VolumeBaseId, VolumesFile } from '@aio/schema';
import { BASE_IDS } from './volume';

/** A pile with hand edits applied; `edited` lists the epochs whose toe line was corrected. */
export type EffectivePile = StockPile & { edited: string[]; auto: Record<string, PileEpoch> };

/** Piles as the register shows them: an edit replaces the automatic line and volumes. */
export function applyEdits(file: VolumesFile, edits: readonly BoundaryEdit[]): EffectivePile[] {
  return file.piles.map((p) => {
    const epochs: Record<string, PileEpoch> = { ...p.epochs };
    const edited: string[] = [];
    for (const e of edits) {
      if (e.pile !== p.id) continue;
      const auto = p.epochs[e.epoch];
      const capture = file.captures.find((c) => c.epoch === e.epoch);
      epochs[e.epoch] = {
        ...(auto ?? {}),
        captureId: auto?.captureId ?? capture?.captureId ?? e.epoch,
        ring: e.ring,
        areaM2: e.areaM2,
        topM: e.topM,
        heightM: e.heightM,
        volumes: e.volumes,
        groundToeFrac: 1,
      };
      edited.push(e.epoch);
    }
    return { ...p, epochs, edited, auto: p.epochs };
  });
}

export interface RegisterRow {
  id: string;
  name: string;
  present: boolean;
  fill: number | null;
  cut: number | null;
  net: number | null;
  areaM2: number | null;
  /** Surface to surface change, first to last survey (does not depend on the base). */
  change: number;
  edited: boolean;
}

export function registerRows(
  piles: readonly EffectivePile[],
  epoch: string,
  base: VolumeBaseId,
): RegisterRow[] {
  return piles.map((p) => {
    const ep = p.epochs[epoch];
    const v = ep?.volumes[base];
    return {
      id: p.id,
      name: p.name,
      present: ep !== undefined,
      fill: v?.fill ?? null,
      cut: v?.cut ?? null,
      net: v?.net ?? null,
      areaM2: ep?.areaM2 ?? null,
      change: p.change.net,
      edited: p.edited.includes(epoch),
    };
  });
}

export type SortKey = 'id' | 'fill' | 'cut' | 'net' | 'change';

const natural = new Intl.Collator('en', { numeric: true });

/** Sorted copy; piles without a value on the date go last in either direction. */
export function sortRows(
  rows: readonly RegisterRow[],
  key: SortKey,
  dir: 'asc' | 'desc',
): RegisterRow[] {
  const s = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === 'id') return s * natural.compare(a.id, b.id);
    const va = a[key];
    const vb = b[key];
    if (va === null && vb === null) return natural.compare(a.id, b.id);
    if (va === null) return 1;
    if (vb === null) return -1;
    return s * (va - vb) || natural.compare(a.id, b.id);
  });
}

export function totals(piles: readonly EffectivePile[], epoch: string, base: VolumeBaseId) {
  let net = 0;
  let fill = 0;
  let cut = 0;
  let areaM2 = 0;
  let n = 0;
  for (const p of piles) {
    const ep = p.epochs[epoch];
    if (!ep) continue;
    net += ep.volumes[base].net;
    fill += ep.volumes[base].fill;
    cut += ep.volumes[base].cut;
    areaM2 += ep.areaM2;
    n++;
  }
  const r = (v: number) => Math.round(v * 10) / 10;
  return { net: r(net), fill: r(fill), cut: r(cut), areaM2: r(areaM2), piles: n };
}

const cell = (v: string | number | null | undefined): string => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The stockpile register as CSV: every date and base, change, density and boundary state. */
export function registerCsv(
  file: VolumesFile,
  piles: readonly EffectivePile[],
  density: number,
): string {
  const head = ['pile', 'name', 'status'];
  for (const c of file.captures) {
    const e = c.epoch;
    head.push(`${e}_date`, `${e}_area_m2`, `${e}_height_m`);
    for (const b of BASE_IDS)
      head.push(`${e}_vol_${b}_fill_m3`, `${e}_vol_${b}_cut_m3`, `${e}_vol_${b}_net_m3`);
    head.push(`${e}_survey_err_m3`);
  }
  head.push('change_cut_m3', 'change_fill_m3', 'change_net_m3', 'density_t_m3', 'boundary');
  const lines = [head.join(',')];
  for (const p of piles) {
    const r: (string | number | null | undefined)[] = [p.id, p.name, p.status ?? ''];
    for (const c of file.captures) {
      const x = p.epochs[c.epoch];
      r.push(c.date, x?.areaM2, x?.heightM);
      for (const b of BASE_IDS) {
        const v = x?.volumes[b];
        r.push(v?.fill, v?.cut, v?.net);
      }
      r.push(x?.surveyErrM3);
    }
    const labels = file.captures.filter((c) => p.edited.includes(c.epoch)).map((c) => c.label);
    r.push(p.change.cut, p.change.fill, p.change.net, density);
    r.push(labels.length ? `edited ${labels.join(' and ')}` : 'automatic');
    lines.push(r.map(cell).join(','));
  }
  return `${lines.join('\n')}\n`;
}
