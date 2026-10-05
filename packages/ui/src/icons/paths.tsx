// Mission icon set: 20 px grid, 1.5 px stroke, round caps. Ported from the approved reference build.
import type { ReactElement } from 'react';

export const ICONS = {
  projects: (
    <>
      <rect x="3" y="3" width="5.5" height="5.5" rx="1" />
      <rect x="11.5" y="3" width="5.5" height="5.5" rx="1" />
      <rect x="3" y="11.5" width="5.5" height="5.5" rx="1" />
      <rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1" />
    </>
  ),
  scene: (
    <>
      <path d="M10 2.5l6.5 3.75v7.5L10 17.5l-6.5-3.75v-7.5z" />
      <path d="M3.5 6.25L10 10l6.5-3.75M10 10v7.5" />
    </>
  ),
  issues: (
    <>
      <path d="M10 2.5l7.5 7.5-7.5 7.5L2.5 10z" />
      <path d="M10 6.5v4.5" />
      <circle cx="10" cy="13.6" r=".4" fill="currentColor" />
    </>
  ),
  media: (
    <>
      <rect x="2.5" y="4" width="15" height="12" rx="1.5" />
      <path d="M6 4v12M14 4v12M2.5 8h3.5M2.5 12h3.5M14 8h3.5M14 12h3.5" />
    </>
  ),
  report: (
    <>
      <path d="M5 2.5h7l3.5 3.5v11.5H5z" />
      <path d="M12 2.5V6h3.5M7.5 10h5M7.5 13h5" />
    </>
  ),
  settings: (
    <>
      <path d="M3 5.5h8M14.5 5.5H17M3 14.5h2.5M9 14.5h8" />
      <circle cx="12.7" cy="5.5" r="1.8" />
      <circle cx="7.2" cy="14.5" r="1.8" />
      <path d="M3 10h3.5M10 10h7" />
      <circle cx="8.2" cy="10" r="1.8" />
    </>
  ),
  agent: (
    <>
      <path d="M10 2.5c.6 3.9 3.6 6.9 7.5 7.5-3.9.6-6.9 3.6-7.5 7.5-.6-3.9-3.6-6.9-7.5-7.5 3.9-.6 6.9-3.6 7.5-7.5z" />
    </>
  ),
  search: (
    <>
      <circle cx="9" cy="9" r="5.5" />
      <path d="M13 13l4 4" />
    </>
  ),
  plus: (
    <>
      <path d="M10 4v12M4 10h12" />
    </>
  ),
  minus: (
    <>
      <path d="M4 10h12" />
    </>
  ),
  import: (
    <>
      <path d="M10 3v9M6.5 8.5L10 12l3.5-3.5" />
      <path d="M3.5 12.5v3a1 1 0 001 1h11a1 1 0 001-1v-3" />
    </>
  ),
  'chev-r': (
    <>
      <path d="M8 5l5 5-5 5" />
    </>
  ),
  'chev-d': (
    <>
      <path d="M5 8l5 5 5-5" />
    </>
  ),
  chevup: (
    <>
      <path d="M5.5 12.5L10 8l4.5 4.5" />
    </>
  ),
  chevdown: (
    <>
      <path d="M5.5 7.5L10 12l4.5-4.5" />
    </>
  ),
  updown: (
    <>
      <path d="M6.5 8L10 4.5 13.5 8M6.5 12l3.5 3.5 3.5-3.5" />
    </>
  ),
  eye: (
    <>
      <path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z" />
      <circle cx="10" cy="10" r="2.3" />
    </>
  ),
  /** A flight path: dashed track from the take-off dot to the drone. */
  path: (
    <>
      <path d="M3.5 16c2.5 0 3.2-5 6.5-5s3.6-4.5 5-4.5" strokeDasharray="2 1.6" />
      <circle cx="3.5" cy="16" r="1.4" fill="currentColor" />
      <circle cx="16" cy="5.5" r="2" />
    </>
  ),
  /** Drone telemetry: a flown track with distance ticks and a drop line to the ground. */
  telemetry: (
    <>
      <path d="M2.5 13l4.5-4 4 2 5.5-6.5" />
      <path d="M4.2 10l1.4 1.6M9.4 8.6l-.8 2" />
      <path d="M16.5 4.5v12" strokeDasharray="1.6 1.6" />
      <path d="M2.5 16.5h15" />
    </>
  ),
  /** Some of the layers shown: the eye with a half-filled pupil. */
  'eye-mixed': (
    <>
      <path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z" />
      <circle cx="10" cy="10" r="2.3" />
      <path d="M10 7.7a2.3 2.3 0 0 0 0 4.6z" fill="currentColor" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M3 3l14 14M8.3 5c.5-.1 1.1-.2 1.7-.2 5 0 8 5.2 8 5.2s-.8 1.5-2.4 2.9M5.4 6.6C3.2 8.1 2 10 2 10s3 5.2 8 5.2c1.4 0 2.6-.4 3.6-.9" />
    </>
  ),
  cloud: (
    <>
      <circle cx="5" cy="13" r=".9" fill="currentColor" />
      <circle cx="8" cy="9" r=".9" fill="currentColor" />
      <circle cx="11" cy="12" r=".9" fill="currentColor" />
      <circle cx="12" cy="6" r=".9" fill="currentColor" />
      <circle cx="15" cy="10" r=".9" fill="currentColor" />
      <circle cx="8" cy="15.5" r=".9" fill="currentColor" />
      <circle cx="14" cy="15" r=".9" fill="currentColor" />
      <circle cx="5.5" cy="6" r=".9" fill="currentColor" />
    </>
  ),
  map: (
    <>
      <path d="M2.5 5l5-2 5 2 5-2v12l-5 2-5-2-5 2z" />
      <path d="M7.5 3v12M12.5 5v12" />
    </>
  ),
  raster: (
    <>
      <rect x="3" y="3" width="14" height="14" rx="1" />
      <path d="M3 7.7h14M3 12.3h14M7.7 3v14M12.3 3v14" />
    </>
  ),
  video: (
    <>
      <rect x="2.5" y="5" width="11" height="10" rx="1.5" />
      <path d="M13.5 8.5l4-2.5v8l-4-2.5" />
    </>
  ),
  photo: (
    <>
      <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" />
      <path d="M2.5 13.5l4-4 3.5 3.5 2.5-2.5 5 5" />
      <circle cx="13" cy="7.5" r="1.3" />
    </>
  ),
  pano: (
    <>
      <path d="M2.5 5.5c5 1.3 10 1.3 15 0v9c-5-1.3-10-1.3-15 0z" />
      <path d="M10 6.5v7.2" />
    </>
  ),
  anno: (
    <>
      <path d="M12.5 3.5l4 4-9 9H3.5v-4z" />
      <path d="M10.5 5.5l4 4" />
    </>
  ),
  play: (
    <>
      <path d="M6.5 4.5l9 5.5-9 5.5z" fill="currentColor" stroke="none" />
    </>
  ),
  pause: (
    <>
      <rect x="5.5" y="4.5" width="3" height="11" rx=".5" fill="currentColor" stroke="none" />
      <rect x="11.5" y="4.5" width="3" height="11" rx=".5" fill="currentColor" stroke="none" />
    </>
  ),
  back: (
    <>
      <path d="M15 5l-6 5 6 5z" />
      <path d="M5.5 5v10" />
    </>
  ),
  fwd: (
    <>
      <path d="M5 5l6 5-6 5z" />
      <path d="M14.5 5v10" />
    </>
  ),
  loop: (
    <>
      <path d="M4 9V8a3 3 0 013-3h9l-2.5-2.5M16 11v1a3 3 0 01-3 3H4l2.5 2.5" />
    </>
  ),
  select: (
    <>
      <path d="M4.5 3.5l11 5-4.8 1.6-1.7 4.9z" />
      <path d="M10.7 10.1l4.3 4.4" />
    </>
  ),
  measure: (
    <>
      <path d="M2.8 13.2l10.4-10.4 4 4L6.8 17.2z" />
      <path d="M6 10l1.6 1.6M8.4 7.6L10 9.2M10.8 5.2l1.6 1.6" />
    </>
  ),
  box: (
    <>
      <path d="M3 6.5V3h3.5M13.5 3H17v3.5M17 13.5V17h-3.5M6.5 17H3v-3.5" />
      <rect x="6" y="6" width="8" height="8" rx=".5" strokeDasharray="2 1.6" />
    </>
  ),
  polygon: (
    <>
      <path d="M4 7l6-4 6 3.5-1.5 8.5-8.5 1.5z" />
      <circle cx="4" cy="7" r="1.3" fill="currentColor" />
      <circle cx="10" cy="3" r="1.3" fill="currentColor" />
      <circle cx="16" cy="6.5" r="1.3" fill="currentColor" />
      <circle cx="14.5" cy="15" r="1.3" fill="currentColor" />
      <circle cx="6" cy="16.5" r="1.3" fill="currentColor" />
    </>
  ),
  point: (
    <>
      <path d="M10 17.5s5.5-5 5.5-9a5.5 5.5 0 00-11 0c0 4 5.5 9 5.5 9z" />
      <circle cx="10" cy="8.5" r="2" />
    </>
  ),
  brush: (
    <>
      <path d="M16.5 3.5l-7 7" />
      <path d="M9.5 10.5c-2-.5-4 .5-4.5 2.5-.4 1.6-1.5 2.6-2.5 3 3 1 6.5.4 7.6-2.1.5-1.2.3-2.6-.6-3.4z" />
    </>
  ),
  track: (
    <>
      <rect x="2.5" y="10" width="6" height="6" rx=".5" />
      <rect x="11.5" y="4" width="6" height="6" rx=".5" strokeDasharray="1.8 1.5" />
      <path d="M8.5 11.5c2 0 3-1.5 3-3" />
    </>
  ),
  event: (
    <>
      <path d="M5.5 4.5h-2v11h2M14.5 4.5h2v11h-2M7 10h6" />
    </>
  ),
  section: (
    <>
      <path d="M3 13l7-3.5 7 3.5-7 3.5z" />
      <path d="M3 7.5L10 4l7 3.5" strokeDasharray="1.8 1.6" />
      <path d="M10 10v-6" />
    </>
  ),
  boxclip: (
    <>
      <path d="M10 2.5l6.5 3.75v7.5L10 17.5l-6.5-3.75v-7.5z" strokeDasharray="2 1.6" />
      <path d="M7 8.5l3-1.7 3 1.7v3.4l-3 1.7-3-1.7z" />
    </>
  ),
  orbit: (
    <>
      <ellipse cx="10" cy="10" rx="7.5" ry="3.2" />
      <circle cx="10" cy="10" r="2.2" />
      <path d="M15.5 6l1.9.9-.6 2" />
    </>
  ),
  follow: (
    <>
      <circle cx="13" cy="7" r="3" />
      <path d="M3 17l7.5-7.5" />
      <path d="M3 13v4h4" />
    </>
  ),
  droneeye: (
    <>
      <path d="M2.5 7V4.5h3M14.5 4.5h3V7M17.5 13v2.5h-3M5.5 15.5h-3V13" />
      <circle cx="10" cy="10" r="2.6" />
    </>
  ),
  drone: (
    <>
      <circle cx="4.5" cy="4.5" r="2" />
      <circle cx="15.5" cy="4.5" r="2" />
      <circle cx="4.5" cy="15.5" r="2" />
      <circle cx="15.5" cy="15.5" r="2" />
      <rect x="7.8" y="7.8" width="4.4" height="4.4" rx="1" />
      <path d="M6 6l1.8 1.8M14 6l-1.8 1.8M6 14l1.8-1.8M14 14l-1.8-1.8" />
    </>
  ),
  check: (
    <>
      <path d="M4.5 10.5l3.5 3.5 7.5-8" />
    </>
  ),
  undo: (
    <>
      <path d="M7.5 5L4 8.5 7.5 12" />
      <path d="M4 8.5h8a4 4 0 010 8H9" />
    </>
  ),
  x: (
    <>
      <path d="M5 5l10 10M15 5L5 15" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="10" r=".9" fill="currentColor" />
      <circle cx="10" cy="10" r=".9" fill="currentColor" />
      <circle cx="15" cy="10" r=".9" fill="currentColor" />
    </>
  ),
  sidebar: (
    <>
      <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" />
      <path d="M7.5 3.5v13M4.5 7h1M4.5 9.5h1" />
    </>
  ),
  pin: (
    <>
      <path d="M12.5 2.5l5 5-3 1.5-3 3 .5 3.5-1.5 1.5-7-7L5 8.5l3.5.5 3-3z" />
      <path d="M6 14l-3.5 3.5" />
    </>
  ),
  target: (
    <>
      <circle cx="10" cy="10" r="5.5" />
      <path d="M10 2v3.5M10 14.5V18M2 10h3.5M14.5 10H18" />
    </>
  ),
  download: (
    <>
      <path d="M10 3v10M6 9l4 4 4-4M4 16.5h12" />
    </>
  ),
  key: (
    <>
      <circle cx="6.5" cy="13.5" r="3.5" />
      <path d="M9 11l7.5-7.5M14 6l2 2M12 8l1.5 1.5" />
    </>
  ),
  shield: (
    <>
      <path d="M10 2.5l6 2.5v4.5c0 4-2.6 6.8-6 8-3.4-1.2-6-4-6-8V5z" />
      <path d="M7.5 10l2 2 3.5-4" />
    </>
  ),
  globe: (
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M2.5 10h15M10 2.5c2 2.2 3 4.7 3 7.5s-1 5.3-3 7.5c-2-2.2-3-4.7-3-7.5s1-5.3 3-7.5z" />
    </>
  ),
  offline: (
    <>
      <path d="M6 15.5h8.5a3.5 3.5 0 00.5-7A5 5 0 005.4 7.6 4 4 0 006 15.5z" />
      <path d="M3 3l14 14" />
    </>
  ),
  cloudon: (
    <>
      <path d="M6 15.5h8.5a3.5 3.5 0 00.5-7A5 5 0 005.4 7.6 4 4 0 006 15.5z" />
    </>
  ),
  bell: (
    <>
      <path d="M5 13.5V9a5 5 0 0110 0v4.5l1.5 1.5h-13z" />
      <path d="M8.5 17h3" />
    </>
  ),
  filter: (
    <>
      <path d="M3 4.5h14l-5.5 6.5v5l-3 1.5v-6.5z" />
    </>
  ),
  warn: (
    <>
      <path d="M10 3l7.5 13.5h-15z" />
      <path d="M10 8v4" />
      <circle cx="10" cy="14.2" r=".4" fill="currentColor" />
    </>
  ),
  link: (
    <>
      <path d="M8.5 11.5a3 3 0 004.2 0l2.6-2.6a3 3 0 00-4.2-4.2l-1 1" />
      <path d="M11.5 8.5a3 3 0 00-4.2 0l-2.6 2.6a3 3 0 004.2 4.2l1-1" />
    </>
  ),
  camera: (
    <>
      <path d="M3 6.5h3l1.5-2h5l1.5 2h3v9.5H3z" />
      <circle cx="10" cy="11" r="2.8" />
    </>
  ),
  clock: (
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 5.5V10l3 2" />
    </>
  ),
  layers: (
    <>
      <path d="M10 3l7.5 4-7.5 4-7.5-4z" />
      <path d="M2.5 10.5l7.5 4 7.5-4M2.5 14l7.5 4 7.5-4" />
    </>
  ),
  split: (
    <>
      <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" />
      <path d="M10 3.5v13" />
    </>
  ),
  maximize: (
    <>
      <path d="M12 3.5h4.5V8M8 16.5H3.5V12M16.5 3.5l-5 5M3.5 16.5l5-5" />
    </>
  ),
  send: (
    <>
      <path d="M10 16V4.5M5 9l5-5 5 5" />
    </>
  ),
  attach: (
    <>
      <path d="M15.5 9.5l-5.8 5.8a3.5 3.5 0 01-5-5L11 4a2.3 2.3 0 013.3 3.3l-6.3 6.3a1.2 1.2 0 01-1.7-1.7l5.5-5.5" />
    </>
  ),
  grip: (
    <>
      <circle cx="7.5" cy="5" r=".9" fill="currentColor" />
      <circle cx="12.5" cy="5" r=".9" fill="currentColor" />
      <circle cx="7.5" cy="10" r=".9" fill="currentColor" />
      <circle cx="12.5" cy="10" r=".9" fill="currentColor" />
      <circle cx="7.5" cy="15" r=".9" fill="currentColor" />
      <circle cx="12.5" cy="15" r=".9" fill="currentColor" />
    </>
  ),
  tank: (
    <>
      <ellipse cx="10" cy="5" rx="6" ry="2" />
      <path d="M4 5v10c0 1.1 2.7 2 6 2s6-.9 6-2V5" />
      <path d="M4 10c0 1.1 2.7 2 6 2s6-.9 6-2" />
    </>
  ),
  plant: (
    <>
      <path d="M2.5 17.5V9l4 2.5V9l4 2.5V5h3v12.5" />
      <path d="M13.5 8h4v9.5h-15" />
      <path d="M15.5 8V3" />
    </>
  ),
  flare: (
    <>
      <path d="M8.5 18V7.5h3V18M7 18h6M8.5 11l3 3M11.5 11l-3 3" />
      <path d="M10 6c-1.5-1-1.5-2.5 0-4 1.5 1.5 1.5 3 0 4z" />
    </>
  ),
  facade: (
    <>
      <path d="M4 17.5V4.5L10 2.5v15M10 6.5h6v11M2.5 17.5h15" />
      <path d="M6 7h2M6 10h2M6 13h2M12 9.5h2M12 12.5h2" />
    </>
  ),
  pile: (
    <>
      <path d="M1.5 16.5L7 8l3 4 2.5-3.5 6 8z" />
    </>
  ),
  road: (
    <>
      <path d="M6.5 2.5L3 17.5M13.5 2.5l3.5 15M10 3v2.5M10 8.5v3M10 14.5V17" />
    </>
  ),
  history: (
    <>
      <path d="M3.5 10a6.5 6.5 0 102-4.7L3.5 7.3" />
      <path d="M3.5 3.5v3.8h3.8M10 6.5V10l2.5 1.5" />
    </>
  ),
  copy: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M13 7V4.5a1 1 0 00-1-1H4.5a1 1 0 00-1 1V12a1 1 0 001 1H7" />
    </>
  ),
  refresh: (
    <>
      <path d="M16.5 10a6.5 6.5 0 11-1.9-4.6M16.5 3.5v3.5H13" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="9" width="12" height="8.5" rx="1.5" />
      <path d="M6.5 9V6.5a3.5 3.5 0 017 0V9" />
    </>
  ),
  ruler: (
    <>
      <path d="M3 7h14v6H3z" />
      <path d="M6 7v2.5M9 7v3.5M12 7v2.5M15 7v3.5" />
    </>
  ),
  flag: (
    <>
      <path d="M4.5 17.5V3M4.5 3.5h10l-2 3.5 2 3.5h-10" />
    </>
  ),
  sun: (
    <>
      <circle cx="10" cy="10" r="3.2" />
      <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
    </>
  ),
  tag: (
    <>
      <path d="M3 3.5h6.2l7.8 7.8-5.7 5.7L3.5 9.2z" />
      <circle cx="6.6" cy="7" r="1.1" />
    </>
  ),
  cutaway: (
    <>
      <path d="M4 5.5c0-1.4 2.7-2.5 6-2.5s6 1.1 6 2.5v9c0 1.4-2.7 2.5-6 2.5s-6-1.1-6-2.5z" />
      <path d="M10 3v14" strokeDasharray="1.6 1.6" />
      <circle cx="13" cy="9.5" r="1.3" />
    </>
  ),
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof ICONS;
