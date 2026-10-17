/** GCC band table (spec "Scope") and 3GPP resource-block tables (D13). Data, not logic. */

export type Duplex = 'FDD' | 'TDD';
export type Tech = 'lte' | 'nr';

export interface Band {
  id: string;
  label: string;
  /** LTE band numbers, empty when NR only. */
  lteBands: readonly number[];
  /** NR band name (for example "n78"), null when LTE only. */
  nrBand: string | null;
  duplex: Duplex;
  /** Nominal downlink centre frequency, MHz. */
  centreMHz: number;
  /** Downlink range, MHz [low, high]. */
  dlRangeMHz: readonly [number, number];
  seenAt: string;
}

export const BANDS: readonly Band[] = [
  {
    id: 'n28',
    label: '700 MHz (n28)',
    lteBands: [28],
    nrBand: 'n28',
    duplex: 'FDD',
    centreMHz: 780,
    dlRangeMHz: [758, 803],
    seenAt: 'KSA (recent award)',
  },
  {
    id: 'b20-n20',
    label: '800 MHz (B20/n20)',
    lteBands: [20],
    nrBand: 'n20',
    duplex: 'FDD',
    centreMHz: 806,
    dlRangeMHz: [791, 821],
    seenAt: 'lead market, KSA',
  },
  {
    id: 'b8-n8',
    label: '900 MHz (B8/n8)',
    lteBands: [8],
    nrBand: 'n8',
    duplex: 'FDD',
    centreMHz: 942.5,
    dlRangeMHz: [925, 960],
    seenAt: 'KSA (LTE and NR)',
  },
  {
    id: 'b3-n3',
    label: '1800 MHz (B3/n3)',
    lteBands: [3],
    nrBand: 'n3',
    duplex: 'FDD',
    centreMHz: 1842.5,
    dlRangeMHz: [1805, 1880],
    seenAt: 'every operator, the main LTE layer',
  },
  {
    id: 'b1-n1',
    label: '2100 MHz (B1/n1)',
    lteBands: [1],
    nrBand: 'n1',
    duplex: 'FDD',
    centreMHz: 2140,
    dlRangeMHz: [2110, 2170],
    seenAt: 'lead market, KSA',
  },
  {
    id: 'b40-n40',
    label: '2300 MHz (B40/n40)',
    lteBands: [40],
    nrBand: 'n40',
    duplex: 'TDD',
    centreMHz: 2350,
    dlRangeMHz: [2300, 2400],
    seenAt: 'KSA',
  },
  {
    id: 'b7',
    label: '2600 MHz (B7)',
    lteBands: [7],
    nrBand: null,
    duplex: 'FDD',
    centreMHz: 2655,
    dlRangeMHz: [2620, 2690],
    seenAt: 'lead market',
  },
  {
    id: 'b41-n41',
    label: '2600 MHz (B38/B41/n41)',
    lteBands: [38, 41],
    nrBand: 'n41',
    duplex: 'TDD',
    centreMHz: 2593,
    dlRangeMHz: [2496, 2690],
    seenAt: 'lead market (5G), KSA',
  },
  {
    id: 'n78',
    label: '3500 MHz (n78)',
    lteBands: [],
    nrBand: 'n78',
    duplex: 'TDD',
    centreMHz: 3500,
    dlRangeMHz: [3300, 3800],
    seenAt: 'every operator, the main 5G layer',
  },
  {
    id: 'n77',
    label: '3700 MHz (n77)',
    lteBands: [],
    nrBand: 'n77',
    duplex: 'TDD',
    centreMHz: 3700,
    dlRangeMHz: [3300, 4200],
    seenAt: 'KSA',
  },
];

export function bandById(id: string): Band | undefined {
  return BANDS.find((b) => b.id === id);
}

/** TS 36.101 Table 5.6-1: channel bandwidth (MHz) to transmission bandwidth N_RB. */
const LTE_N_RB: Readonly<Record<number, number>> = {
  1.4: 6,
  3: 15,
  5: 25,
  10: 50,
  15: 75,
  20: 100,
};

/** TS 38.101-1 Table 5.3.2-1 (FR1): subcarrier spacing (kHz) then bandwidth (MHz) to N_RB. */
const NR_N_RB: Readonly<Record<number, Readonly<Record<number, number>>>> = {
  15: { 5: 25, 10: 52, 15: 79, 20: 106, 25: 133, 30: 160, 40: 216, 50: 270 },
  30: {
    5: 11,
    10: 24,
    15: 38,
    20: 51,
    25: 65,
    30: 78,
    40: 106,
    50: 133,
    60: 162,
    70: 189,
    80: 217,
    90: 245,
    100: 273,
  },
};

/** Resource blocks for a carrier. NR needs the subcarrier spacing (15 or 30 kHz); LTE ignores it. Throws when the combination is not in the standard table. */
export function nRb(tech: Tech, bandwidthMHz: number, scsKHz?: number): number {
  if (tech === 'lte') {
    const n = LTE_N_RB[bandwidthMHz];
    if (n === undefined)
      throw new Error(`LTE bandwidth ${bandwidthMHz} MHz is not a standard channel bandwidth`);
    return n;
  }
  if (scsKHz === undefined) throw new Error('NR needs a subcarrier spacing (15 or 30 kHz)');
  const table = NR_N_RB[scsKHz];
  if (!table) throw new Error(`NR subcarrier spacing ${scsKHz} kHz is not supported in FR1 here`);
  const n = table[bandwidthMHz];
  if (n === undefined) throw new Error(`NR ${bandwidthMHz} MHz is not defined at ${scsKHz} kHz`);
  return n;
}
