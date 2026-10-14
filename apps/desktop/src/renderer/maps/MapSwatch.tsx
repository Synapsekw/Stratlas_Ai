/**
 * The small pictures of the Map menu. Drawn here, not rendered from tiles: they show before any
 * tile loads and for a map that cannot be drawn yet (no key, offline-only). Each keeps its map's
 * own colours, the same in both app themes.
 */
import type { ReactNode } from 'react';
import type { SwatchKind } from './mapMenuModel';

const FIELDS = (
  <>
    <rect width="44" height="44" fill="#46563a" />
    <path d="M0 0H16L13 12H0Z" fill="#5d6b40" />
    <path d="M16 0H31L29 11L13 12Z" fill="#8a7a58" />
    <path d="M31 0H44V10L29 11Z" fill="#4c5f3d" />
    <path d="M0 12H13L11 24H0Z" fill="#9a8a63" />
    <path d="M13 12L29 11L27 25L11 24Z" fill="#53663c" />
    <path d="M29 11L44 10V24L27 25Z" fill="#746f47" />
    <path d="M0 34C9 30 15 40 26 36S40 32 44 37V44H0Z" fill="#20424c" />
    <g fill="#2f4029">
      <circle cx="5" cy="5" r="2" />
      <circle cx="8" cy="7.5" r="1.6" />
      <circle cx="36" cy="18" r="2" />
      <circle cx="21" cy="20" r="1.6" />
    </g>
  </>
);

const BODY: Record<SwatchKind, ReactNode> = {
  streets: (
    <>
      <rect width="44" height="44" fill="#16191d" />
      <path d="M29 0H40V8H29Z" fill="#18241f" />
      <path d="M0 34C9 30 15 40 26 36S40 32 44 37V44H0Z" fill="#0e1d28" />
      <path d="M0 9H44M0 20H44M9 0V31M20 0V34M31 0V34" stroke="#343a40" strokeWidth="1" />
      <path d="M-1 27L16 14L45 6" fill="none" stroke="#59616a" strokeWidth="2.2" />
      <rect x="21" y="3" width="7" height="1.8" rx="0.9" fill="#8d949c" />
      <rect x="10" y="23" width="6" height="1.8" rx="0.9" fill="#8d949c" />
    </>
  ),
  'natural-earth': (
    <>
      <rect width="44" height="44" fill="#1d3a52" />
      <path d="M3 10C9 6 17 8 21 13S19 25 13 27S2 22 3 10Z" fill="#6f7d4f" />
      <path d="M24 17C30 13 40 15 42 22S36 35 29 34S20 23 24 17Z" fill="#9b8d62" />
      <path d="M27 21C31 20 35 22 35 26S31 30 28 28Z" fill="#7d8a55" />
      <path d="M0 0H44V4C34 6 12 6 0 4Z" fill="#d8dde0" />
    </>
  ),
  imagery: FIELDS,
  'imagery-labels': (
    <>
      {FIELDS}
      <path d="M-1 27L16 14L45 6" fill="none" stroke="#f2c14e" strokeWidth="1.6" />
      <path d="M20 0V44" stroke="#e8e4da" strokeWidth="1" strokeOpacity="0.8" />
      <rect x="23" y="3" width="8" height="2" rx="1" fill="#ffffff" />
      <rect x="6" y="21" width="7" height="2" rx="1" fill="#ffffff" />
    </>
  ),
  'mapbox-streets': (
    <>
      <rect width="44" height="44" fill="#f4f3ef" />
      <path d="M28 0H40V9H28Z" fill="#c8e6b5" />
      <path d="M0 34C9 30 15 40 26 36S40 32 44 37V44H0Z" fill="#aad3df" />
      <path d="M0 9H44M0 20H44M9 0V31M20 0V34M31 0V34" stroke="#ffffff" strokeWidth="2" />
      <path d="M-1 27L16 14L45 6" fill="none" stroke="#f6c86b" strokeWidth="2.6" />
      <rect x="21" y="3" width="7" height="1.8" rx="0.9" fill="#6b6b6b" />
      <rect x="10" y="23" width="6" height="1.8" rx="0.9" fill="#6b6b6b" />
    </>
  ),
  outdoors: (
    <>
      <rect width="44" height="44" fill="#eef0e6" />
      <path d="M0 0H18C14 8 6 12 0 14Z" fill="#b7d3a0" />
      <g fill="none" stroke="#c9b99a" strokeWidth="0.9">
        <path d="M6 44C10 32 22 26 34 28S44 22 44 18" />
        <path d="M12 44C15 35 24 31 34 33S44 28 44 25" />
        <path d="M19 44C21 39 27 36 35 38S44 34 44 32" />
      </g>
      <path d="M30 0C28 6 32 10 30 16" fill="none" stroke="#9ccbe0" strokeWidth="1.8" />
      <path
        d="M2 30L14 22L26 20L42 8"
        fill="none"
        stroke="#c96f53"
        strokeWidth="1.2"
        strokeDasharray="2 1.6"
      />
    </>
  ),
  light: (
    <>
      <rect width="44" height="44" fill="#f2f2f0" />
      <path d="M0 34C9 30 15 40 26 36S40 32 44 37V44H0Z" fill="#d4dadf" />
      <path d="M0 9H44M0 20H44M9 0V31M20 0V34M31 0V34" stroke="#ffffff" strokeWidth="1.6" />
      <path d="M-1 27L16 14L45 6" fill="none" stroke="#ffffff" strokeWidth="2.6" />
      <rect x="21" y="3" width="7" height="1.8" rx="0.9" fill="#9a9a9a" />
    </>
  ),
  dark: (
    <>
      <rect width="44" height="44" fill="#1f2124" />
      <path d="M0 34C9 30 15 40 26 36S40 32 44 37V44H0Z" fill="#141518" />
      <path d="M0 9H44M0 20H44M9 0V31M20 0V34M31 0V34" stroke="#2f3236" strokeWidth="1.4" />
      <path d="M-1 27L16 14L45 6" fill="none" stroke="#3d4147" strokeWidth="2.6" />
      <rect x="21" y="3" width="7" height="1.8" rx="0.9" fill="#7d8188" />
    </>
  ),
};

export function MapSwatch({ kind, className = '' }: { kind: SwatchKind; className?: string }) {
  return (
    <svg
      className={`mm-swatch ${className}`.trim()}
      viewBox="0 0 44 44"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
      focusable="false"
    >
      {BODY[kind]}
    </svg>
  );
}
