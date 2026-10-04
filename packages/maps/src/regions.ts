import type { Bbox } from './packs';

export interface Region {
  id: string;
  label: string;
  group: 'gcc' | 'world';
  /** Rounded country extent, west, south, east, north. Generous at the edges, never clipped. */
  bbox: Bbox;
}

const gcc = (id: string, label: string, bbox: Bbox): Region => ({ id, label, group: 'gcc', bbox });
const world = (id: string, label: string, bbox: Bbox): Region => ({
  id,
  label,
  group: 'world',
  bbox,
});

/** The six GCC states, the region the product is built for. */
const GCC: Region[] = [
  gcc('bahrain', 'Bahrain', [50.35, 25.55, 50.85, 26.35]),
  gcc('kuwait', 'Kuwait', [46.55, 28.52, 48.43, 30.11]),
  gcc('oman', 'Oman', [51.9, 16.6, 59.85, 26.4]),
  gcc('qatar', 'Qatar', [50.74, 24.47, 51.65, 26.2]),
  gcc('saudi-arabia', 'Saudi Arabia', [34.5, 16.35, 55.67, 32.16]),
  gcc('uae', 'United Arab Emirates', [51.5, 22.6, 56.4, 26.1]),
];

/** A selection of other countries; any other area can be drawn on the map. */
const WORLD: Region[] = [
  world('afghanistan', 'Afghanistan', [60.5, 29.4, 74.9, 38.5]),
  world('algeria', 'Algeria', [-8.7, 19.0, 12.0, 37.1]),
  world('argentina', 'Argentina', [-73.6, -55.1, -53.6, -21.8]),
  world('australia', 'Australia', [112.9, -43.7, 153.7, -10.6]),
  world('austria', 'Austria', [9.5, 46.37, 17.16, 49.02]),
  world('azerbaijan', 'Azerbaijan', [44.8, 38.4, 50.4, 41.9]),
  world('bangladesh', 'Bangladesh', [88.0, 20.7, 92.7, 26.6]),
  world('belgium', 'Belgium', [2.54, 49.5, 6.41, 51.5]),
  world('brazil', 'Brazil', [-74.0, -33.8, -34.8, 5.3]),
  world('canada', 'Canada', [-141.0, 41.7, -52.6, 83.1]),
  world('chile', 'Chile', [-75.7, -55.9, -66.4, -17.5]),
  world('china', 'China', [73.5, 18.2, 134.8, 53.6]),
  world('colombia', 'Colombia', [-79.0, -4.3, -66.9, 12.5]),
  world('cyprus', 'Cyprus', [32.25, 34.55, 34.6, 35.7]),
  world('denmark', 'Denmark', [8.0, 54.55, 12.7, 57.75]),
  world('djibouti', 'Djibouti', [41.75, 10.9, 43.45, 12.75]),
  world('egypt', 'Egypt', [24.7, 22.0, 36.9, 31.7]),
  world('eritrea', 'Eritrea', [36.4, 12.35, 43.15, 18.0]),
  world('ethiopia', 'Ethiopia', [33.0, 3.4, 48.0, 14.9]),
  world('finland', 'Finland', [20.6, 59.8, 31.6, 70.1]),
  world('france', 'France', [-5.15, 41.3, 9.6, 51.1]),
  world('germany', 'Germany', [5.87, 47.27, 15.04, 55.06]),
  world('greece', 'Greece', [19.4, 34.8, 28.3, 41.75]),
  world('india', 'India', [68.1, 6.7, 97.4, 35.5]),
  world('indonesia', 'Indonesia', [95.0, -11.0, 141.0, 6.1]),
  world('iran', 'Iran', [44.0, 25.05, 63.33, 39.78]),
  world('iraq', 'Iraq', [38.8, 29.06, 48.6, 37.4]),
  world('ireland', 'Ireland', [-10.5, 51.4, -6.0, 55.4]),
  world('italy', 'Italy', [6.6, 36.6, 18.6, 47.1]),
  world('japan', 'Japan', [122.9, 24.0, 145.8, 45.6]),
  world('jordan', 'Jordan', [34.9, 29.18, 39.3, 33.38]),
  world('kazakhstan', 'Kazakhstan', [46.5, 40.6, 87.3, 55.4]),
  world('kenya', 'Kenya', [33.9, -4.7, 41.9, 5.0]),
  world('lebanon', 'Lebanon', [35.1, 33.05, 36.62, 34.7]),
  world('libya', 'Libya', [9.3, 19.5, 25.2, 33.2]),
  world('malaysia', 'Malaysia', [99.6, 0.85, 119.3, 7.4]),
  world('mexico', 'Mexico', [-118.4, 14.5, -86.7, 32.7]),
  world('morocco', 'Morocco', [-13.2, 27.6, -1.0, 35.95]),
  world('netherlands', 'Netherlands', [3.36, 50.75, 7.23, 53.56]),
  world('new-zealand', 'New Zealand', [166.4, -47.3, 178.6, -34.4]),
  world('nigeria', 'Nigeria', [2.7, 4.2, 14.7, 13.9]),
  world('norway', 'Norway', [4.6, 57.9, 31.1, 71.2]),
  world('pakistan', 'Pakistan', [60.9, 23.6, 77.8, 37.1]),
  world('philippines', 'Philippines', [116.9, 4.6, 126.6, 21.1]),
  world('poland', 'Poland', [14.1, 49.0, 24.15, 54.85]),
  world('portugal', 'Portugal', [-9.5, 36.95, -6.2, 42.15]),
  world('singapore', 'Singapore', [103.6, 1.16, 104.1, 1.48]),
  world('somalia', 'Somalia', [40.98, -1.7, 51.4, 12.0]),
  world('south-africa', 'South Africa', [16.4, -34.85, 32.9, -22.1]),
  world('south-korea', 'South Korea', [125.0, 33.1, 129.6, 38.6]),
  world('spain', 'Spain', [-9.4, 35.9, 3.4, 43.8]),
  world('sri-lanka', 'Sri Lanka', [79.6, 5.9, 81.9, 9.9]),
  world('sudan', 'Sudan', [21.8, 8.7, 38.6, 22.2]),
  world('sweden', 'Sweden', [11.0, 55.3, 24.2, 69.1]),
  world('switzerland', 'Switzerland', [5.95, 45.8, 10.5, 47.8]),
  world('syria', 'Syria', [35.7, 32.3, 42.4, 37.3]),
  world('thailand', 'Thailand', [97.3, 5.6, 105.7, 20.5]),
  world('tunisia', 'Tunisia', [7.5, 30.2, 11.6, 37.35]),
  world('turkey', 'Turkey', [25.6, 35.8, 44.8, 42.1]),
  world('united-kingdom', 'United Kingdom', [-8.65, 49.9, 1.77, 60.86]),
  world('united-states', 'United States (contiguous)', [-124.8, 24.4, -66.9, 49.4]),
  world('uzbekistan', 'Uzbekistan', [56.0, 37.2, 73.1, 45.6]),
  world('vietnam', 'Vietnam', [102.1, 8.2, 109.5, 23.4]),
  world('yemen', 'Yemen', [42.5, 12.1, 53.1, 19.0]),
];

/** GCC states first, then the world list, each alphabetical. */
export const COUNTRIES: readonly Region[] = [...GCC, ...WORLD];

export const GCC_IDS: readonly string[] = GCC.map((r) => r.id);

export function regionById(id: string): Region | undefined {
  return COUNTRIES.find((r) => r.id === id);
}

/** A pack id from a label and zoom: lowercase ASCII words joined by dashes, plus `-z<zoom>`. */
export function packIdFor(label: string, maxZoom: number): string {
  const slug = label
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${slug || 'region'}-z${String(maxZoom)}`;
}
