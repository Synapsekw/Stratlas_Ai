// Option 3: Studio. Shell, panels, screens, sequencer.
const A = '../../assets/';
export const ASSETS = {
  hcl: {
    glb: A + 'hcl/tank.glb', cloud: A + 'hcl/cloud.bin', cloudN: 280000,
    clipExt: A + 'hcl/clip_f110_external.mp4', poseExt: A + 'hcl/clip_f110_external_pose.json', posterExt: A + 'hcl/clip_f110_external_poster.jpg',
    clipRoof: A + 'hcl/clip_f108_roof.mp4', posterRoof: A + 'hcl/clip_f108_roof_poster.jpg',
    photos: { F01: 'F01_109_0256.jpg', F02: 'F02_106_0172.jpg', F04: 'F04_101_0035.jpg', F05: 'F05_108_0220.jpg', F06: 'F06_107_0186.jpg', F09: 'F09_105_0144.jpg' },
  },
  alzour: {},
  thumbs: {},
};

/* ------------------------------------------------------------------ icons */
const P = {
  home: '<path d="M3.5 9 10 3.5 16.5 9v7.5h-4.25v-5h-4.5v5H3.5z"/>',
  cube: '<path d="M10 2.75 16.5 6.4v7.2L10 17.25 3.5 13.6V6.4z"/><path d="M3.5 6.4 10 10l6.5-3.6M10 10v7.25"/>',
  flag: '<path d="M5 17.5V3.25M5 4h9.5l-2 3.5 2 3.5H5"/>',
  film: '<rect x="2.75" y="4.25" width="14.5" height="11.5" rx="1.5"/><path d="M6.25 4.25v11.5M13.75 4.25v11.5M2.75 8h3.5M2.75 12h3.5M13.75 8h3.5M13.75 12h3.5"/>',
  video: '<rect x="2.75" y="5.25" width="10.5" height="9.5" rx="1.5"/><path d="m13.25 8.75 4-2.25v7l-4-2.25"/>',
  photo: '<rect x="2.75" y="3.75" width="14.5" height="12.5" rx="1.5"/><circle cx="7" cy="8" r="1.5"/><path d="m3 14.5 4.25-4 3 2.75 2.5-2.25 4.25 3.75"/>',
  doc: '<path d="M5 2.75h6.5l3.5 3.5v11H5z"/><path d="M11.5 2.75v3.5H15M7.5 10h5M7.5 13h5"/>',
  map: '<path d="M2.75 5.25 7.25 3.5l5.5 2 4.5-1.75v11L12.75 16.5l-5.5-2-4.5 1.75z"/><path d="M7.25 3.5v11M12.75 5.5v11"/>',
  gear: '<path d="M8.6 2.75h2.8l.45 2.1 1.5.86 2.04-.68 1.4 2.42-1.6 1.43v1.72l1.6 1.43-1.4 2.42-2.04-.68-1.5.86-.45 2.1H8.6l-.45-2.1-1.5-.86-2.04.68-1.4-2.42 1.6-1.43V9.14l-1.6-1.43 1.4-2.42 2.04.68 1.5-.86z"/><circle cx="10" cy="10" r="2.25"/>',
  search: '<circle cx="8.75" cy="8.75" r="5"/><path d="m12.5 12.5 4.25 4.25"/>',
  filter: '<path d="M3 4.5h14l-5.5 6.5v5l-3-1.5V11z"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  chevR: '<path d="m8 5 5 5-5 5"/>',
  chevD: '<path d="m5 8 5 5 5-5"/>',
  chevL: '<path d="m12 5-5 5 5 5"/>',
  updown: '<path d="m6.5 8 3.5-3.5L13.5 8M6.5 12l3.5 3.5 3.5-3.5"/>',
  eye: '<path d="M1.75 10S4.75 4.5 10 4.5 18.25 10 18.25 10 15.25 15.5 10 15.5 1.75 10 1.75 10z"/><circle cx="10" cy="10" r="2.5"/>',
  eyeOff: '<path d="M3 3l14 14M8.2 4.7A8.6 8.6 0 0 1 10 4.5c5.25 0 8.25 5.5 8.25 5.5a14 14 0 0 1-2.3 2.9M13.5 14.6A7.7 7.7 0 0 1 10 15.5C4.75 15.5 1.75 10 1.75 10a14.5 14.5 0 0 1 3.4-3.9"/>',
  lock: '<rect x="4.25" y="8.75" width="11.5" height="8.5" rx="1.5"/><path d="M6.75 8.75V6.5a3.25 3.25 0 0 1 6.5 0v2.25"/>',
  unlock: '<rect x="4.25" y="8.75" width="11.5" height="8.5" rx="1.5"/><path d="M6.75 8.75V6.5a3.25 3.25 0 0 1 6.3-1.1"/>',
  points: '<g fill="currentColor" stroke="none"><circle cx="5" cy="6" r="1.15"/><circle cx="9.5" cy="4.5" r="1.15"/><circle cx="14.5" cy="6.5" r="1.15"/><circle cx="7" cy="10" r="1.15"/><circle cx="12" cy="9.5" r="1.15"/><circle cx="16" cy="11" r="1.15"/><circle cx="4.5" cy="14" r="1.15"/><circle cx="9.5" cy="14.5" r="1.15"/><circle cx="14" cy="15" r="1.15"/></g>',
  layers: '<path d="m10 3 7.25 4L10 11 2.75 7z"/><path d="m2.75 10.25 7.25 4 7.25-4M2.75 13.5l7.25 4 7.25-4"/>',
  pin: '<path d="M10 17.5s5.25-4.9 5.25-9.25a5.25 5.25 0 0 0-10.5 0C4.75 12.6 10 17.5 10 17.5z"/><circle cx="10" cy="8.25" r="1.75"/>',
  path: '<circle cx="4.5" cy="15" r="1.75"/><circle cx="15.5" cy="5" r="1.75"/><path d="M6 14c3.5-1 2-5 5-6.5 1.6-.8 2.5-.9 3-1.2"/>',
  drone: '<circle cx="5" cy="5" r="2.25"/><circle cx="15" cy="5" r="2.25"/><circle cx="5" cy="15" r="2.25"/><circle cx="15" cy="15" r="2.25"/><path d="m6.6 6.6 6.8 6.8M13.4 6.6l-6.8 6.8"/>',
  play: '<path d="M6.5 4.5v11l9-5.5z" fill="currentColor"/>',
  pause: '<path d="M6.5 4.5v11M13.5 4.5v11" stroke-width="2.5"/>',
  start: '<path d="M5 4.5v11M15 4.5v11L7.5 10z"/>',
  end: '<path d="M15 4.5v11M5 4.5v11l7.5-5.5z"/>',
  keyPrev: '<path d="m12 6 4 4-4 4-4-4z"/><path d="M4.5 10H8"/>',
  keyNext: '<path d="m8 6 4 4-4 4-4-4z"/><path d="M15.5 10H12"/>',
  loop: '<path d="M4 9V8a2.5 2.5 0 0 1 2.5-2.5h9l-2.5-2.5M16 11v1a2.5 2.5 0 0 1-2.5 2.5h-9l2.5 2.5"/>',
  select: '<path d="M4.5 3.5 15 9.25l-4.6 1.15L8.25 15z"/>',
  move: '<path d="M10 2.5v15M2.5 10h15M7.75 4.75 10 2.5l2.25 2.25M7.75 15.25 10 17.5l2.25-2.25M4.75 7.75 2.5 10l2.25 2.25M15.25 7.75 17.5 10l-2.25 2.25"/>',
  rotate: '<path d="M16 10a6 6 0 1 1-1.76-4.24M16 3.5v3.25h-3.25"/>',
  ruler: '<path d="m2.9 13.6 10.7-10.7 3.5 3.5L6.4 17.1z"/><path d="m6 10.5 1.5 1.5M8.5 8l1.5 1.5M11 5.5l1.5 1.5"/>',
  height: '<path d="M10 3.5v11M7.5 6 10 3.5 12.5 6M7.5 12 10 14.5 12.5 12M3.5 17h13"/>',
  area: '<path d="M4 6.5 9 3.5l7 3.5-1.5 8-8.5 1.5z" stroke-dasharray="2.2 1.8"/><circle cx="4" cy="6.5" r="1.25" fill="currentColor"/><circle cx="16" cy="7" r="1.25" fill="currentColor"/><circle cx="6" cy="16.5" r="1.25" fill="currentColor"/>',
  section: '<path d="M3.5 7 10 3.5 16.5 7v6L10 16.5 3.5 13z"/><path d="M1.5 10.5h17"/>',
  box: '<path d="M3.5 6.5v-3h3M13.5 3.5h3v3M16.5 13.5v3h-3M6.5 16.5h-3v-3"/><rect x="6.75" y="6.75" width="6.5" height="6.5" rx=".5"/>',
  rbox: '<path d="m10 2.75 7.25 7.25L10 17.25 2.75 10z"/>',
  poly: '<path d="M4 7 9 3.5 16 6l-1 8-8.5 2.5z"/>',
  point: '<circle cx="10" cy="10" r="2"/><path d="M10 2.5v4M10 13.5v4M2.5 10h4M13.5 10h4"/>',
  brush: '<path d="M16.5 3.5 9.5 10.5"/><path d="M9.25 10.75c-1.5-1-3.6-.4-4 1.6-.3 1.4-.8 2.4-2 2.9 3 .8 6.6.2 6.9-2.7.1-.7-.3-1.3-.9-1.8z"/>',
  track: '<path d="M2.5 10h15"/><path d="m5 7.5 2.5 2.5L5 12.5 2.5 10zM15 7.5l2.5 2.5-2.5 2.5-2.5-2.5z" fill="currentColor"/>',
  event: '<path d="M3.5 6.5v7M16.5 6.5v7M3.5 10h13"/>',
  bookmark: '<path d="M5.5 3h9v14l-4.5-3.5L5.5 17z"/>',
  camera: '<path d="M3 6.5h3l1.5-2h5l1.5 2h3v9.5H3z"/><circle cx="10" cy="11" r="3"/>',
  max: '<path d="M3.5 8V3.5H8M12 3.5h4.5V8M16.5 12v4.5H12M8 16.5H3.5V12"/>',
  more: '<g fill="currentColor" stroke="none"><circle cx="5" cy="10" r="1.3"/><circle cx="10" cy="10" r="1.3"/><circle cx="15" cy="10" r="1.3"/></g>',
  agent: '<rect x="5.5" y="5.5" width="9" height="9" rx="2.25"/><path d="M10 2.5v3M10 14.5v3M2.5 10h3M14.5 10h3"/><path d="M8.25 10h3.5"/>',
  send: '<path d="M10 16V4.5M5.5 9 10 4.5 14.5 9"/>',
  check: '<path d="m4.5 10.5 3.5 3.5 7.5-8"/>',
  undo: '<path d="M7.5 5 4 8.5 7.5 12M4 8.5h8a4 4 0 0 1 0 8h-2"/>',
  x: '<path d="M5 5l10 10M15 5 5 15"/>',
  key: '<circle cx="6.5" cy="13.5" r="3.25"/><path d="m8.8 11.2 7.2-7.2M13.5 6.5l2 2M11.75 8.25l1.5 1.5"/>',
  shield: '<path d="M10 2.75 16 5v4.75c0 3.7-2.6 6.4-6 7.5-3.4-1.1-6-3.8-6-7.5V5z"/>',
  cloud: '<path d="M6 15.5h8.25a3.25 3.25 0 0 0 .4-6.48A4.75 4.75 0 0 0 5.6 8.1 3.75 3.75 0 0 0 6 15.5z"/>',
  cloudOff: '<path d="M6 15.5h8.25M16.8 13.4a3.25 3.25 0 0 0-2.15-4.38A4.75 4.75 0 0 0 7.9 5.3M5.4 8.2A3.75 3.75 0 0 0 6 15.5M3 3l14 14"/>',
  download: '<path d="M10 3v10M6 9.5l4 4 4-4M3.5 16.5h13"/>',
  refresh: '<path d="M16 6.5A6.5 6.5 0 0 0 4.1 7.5M4 13.5a6.5 6.5 0 0 0 11.9-1M16 3v3.5h-3.5M4 17v-3.5h3.5"/>',
  folder: '<path d="M2.75 5.25a1.5 1.5 0 0 1 1.5-1.5H8l1.75 2h6a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5H4.25a1.5 1.5 0 0 1-1.5-1.5z"/>',
  grid: '<rect x="3" y="3" width="5.5" height="5.5" rx="1"/><rect x="11.5" y="3" width="5.5" height="5.5" rx="1"/><rect x="3" y="11.5" width="5.5" height="5.5" rx="1"/><rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1"/>',
  list: '<path d="M7 5h10M7 10h10M7 15h10M3 5h.5M3 10h.5M3 15h.5"/>',
  sun: '<circle cx="10" cy="10" r="3"/><path d="M10 2.5v1.75M10 15.75v1.75M17.5 10h-1.75M4.25 10H2.5M15.3 4.7l-1.24 1.24M5.94 14.06 4.7 15.3M15.3 15.3l-1.24-1.24M5.94 5.94 4.7 4.7"/>',
  wire: '<path d="M10 2.75 16.5 6.4v7.2L10 17.25 3.5 13.6V6.4z"/><path d="M3.5 6.4 16.5 13.6M16.5 6.4 3.5 13.6M10 2.75v14.5"/>',
  globe: '<circle cx="10" cy="10" r="7.25"/><path d="M2.75 10h14.5M10 2.75c2 2 3 4.4 3 7.25s-1 5.25-3 7.25c-2-2-3-4.4-3-7.25s1-5.25 3-7.25z"/>',
  disk: '<rect x="3" y="11" width="14" height="5.5" rx="1.25"/><path d="M4 11 5.75 4.25h8.5L16 11M13.25 13.75h.5"/>',
  sidebar: '<rect x="2.75" y="3.75" width="14.5" height="12.5" rx="1.5"/><path d="M7.5 3.75v12.5"/>',
  split: '<rect x="2.75" y="3.75" width="14.5" height="12.5" rx="1.5"/><path d="M10 3.75v12.5"/>',
  tank: '<ellipse cx="10" cy="5" rx="5.5" ry="2"/><path d="M4.5 5v10c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V5"/>',
  flare: '<path d="M10 17.5V8.5M7 17.5h6M8.5 17.5l1.5-9 1.5 9M10 7c-1.6-1.4-1.6-3 0-4.5 1.6 1.5 1.6 3.1 0 4.5z"/>',
  building: '<rect x="5" y="2.75" width="10" height="14.5" rx=".5"/><path d="M8 6h1M11 6h1M8 9h1M11 9h1M8 12h1M11 12h1"/>',
  pile: '<path d="M2.5 16 7.5 8l3 4 2-2.5 5 6.5z"/>',
  road: '<path d="M7 3 4 17M13 3l3 14M10 4v2M10 9v2M10 14v2"/>',
  plant: '<path d="M2.75 17V9.5l4 2.5V9.5l4 2.5V4h3.5v13zM2.75 17h14.5"/>',
  blank: '<rect x="4" y="3" width="12" height="14" rx="1.5" stroke-dasharray="2.5 2"/>',
  minimize: '<path d="M5 10h10"/>',
  winmax: '<rect x="5" y="5" width="10" height="10" rx=".5"/>',
  warn: '<path d="M10 3.25 17.5 16.5h-15z"/><path d="M10 8.5v3.5M10 14.25v.25"/>',
  frustum: '<path d="M3 10l13-6v12z"/><circle cx="3" cy="10" r="1.25" fill="currentColor"/>',
  target: '<circle cx="10" cy="10" r="6.5"/><circle cx="10" cy="10" r="2.25"/><path d="M10 1.75v2.5M10 15.75v2.5M1.75 10h2.5M15.75 10h2.5"/>',
  link: '<path d="M8.5 11.5a3.25 3.25 0 0 0 4.6 0l2.4-2.4a3.25 3.25 0 0 0-4.6-4.6l-.9.9M11.5 8.5a3.25 3.25 0 0 0-4.6 0L4.5 10.9a3.25 3.25 0 0 0 4.6 4.6l.9-.9"/>',
  clip: '<path d="m15.5 9.5-5.6 5.6a3.5 3.5 0 0 1-5-5l6-6a2.3 2.3 0 0 1 3.3 3.3l-6 6a1.15 1.15 0 0 1-1.6-1.6l5.4-5.4"/>',
  user: '<circle cx="10" cy="7" r="3.25"/><path d="M3.75 17c.8-3 3.3-4.75 6.25-4.75S15.45 14 16.25 17"/>',
  clock: '<circle cx="10" cy="10" r="7.25"/><path d="M10 5.75V10l2.75 1.75"/>',
  pano: '<path d="M2.75 5.5c4.8 1.5 9.7 1.5 14.5 0v9c-4.8-1.5-9.7-1.5-14.5 0z"/>',
  ortho: '<rect x="3" y="3" width="14" height="14" rx="1"/><path d="M3 12.5 7.5 9l3.5 3 2.5-2L17 13"/>',
  cpu: '<rect x="5.5" y="5.5" width="9" height="9" rx="1"/><path d="M8 2.75v2.75M12 2.75v2.75M8 14.5v2.75M12 14.5v2.75M2.75 8h2.75M2.75 12h2.75M14.5 8h2.75M14.5 12h2.75"/>',
  bolt: '<path d="M11 2.5 4.5 11.5H10l-1 6 6.5-9H10z"/>',
  hand: '<path d="M7 10V4.75a1.25 1.25 0 0 1 2.5 0V9.5M9.5 9V3.75a1.25 1.25 0 0 1 2.5 0V9.5M12 9.25V5a1.25 1.25 0 0 1 2.5 0v6.5c0 3.3-2.2 5.75-5.25 5.75-2.2 0-3.4-1-4.6-3l-1.6-2.75a1.2 1.2 0 0 1 2-1.3L7 11.5"/>',
  zoom: '<circle cx="8.75" cy="8.75" r="5"/><path d="m12.5 12.5 4.25 4.25M8.75 6.5v4.5M6.5 8.75h4.5"/>',
  persp: '<path d="M4 4.5h12l-2.5 11h-7z"/>',
  key2: '<path d="M10 3 14.5 10 10 17 5.5 10z"/>',
  report: '<path d="M5 2.75h10v14.5H5z"/><path d="M7.5 13v-2M10 13V8.5M12.5 13V10"/>',
  mesh: '<path d="M3 15 10 3l7 12z"/><path d="M6.5 9h7M10 3v12M6.5 9 10 15l3.5-6"/>',
  copy: '<rect x="6.5" y="6.5" width="10" height="10" rx="1.5"/><path d="M13.5 6.5V4.75a1.25 1.25 0 0 0-1.25-1.25h-7.5A1.25 1.25 0 0 0 3.5 4.75v7.5a1.25 1.25 0 0 0 1.25 1.25H6.5"/>',
  dots6: '<g fill="currentColor" stroke="none"><circle cx="7.5" cy="5" r="1.2"/><circle cx="12.5" cy="5" r="1.2"/><circle cx="7.5" cy="10" r="1.2"/><circle cx="12.5" cy="10" r="1.2"/><circle cx="7.5" cy="15" r="1.2"/><circle cx="12.5" cy="15" r="1.2"/></g>',
};
export const ic = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 20 20" aria-hidden="true">${P[n] || ''}</svg>`;

const MARK = (size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">
  <path d="M8.2 3.5h13.3l-3.4 3.6H4.8z" fill="currentColor" opacity=".92"/>
  <path d="M5.4 9.2h13.3l-3.4 3.6H2z" fill="var(--ac)"/>
  <path d="M8.2 14.9h13.3l-3.4 3.6H4.8z" fill="currentColor" opacity=".55"/>
  <path d="M5.4 20.6h13.3" stroke="currentColor" stroke-opacity=".3" stroke-width="1.6"/>
</svg>`;

/* ------------------------------------------------------------------ data */
export const PROJECTS = [
  { id: 'alzour', name: 'Al-Zour LNG Terminal', client: 'KIPIC', site: 'Al-Zour, Kuwait', type: 'Plant fusion', icon: 'plant', date: '21 Feb 2023', size: '38.6 GB', offline: 'Ready offline',
    layers: [['mesh', '909'], ['points', '842 M'], ['ortho', '3'], ['video', '25'], ['pano', '12']], issues: 9 },
  { id: 'hcl', name: 'HCl Tank 710-D-130335', client: 'KOC', site: 'Ahmadi, Kuwait', type: 'Tank inspection', icon: 'tank', date: '22 Nov 2023', size: '6.2 GB', offline: 'Ready offline',
    layers: [['mesh', '225'], ['points', '1.4 M'], ['video', '10'], ['photo', '214'], ['flag', '11']], issues: 11 },
  { id: 'ebsm', name: 'EBSM flare stack', client: 'EQUATE', site: 'Shuaiba, Kuwait', type: 'Flare / stack', icon: 'flare', date: '24 Jan 2019', size: '4.1 GB', offline: 'Ready offline',
    layers: [['mesh', '1'], ['photo', '299'], ['flag', '78']], issues: 78 },
  { id: 'damac', name: 'DAMAC Hills residential tower', client: 'DAMAC', site: 'Dubai, UAE', type: 'Facade survey', icon: 'building', date: '05 Jun 2024', size: '21.3 GB', offline: 'Photos streaming',
    layers: [['mesh', '1'], ['photo', '1,182'], ['flag', '656'], ['doc', '206 pp']], issues: 656 },
  { id: 'masafi', name: 'Masafi stockpile yard', client: 'Masafi', site: 'Sulaibiya, Kuwait', type: 'Stockpile volumes', icon: 'pile', date: '10 Jan 2021', size: '9.8 GB', offline: 'Ready offline',
    layers: [['mesh', '19'], ['ortho', '2'], ['pile', '2 dates']], issues: 0 },
  { id: 'ring', name: '1st Ring Road survey', client: 'MPW', site: 'Kuwait City', type: 'Road survey', icon: 'road', date: '07 Jun 2024', size: '54.7 GB', offline: 'Ready offline',
    layers: [['ortho', '1.25 cm'], ['flag', '1,904'], ['road', 'PCI']], issues: 1904 },
];

const AREAS = ['20 LNG tanks', '10 Jetty and berths', '30 HP LNG process', '40 BOG handling', '50 Send-out and sea water', '60 Flare', '70 Utilities', '80 Buildings', 'Site pipe racks', 'Roads, fences and paving', 'Terrain and sea', 'Design vessels'];
const AREA_N = [160, 145, 53, 26, 110, 10, 96, 12, 32, 238, 3, 3];

export const HCL_ISSUES = [
  { id: 'F01', sev: 5, cls: 'Crack', title: 'Crack in bottom plate', area: 'Bottom plate', h: 0.04, pos: [1.165, 0.035, -0.38] },
  { id: 'F02', sev: 4, cls: 'Patch damage', title: 'Top plate patch damage', area: 'Roof', h: 8.48, pos: [1.564, 8.477, -0.342] },
  { id: 'F03', sev: 4, cls: 'Lining lift', title: 'Lining lift at seam CS 3.0', area: 'Shell, course 1', h: 3.0, pos: [-1.62, 3.0, -1.17] },
  { id: 'F04', sev: 3, cls: 'Coating blister', title: 'Top plate blisters', area: 'Roof', h: 8.69, pos: [-0.131, 8.693, -0.029] },
  { id: 'F05', sev: 3, cls: 'Corrosion', title: 'Top plate corrosion', area: 'Roof', h: 8.56, pos: [-0.759, 8.559, 0.393] },
  { id: 'F06', sev: 3, cls: 'Coating blister', title: 'Top ring joint blisters', area: 'Roof to shell', h: 8.28, pos: [-1.067, 8.282, 1.332] },
  { id: 'F07', sev: 4, cls: 'Lining crack', title: 'Nozzle N3 bore lining crack', area: 'Nozzle N3', h: 6.9, pos: [0.4, 6.9, 1.95] },
  { id: 'F08', sev: 3, cls: 'Coating blister', title: 'Blister cluster, course 2', area: 'Shell, course 2', h: 4.1, pos: [-1.9, 4.1, 0.55] },
  { id: 'F09', sev: 3, cls: 'Coating blister', title: 'Vertical joint, 3 o’clock', area: 'Shell', h: 4.74, pos: [1.972, 4.738, 0.26] },
  { id: 'F10', sev: 4, cls: 'Corrosion', title: 'Manhole M1 flange face', area: 'Manhole M1', h: 0.9, pos: [0.2, 0.9, -1.98] },
  { id: 'F11', sev: 5, cls: 'Pitting', title: 'Bottom plate pitting near sump', area: 'Bottom plate', h: 0.03, pos: [-0.55, 0.03, 0.62] },
];

/* ------------------------------------------------------------------ helpers */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const store = {
  get(k, d) { try { const v = localStorage.getItem('o3.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('o3.' + k, JSON.stringify(v)); } catch {} },
};
const sevName = { 5: 'Critical', 4: 'High', 3: 'Medium', 2: 'Low', 1: 'Observation' };

/* ------------------------------------------------------------------ title bar + status bar */
function renderTitlebar() {
  $('#titlebar').innerHTML = `
    <div class="tb-menus" role="menubar">
      ${['File', 'Edit', 'View', 'Layer', 'Annotate', 'Window', 'Help'].map(m => `<button role="menuitem">${m}</button>`).join('')}
    </div>
    <div class="tb-center" id="wsTabs" role="tablist" aria-label="Workspaces"></div>
    <div class="tb-right">
      <span class="pill hide-s" id="aiPill"><span class="dot"></span>Cloud AI allowed</span>
      <span class="pill hide-s">${ic('disk', 's14')}GCC maps</span>
      <div class="win-btns"><button aria-label="Minimise">${ic('minimize', 's14')}</button><button aria-label="Maximise">${ic('winmax', 's12')}</button><button class="close" aria-label="Close">${ic('x', 's14')}</button></div>
    </div>`;
}
function setWsTabs(screen) {
  const el = $('#wsTabs');
  const map = {
    home: ['Projects'],
    alzour: ['Layout', 'Review', 'Annotate', 'Report'],
    hcl: ['Layout', 'Review', 'Annotate', 'Report'],
    settings: ['Preferences'],
  };
  const active = { home: 0, alzour: 1, hcl: 2, settings: 0 }[screen];
  el.innerHTML = map[screen].map((t, i) => `<button class="ws-tab" role="tab" aria-selected="${i === active}">${t}</button>`).join('');
}
function renderStatus() {
  $('#statusbar').innerHTML = `
    <div class="sb-item" id="stA">${ic('globe', 's12')}<span class="mono">WGS 84 / UTM 39N</span></div>
    <div class="sb-item" id="stB"><span class="mono">E 247 912.4  N 3 213 604.2  Z 4.20 m</span></div>
    <div class="sb-item" id="stC">${ic('cpu', 's12')}<span class="mono" id="fps">60 fps</span></div>
    <div class="sb-item" id="stD">${ic('cloudOff', 's12')}Offline, last sync 09:12</div>
    <nav class="switcher" role="tablist" aria-label="Mockup screens">
      <span class="lab">Screens</span>
      <button role="tab" data-go="home"><b>1</b>Projects</button>
      <button role="tab" data-go="alzour"><b>2</b>Al-Zour</button>
      <button role="tab" data-go="hcl"><b>3</b>HCl tank</button>
      <button role="tab" data-go="settings"><b>4</b>Settings</button>
    </nav>
    <div class="caption" id="caption">Option 3: Studio, screen 1 of 4</div>`;
}

/* ------------------------------------------------------------------ sidebar */
function treeRow(o) {
  const pad = 8 + (o.d || 0) * 14;
  const tw = o.tw === undefined ? '' : (o.tw ? ic('chevD', 's12') : ic('chevR', 's12'));
  const eye = o.noToggles ? '' : `<span class="tg"><button aria-label="Visibility" class="${o.hid ? 'off' : ''}">${ic(o.hid ? 'eyeOff' : 'eye', 's14')}</button><button aria-label="Lock" class="${o.lock ? 'on-lock' : 'off'}">${ic(o.lock ? 'lock' : 'unlock', 's14')}</button></span>`;
  return `<div class="tr ${o.grp ? 'grp' : ''} ${o.sel ? 'sel' : ''} ${o.hid ? 'hid' : ''} ${o.more ? 'more' : ''}" style="padding-left:${pad}px" ${o.data || ''}>
    <span class="tw">${tw}</span>${o.sev ? `<span class="sev-dot sev${o.sev}"></span>` : (o.icon ? `<span class="ty">${ic(o.icon, 's14')}</span>` : '')}
    <span class="nm">${o.name}</span>${o.badge ? `<span class="badge">${o.badge}</span>` : ''}${o.ct != null ? `<span class="ct">${o.ct}</span>` : ''}${o.more ? '' : eye}</div>`;
}
function outlinerAlzour() {
  const rows = [];
  rows.push(treeRow({ name: 'Models', icon: 'cube', grp: 1, tw: 1, ct: 1 }));
  rows.push(treeRow({ name: 'Al-Zour plant', icon: 'mesh', d: 1, tw: 1, ct: 909 }));
  rows.push(treeRow({ name: AREAS[0], icon: 'folder', d: 2, tw: 1, ct: 160 }));
  rows.push(treeRow({ name: '20-T-0001', icon: 'tank', d: 3 }));
  rows.push(treeRow({ name: '20-T-0002  T-02', icon: 'tank', d: 3, sel: 1 }));
  rows.push(treeRow({ name: '20-T-0003', icon: 'tank', d: 3, lock: 1 }));
  rows.push(treeRow({ name: '5 more tanks, 152 items', d: 3, more: 1, tw: 0 }));
  AREAS.slice(1).forEach((a, i) => rows.push(treeRow({ name: a, icon: 'folder', d: 2, tw: 0, ct: AREA_N[i + 1], hid: a.startsWith('Terrain') || a.startsWith('Design'), lock: a.startsWith('Roads') })));
  rows.push(treeRow({ name: 'Point clouds', icon: 'points', grp: 1, tw: 0, ct: 1, hid: 1 }));
  rows.push(treeRow({ name: 'Maps and rasters', icon: 'layers', grp: 1, tw: 1, ct: 2 }));
  rows.push(treeRow({ name: 'Orthomosaic, 21 Feb 2023', icon: 'ortho', d: 1, ct: '0.53 m' }));
  rows.push(treeRow({ name: 'Street map, GCC pack', icon: 'map', d: 1, ct: 'z15' }));
  rows.push(treeRow({ name: 'Video', icon: 'video', grp: 1, tw: 0, ct: 25 }));
  rows.push(treeRow({ name: 'Photos and panoramas', icon: 'photo', grp: 1, tw: 0, ct: 12 }));
  rows.push(treeRow({ name: 'Annotations', icon: 'pin', grp: 1, tw: 0, ct: 9 }));
  return rows.join('');
}
function outlinerHcl() {
  const r = [];
  r.push(treeRow({ name: 'Models', icon: 'cube', grp: 1, tw: 1, ct: 1 }));
  r.push(treeRow({ name: 'Tank 710-D-130335', icon: 'tank', d: 1, tw: 1, ct: 225 }));
  r.push(treeRow({ name: 'Shell, 3 courses', icon: 'mesh', d: 2, tw: 0, ct: 26, badge: 'X-ray' }));
  r.push(treeRow({ name: 'Roof head', icon: 'mesh', d: 2, ct: 2, sel: 1 }));
  r.push(treeRow({ name: 'Rubber lining', icon: 'mesh', d: 2, ct: 5, hid: 1 }));
  r.push(treeRow({ name: 'Nozzles N1 to N9', icon: 'mesh', d: 2, tw: 0, ct: 54 }));
  r.push(treeRow({ name: 'Internals and access', icon: 'mesh', d: 2, tw: 0, ct: 31, lock: 1 }));
  r.push(treeRow({ name: 'Point clouds', icon: 'points', grp: 1, tw: 1, ct: 1 }));
  r.push(treeRow({ name: 'Elios LiDAR, 2 cm', icon: 'points', d: 1, tw: 1, ct: '280 k' }));
  r.push(treeRow({ name: 'Flight 101, shell pass', icon: 'path', d: 2, ct: '140 k' }));
  r.push(treeRow({ name: 'Flight 108, roof', icon: 'path', d: 2, ct: '140 k' }));
  r.push(treeRow({ name: 'Video', icon: 'video', grp: 1, tw: 1, ct: 10 }));
  r.push(treeRow({ name: 'F110 external', icon: 'film', d: 1, ct: '0:11', badge: 'Projected' }));
  r.push(treeRow({ name: 'F108 roof', icon: 'film', d: 1, ct: '0:11' }));
  r.push(treeRow({ name: '8 more flights', d: 1, more: 1 }));
  r.push(treeRow({ name: 'Photos', icon: 'photo', grp: 1, tw: 0, ct: 214 }));
  r.push(treeRow({ name: 'Annotations', icon: 'pin', grp: 1, tw: 1, ct: 12 }));
  r.push(treeRow({ name: 'Issues, client scale 1 to 5', icon: 'flag', d: 1, tw: 0, ct: 11 }));
  r.push(treeRow({ name: 'F12 draft, video box', d: 1, sev: 3, ct: 'new' }));
  return r.join('');
}
function libraryTree() {
  const r = [];
  r.push(treeRow({ name: 'All projects', icon: 'grid', grp: 1, ct: 6, noToggles: 1, sel: 1 }));
  r.push(treeRow({ name: 'Pinned', icon: 'bookmark', ct: 2, noToggles: 1 }));
  r.push(treeRow({ name: 'Shared with me', icon: 'user', ct: 1, noToggles: 1 }));
  r.push(`<div class="sb-head" style="margin-top:6px"><h3>Asset types</h3></div>`);
  [['Plant fusion', 'plant', 1], ['Tank inspection', 'tank', 1], ['Flare / stack', 'flare', 1], ['Facade survey', 'building', 1], ['Stockpile volumes', 'pile', 1], ['Road survey', 'road', 1]]
    .forEach(([n, i, c]) => r.push(treeRow({ name: n, icon: i, ct: c, noToggles: 1 })));
  r.push(`<div class="sb-head" style="margin-top:6px"><h3>Sites</h3></div>`);
  [['Kuwait', 5], ['United Arab Emirates', 1]].forEach(([n, c]) => r.push(treeRow({ name: n, icon: 'pin', ct: c, noToggles: 1 })));
  return r.join('');
}
function renderSidebar(screen) {
  const proj = screen === 'hcl' ? PROJECTS[1] : PROJECTS[0];
  const thumb = ASSETS.thumbs[proj.id] || '';
  const inProject = screen === 'alzour' || screen === 'hcl' || screen === 'settings';
  const nav = [
    ['home', 'Projects', 'home', 'Ctrl 1'],
    ['scene', 'Scene', 'cube', null, screen === 'alzour' || screen === 'hcl'],
    ['issues', 'Issues', 'flag', proj.issues],
    ['media', 'Media', 'film', screen === 'hcl' ? 224 : 37],
    ['report', 'Reports', 'report', screen === 'hcl' ? 1 : 2],
  ];
  $('#sidebar').innerHTML = `
    <div class="sb-brand"><span style="color:var(--t1);display:flex">${MARK(22)}</span><span class="wordmark">STRATLAS</span>
      <button class="sb-collapse" id="sbToggle" aria-label="Collapse sidebar" data-tip="Collapse sidebar" data-kbd="Ctrl B">${ic('sidebar')}</button></div>
    <button class="proj-switch" data-tip="${proj.name}" aria-label="Switch project">
      <span class="thumb" style="background-image:url('${thumb}')"></span>
      <span class="meta"><div class="nm">${proj.name}</div><div class="sub">${proj.client} · ${proj.site}</div></span>
      <span class="chev t3">${ic('updown', 's14')}</span>
    </button>
    <nav class="sb-nav" aria-label="Primary">
      ${nav.map(([id, l, i, extra, cur]) => {
        const current = (id === 'home' && screen === 'home') || cur;
        const tail = typeof extra === 'string' ? `<span class="kbd sb-lbl">${extra}</span>` : (extra != null ? `<span class="cnt sb-lbl">${extra.toLocaleString('en-US')}</span>` : '');
        return `<button class="nav-it" data-nav="${id}" data-tip="${l}" ${current ? 'aria-current="page"' : ''}>${ic(i)}<span class="sb-lbl">${l}</span>${tail}</button>`;
      }).join('')}
    </nav>
    <div class="sb-section">
      <div class="sb-head"><h3>${inProject ? 'Outliner' : 'Library'}</h3><span class="act"><button class="icon-btn" aria-label="Filter">${ic('filter', 's14')}</button><button class="icon-btn" aria-label="Add">${ic('plus', 's14')}</button></span></div>
      <div class="sb-search">${ic('search', 's14')}<span>${inProject ? 'Search layers and assets' : 'Search projects'}</span><span class="mono" style="margin-left:auto;font-size:10.5px">Ctrl F</span></div>
      <div class="tree" role="tree">${screen === 'home' ? libraryTree() : screen === 'hcl' ? outlinerHcl() : outlinerAlzour()}</div>
      <div class="rail-types">
        ${(screen === 'home' ? [] : [['cube', 'Models', screen === 'hcl' ? 1 : 3], ['points', 'Point clouds', 1], ['layers', 'Maps and rasters', 3], ['video', 'Video', screen === 'hcl' ? 10 : 25], ['photo', 'Photos', screen === 'hcl' ? 214 : 12], ['pin', 'Annotations', screen === 'hcl' ? 12 : 9]])
          .map(([i, l, c]) => `<button data-tip="${l}  ${c}">${ic(i)}<i>${c > 99 ? '99+' : c}</i></button>`).join('')}
      </div>
    </div>
    <div class="sb-foot">
      <button class="icon-btn sb-expand" id="sbExpand" aria-label="Expand sidebar" data-tip="Expand sidebar" data-kbd="Ctrl B" style="width:32px;height:32px">${ic('sidebar')}</button>
      <span class="avatar" data-tip="Synapse Solutions">SS</span>
      <span class="who"><b>Synapse Solutions</b><span>Editor licence · offline seat</span></span>
      <button class="icon-btn" data-go="settings" aria-label="Preferences" data-tip="Preferences" data-kbd="Ctrl ,">${ic('gear')}</button>
    </div>`;
  // rail types sit below the nav in collapsed state
  requestAnimationFrame(() => {
    const nav = $('.sb-nav'); const rt = $('.rail-types');
    if (nav && rt) rt.style.top = '6px';
  });
}

/* ------------------------------------------------------------------ tooltips */
function wireTips() {
  const tip = $('#tip');
  document.addEventListener('pointerover', e => {
    const t = e.target.closest('[data-tip]');
    if (!t) return;
    const collapsedOnly = t.closest('.sidebar') && !t.matches('.sb-collapse, .icon-btn');
    if (collapsedOnly && !$('#app').classList.contains('sb-collapsed')) return;
    const r = t.getBoundingClientRect();
    tip.innerHTML = t.dataset.tip + (t.dataset.kbd ? `<kbd>${t.dataset.kbd}</kbd>` : '');
    const inSidebar = !!t.closest('.sidebar');
    tip.style.left = (inSidebar ? r.right + 8 : r.left) + 'px';
    tip.style.top = (inSidebar ? r.top + r.height / 2 - 12 : r.bottom + 6) + 'px';
    tip.classList.add('on');
  });
  document.addEventListener('pointerout', e => { if (e.target.closest('[data-tip]')) tip.classList.remove('on'); });
}

/* ------------------------------------------------------------------ sequencer */
export function makeSeq(host, cfg) {
  host.innerHTML = `
    <div class="seq-bar">
      <span class="tt">${ic('film', 's14')}Sequencer</span><span class="dim" style="font-size:12px;white-space:nowrap">${cfg.subtitle}</span>
      <div class="transport">
        <button aria-label="Go to start">${ic('start', 's14')}</button>
        <button aria-label="Previous key">${ic('keyPrev', 's14')}</button>
        <button class="play" aria-label="Play or pause" data-play>${ic('pause', 's14')}</button>
        <button aria-label="Next key">${ic('keyNext', 's14')}</button>
        <button aria-label="Go to end">${ic('end', 's14')}</button>
        <button aria-label="Loop" style="color:var(--ac)">${ic('loop', 's14')}</button>
      </div>
      <span class="bigtc" data-tc>00:00:00<small>:00</small></span>
      <span class="dd" style="margin-left:6px">1.0×${ic('chevD', 's12')}</span>
      <span class="dd">${ic('key2', 's12')}Snap to frame${ic('chevD', 's12')}</span>
      <div class="zoomer"><span>Ctrl+wheel</span>${ic('zoom', 's14')}<span class="track"><i data-zk style="left:40%"></i></span></div>
    </div>
    <div class="seq-corner">${ic('filter', 's12')}<span>${cfg.filterNote || 'All tracks'}</span></div>
    <div class="ruler" data-ruler></div>
    <div class="tracks-l">${cfg.tracks.map(t => `
      <div class="trow ${t.active ? 'act' : ''}"><span class="ty">${ic(t.icon, 's14')}</span><span class="nm">${t.name}${t.sub ? `<em>${t.sub}</em>` : ''}</span>
      <span class="tg"><button aria-label="Visibility">${ic('eye', 's12')}</button><button aria-label="Lock">${ic(t.lock ? 'lock' : 'unlock', 's12')}</button></span></div>`).join('')}
    </div>
    <div class="tracks-r" data-lanes></div>`;
  const ruler = host.querySelector('[data-ruler]');
  const lanes = host.querySelector('[data-lanes]');
  const state = { t0: cfg.t0, t1: cfg.t1, ph: cfg.playhead };
  const W = () => lanes.clientWidth || 600;
  const x = t => (t - state.t0) / (state.t1 - state.t0) * W();

  function draw() {
    const w = W(); const span = state.t1 - state.t0;
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const maj = steps.find(s => w / (span / s) > 70) || 600;
    const minor = maj / 5;
    let h = '';
    for (let t = Math.ceil(state.t0 / minor) * minor; t <= state.t1; t += minor) {
      const isMaj = Math.abs(t / maj - Math.round(t / maj)) < 1e-6;
      h += `<i class="tk ${isMaj ? 'maj' : 'min'}" style="left:${x(t)}px"></i>`;
      if (isMaj) h += `<span class="lb" style="left:${x(t)}px">${cfg.fmt(t)}</span>`;
    }
    h += `<div class="playhead ruler-ph" data-ph2></div>`;
    ruler.innerHTML = h;
    let L = '';
    if (cfg.range) L += `<div class="range-shade" style="left:${x(cfg.range[0])}px;width:${x(cfg.range[1]) - x(cfg.range[0])}px"></div>`;
    cfg.tracks.forEach((t, i) => {
      let inner = '';
      (t.items || []).forEach(it => {
        const l = x(it.a), r = x(it.b);
        inner += `<div class="clip ${t.kind || ''} ${it.on ? 'on' : ''} ${it.dim ? 'dimc' : ''}" style="left:${l}px;width:${Math.max(4, r - l)}px" ${it.film ? `data-film="${it.film}"` : ''}>${it.film ? '<span class="film"></span>' : ''}<span class="lb">${it.label || ''}</span></div>`;
      });
      (t.ticks || []).forEach(tt => inner += `<i class="tick" style="left:${x(tt)}px"></i>`);
      (t.keys || []).forEach(k => inner += `<i class="kf ${k.ac ? 'ac' : ''}" style="left:${x(k.t)}px;${k.c ? `background:${k.c}` : ''}"></i>`);
      if (t.graph) {
        const pts = []; const n = 120;
        for (let j = 0; j <= n; j++) { const tt = state.t0 + span * j / n; pts.push(`${(j / n * w).toFixed(1)},${(20 - t.graph(tt) * 18).toFixed(1)}`); }
        inner += `<svg class="lane-graph" viewBox="0 0 ${w} 22" preserveAspectRatio="none"><polyline points="${pts.join(' ')}" fill="none" stroke="oklch(0.74 0.105 240)" stroke-width="1.25" vector-effect="non-scaling-stroke"/></svg>`;
      }
      L += `<div class="tlane ${t.active ? 'act' : ''}" style="top:${i * 26}px">${inner}</div>`;
    });
    L += `<div class="playhead" data-ph></div>`;
    lanes.innerHTML = L;
    fillFilm();
    setPlayhead(state.ph);
  }
  function fillFilm() {
    lanes.querySelectorAll('[data-film]').forEach(el => {
      const frames = FILM[el.dataset.film];
      if (!frames) return;
      const f = el.querySelector('.film'); const w = el.clientWidth; const fw = 34;
      const n = Math.ceil(w / fw);
      f.innerHTML = Array.from({ length: n }, (_, i) => `<div style="width:${fw}px;background:url(${frames[Math.floor(i / n * frames.length)]}) center/cover"></div>`).join('');
    });
  }
  function setPlayhead(t) {
    state.ph = t;
    const px = x(t);
    const a = lanes.querySelector('[data-ph]'); const b = ruler.querySelector('[data-ph2]');
    if (a) a.style.transform = `translateX(${px}px)`;
    if (b) b.style.transform = `translateX(${px}px)`;
    const tc = host.querySelector('[data-tc]');
    if (tc) tc.innerHTML = cfg.tc(t);
  }
  lanes.addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const r = lanes.getBoundingClientRect();
    const f = (e.clientX - r.left) / r.width; const tm = state.t0 + f * (state.t1 - state.t0);
    const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const span = Math.min(cfg.maxSpan || 3600, Math.max(4, (state.t1 - state.t0) * k));
    state.t0 = tm - f * span; state.t1 = state.t0 + span;
    const zk = host.querySelector('[data-zk]'); if (zk) zk.style.left = Math.max(5, Math.min(95, 100 - span / (cfg.maxSpan || 3600) * 100)) + '%';
    draw();
  }, { passive: false });
  new ResizeObserver(() => draw()).observe(lanes);
  draw();
  return { setPlayhead, draw, refreshFilm: fillFilm, host };
}

/* filmstrips captured from the real clips */
export const FILM = {};
export async function captureFrames(src, times, w = 160, h = 90) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.src = src; v.crossOrigin = 'anonymous';
    const out = []; let i = 0;
    const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
    const next = () => {
      if (i >= times.length) { resolve(out); v.removeAttribute('src'); v.load(); return; }
      const t = typeof times[i] === 'function' ? times[i](v.duration) : times[i];
      v.currentTime = Math.min(Math.max(0, t), (v.duration || 1) - 0.05);
    };
    v.addEventListener('seeked', () => { g.drawImage(v, 0, 0, w, h); out.push(c.toDataURL('image/jpeg', 0.72)); i++; next(); });
    v.addEventListener('loadeddata', next, { once: true });
    v.addEventListener('error', () => resolve(out), { once: true });
  });
}

/* ------------------------------------------------------------------ shared fragments */
const gizmo = id => `<div class="ovl gizmo"><svg viewBox="-42 -42 84 84" data-gizmo="${id}">
  <circle r="40" fill="oklch(0.16 0.005 255 / .55)" stroke="oklch(1 0 0 / .06)"/>
  <g data-axes></g></svg>
  <div class="navbtns"><button aria-label="Zoom" data-tip="Zoom">${ic('zoom', 's14')}</button><button aria-label="Pan" data-tip="Pan">${ic('hand', 's14')}</button><button aria-label="Camera view" data-tip="Drone eye">${ic('camera', 's14')}</button><button aria-label="Perspective" data-tip="Toggle ortho">${ic('persp', 's14')}</button></div></div>`;

const toolcol = (active = 'select') => `<div class="ovl toolcol" role="toolbar" aria-label="Tools">
  ${[['select', 'Select', 'Q'], ['move', 'Move', 'W'], ['rotate', 'Rotate', 'E']].map(([i, l, k]) => `<button aria-pressed="${active === i}" data-tip="${l}" data-kbd="${k}">${ic(i)}</button>`).join('')}
  <hr>
  ${[['ruler', 'Measure distance', 'M'], ['height', 'Measure height', 'H'], ['area', 'Measure area', 'A'], ['section', 'Section plane', 'X']].map(([i, l, k]) => `<button aria-pressed="${active === i}" data-tip="${l}" data-kbd="${k}">${ic(i)}<span class="corner"></span></button>`).join('')}
  <hr>
  ${[['pin', 'Annotate on mesh', 'N'], ['target', 'Focus selection', 'F']].map(([i, l, k]) => `<button aria-pressed="${active === i}" data-tip="${l}" data-kbd="${k}">${ic(i)}</button>`).join('')}
</div>`;

const VIEWMODES = [['sun', 'Lit', '1'], ['ortho', 'Ortho texture', '2'], ['points', 'Point cloud EDL', '3'], ['wire', 'Wireframe', '4']];
const viewHead = (id, mode, bms) => `<div class="vhead">
  <button class="ed" data-tip="Editor type: 3D Viewport">${ic('cube', 's14')}${ic('chevD', 's12')}</button>
  <span class="sep"></span>
  <button class="dd" data-vm="${id}">${ic(VIEWMODES.find(v => v[1] === mode)[0], 's12')}<span>${mode}</span>${ic('chevD', 's12')}</button>
  <button class="dd">${ic('persp', 's12')}Perspective${ic('chevD', 's12')}</button>
  <span class="sep"></span>
  ${bms.map((b, i) => `<button class="bm" data-bm="${id}" aria-pressed="${i === 0}">${ic('bookmark', 's12')}${b}</button>`).join('')}
  <button class="icon-btn" aria-label="Add bookmark" data-tip="Save camera bookmark">${ic('plus', 's14')}</button>
  <span style="margin-left:auto"></span>
  <button class="icon-btn" aria-label="Split" data-tip="Split view">${ic('split', 's14')}</button>
  <button class="icon-btn" aria-label="Maximise" data-tip="Maximise pane" data-kbd="Ctrl Space">${ic('max', 's14')}</button>
</div>`;

/* ------------------------------------------------------------------ screen: home */
function renderHome() {
  const P0 = PROJECTS;
  const card = (p, i) => `<button class="pcard ${i === 0 ? 'sel' : ''}" data-open="${p.id}">
      <div class="img" style="background-image:url('${ASSETS.thumbs[p.id] || ''}')">
        <span class="type">${ic(p.icon, 's12')}${p.type}</span>
        <span class="off ${p.offline.startsWith('Ready') ? '' : 'part'}"><span class="dot"></span>${p.offline}</span>
      </div>
      <div><div class="nm">${p.name}</div><div class="meta"><span>${p.client}</span><span>·</span><span>${p.site}</span><span>·</span><span>${p.date}</span></div></div>
    </button>`;
  $('#scr-home').innerHTML = `
    <div class="home-main">
      <div class="h-top">
        <div><h1>Projects</h1><p>Six projects on this machine, 134.7 GB. All open without a network.</p></div>
        <div class="act"><button class="btn">${ic('download', 's14')}Import package</button><button class="btn primary">${ic('plus', 's14')}New project</button></div>
      </div>
      <section class="h-sec">
        <h2>Recent <span class="ct">6</span><span class="act"><span class="seg"><button aria-pressed="true">${ic('grid', 's12')}</button><button aria-pressed="false">${ic('list', 's12')}</button></span></span></h2>
        <div class="recent">${P0.slice(0, 4).map(card).join('')}</div>
      </section>
      <section class="h-sec">
        <h2>Start from a template <span class="note">Each sets the layer tree, severity model and report layout</span></h2>
        <div class="tpl-row">
          ${[['plant', 'Plant fusion', 'Mesh on ortho, video with flight logs, panoramas, area tree'],
             ['tank', 'Tank inspection', 'Tank mesh, LiDAR, projected video, nozzle schedule, tank severity'],
             ['flare', 'Flare / stack', 'Photo set with poses, findings by elevation band'],
             ['building', 'Facade survey', 'Elevation tiles, defect classes per facade, 5-level model'],
             ['pile', 'Stockpile volumes', 'Two survey dates, pile bases, cut and fill'],
             ['road', 'Road survey', 'Ortho at 1.25 cm GSD, chainage, ASTM D6433 PCI'],
             ['blank', 'Blank scene', 'Empty scene with project CRS and local origin'],
             ['mesh', 'Model from drawings', 'Build a 3D model from plot plans and point clouds']]
            .map(([i, n, d], k) => `<button class="tpl ${k === 7 ? 'soon' : ''}"><span class="ic">${ic(i, 's20')}</span><b>${n}${k === 7 ? '<span class="tagx">Roadmap</span>' : ''}</b><span>${d}</span></button>`).join('')}
        </div>
      </section>
      <section class="h-sec">
        <h2>All projects <span class="ct">6 · 134.7 GB</span><span class="act"><span class="dd">Sort: last opened${ic('chevD', 's12')}</span></span></h2>
        <div class="list">
          <div class="lrow h"><span></span><span>Project</span><span>Type</span><span>Layers</span><span>Captured</span><span style="text-align:right">Size</span></div>
          ${P0.map(p => `<div class="lrow" data-open="${p.id}"><span class="th" style="${ASSETS.thumbs[p.id] ? `background-image:url('${ASSETS.thumbs[p.id]}')` : 'display:grid;place-items:center;color:var(--t3)'}">${ASSETS.thumbs[p.id] ? '' : ic(p.icon)}</span><span><b>${p.name}</b><small>${p.client} · ${p.site}</small></span><span class="t3">${p.type}</span><span class="mono">${p.layers.map(l => l[1]).slice(0, 3).join(' · ')}</span><span class="mono">${p.date}</span><span class="mono" style="text-align:right">${p.size}</span></div>`).join('')}
        </div>
      </section>
    </div>
    <aside class="home-side">
      <div class="hs-sec">
        <div class="detail-img" style="background-image:url('${ASSETS.thumbs.alzourWide || ASSETS.thumbs.alzour || ''}')" data-detail-img></div>
        <h3 style="font-size:14px;margin-bottom:2px">Al-Zour LNG Terminal</h3>
        <p class="t3" style="font-size:12px;margin-bottom:12px">KIPIC · Al-Zour, Kuwait · Plant fusion</p>
        <dl class="kv">
          <dt>Captured</dt><dd>21 Feb 2023</dd>
          <dt>On disk</dt><dd>38.6 GB</dd>
          <dt>CRS</dt><dd>Plant grid, UTM 39N</dd>
          <dt>Model</dt><dd>909 nodes, 12 areas</dd>
          <dt>Point cloud</dt><dd>842 M pts, streamed</dd>
          <dt>Video</dt><dd>25 clips, Mavic 3 Cine</dd>
          <dt>Panoramas</dt><dd>12</dd>
          <dt>Issues</dt><dd>9 open, 2 high</dd>
          <dt>Offline</dt><dd class="txt" style="color:var(--ac)">Ready, maps cached</dd>
        </dl>
        <div style="display:flex;gap:6px;margin-top:14px"><button class="btn primary" data-go="alzour" style="flex:1;justify-content:center">Open project</button><button class="btn">${ic('more', 's14')}</button></div>
      </div>
      <div class="hs-sec">
        <h3>${ic('map', 's14')}Offline map packs<span class="act"><button class="btn ghost sm" data-go="settings" data-pane="maps">Manage</button></span></h3>
        ${[['GCC streets, vector', '6.4 GB', 'Installed · 14 Sep 2025', ''], ['World overview, z0 to z8', '1.1 GB', 'Installed · 02 Aug 2025', ''], ['Kuwait detail update', '412 MB', 'Update available, Sep 2025', 'upd'], ['Arabic labels', '96 MB', 'Downloading', 'dl']]
          .map(([n, s, st, k]) => `<div class="pack"><b>${n}</b><span class="sz">${s}</span><span class="st ${k}"><span class="dot"></span>${st}</span>${k === 'dl' ? '<span class="sz">64%</span><div class="prog"><i style="width:64%"></i></div>' : '<span></span>'}</div>`).join('')}
      </div>
      <div class="hs-sec" style="border-bottom:0">
        <h3>${ic('clock', 's14')}Recent activity</h3>
        ${[['flag', '<b>F12 draft</b> added on HCl tank, video box', '09:41'], ['agent', 'Agent filtered <b>4 clips</b> over T-02', '09:38'], ['doc', 'Report draft v3 exported, EBSM', 'Yesterday'], ['download', 'Imported <b>DAMAC</b> photo batch 7 of 9', 'Mon']]
          .map(([i, t, d]) => `<div class="act-row">${ic(i, 's14')}<span>${t}</span><time>${d}</time></div>`).join('')}
      </div>
    </aside>`;
}

/* ------------------------------------------------------------------ screen: Al-Zour */
function renderAlzour() {
  $('#scr-alzour').innerHTML = `
  <div class="stage" style="--seq-h:214px">
    <div class="split" style="--a:1.5fr;--b:1fr" data-split>
      <div class="vpane">
        ${viewHead('az', 'Lit', ['Overview', 'T-02 roof'])}
        <div class="vbody" id="vp-az">
          <div class="loading" data-loading><span>Loading plant, 909 nodes</span><span class="bar"></span></div>
          ${toolcol('select')}
          ${gizmo('az')}
          <div class="ovl stats" id="stats-az"><b>Plant</b> 909 nodes · 12 areas<br><b>Ortho</b> 21 Feb 2023 · video on ground<br><b>Cloud</b> hidden · 842 M pts</div>
        </div>
      </div>
      <div class="gutter v" data-gutter></div>
      <div class="vpane">
        <div class="vhead">
          <button class="ed">${ic('video', 's14')}<span>Video</span>${ic('chevD', 's12')}</button><span class="sep"></span>
          <span class="dd" id="az-clipname">${ic('film', 's12')}<span>DJI_0789 · Flight 4</span>${ic('chevD', 's12')}</span>
          <span style="margin-left:auto"></span>
          <button class="icon-btn" aria-pressed="true" data-tip="Sync with 3D and timeline">${ic('link', 's14')}</button>
          <button class="icon-btn" data-tip="Agent for this window">${ic('agent', 's14')}</button>
          <button class="icon-btn" data-tip="Maximise pane">${ic('max', 's14')}</button>
        </div>
        <div class="video-wrap" id="az-vwrap">
          <video id="az-video" muted playsinline loop preload="auto"></video>
          <div class="hud"><div class="tl"><span class="rec"></span><span id="az-hud-id">DJI_0789</span><span id="az-hud-t">00:00.0</span></div><div class="tr2" id="az-hud-r">Mavic 3 Cine · 24 mm</div>
            <svg class="ret" viewBox="0 0 18 18"><path d="M9 2v4M9 12v4M2 9h4M12 9h4" stroke="white" stroke-opacity=".8" stroke-width="1.2"/></svg>
            <div class="bl"><span><b>AGL</b><span id="az-alt">104 m</span></span><span><b>GIMBAL</b><span id="az-gmb">-25.3°</span></span><span><b>HDG</b><span id="az-hdg">088°</span></span></div></div>
        </div>
        <div class="vbar"><span class="tc" id="az-tc">00:00.0</span><div class="scrub" id="az-scrub"><span class="p"></span><span class="h"></span></div><span class="tc dim" id="az-dur">00:00.0</span></div>
        <div class="telem">
          <div><span class="k">To T-02</span><span class="v" id="az-d">212<small>m</small></span></div>
          <div><span class="k">Footprint</span><span class="v" id="az-fp">164 × 92<small>m</small></span></div>
          <div><span class="k">GSD</span><span class="v" id="az-gsd">3.4<small>cm</small></span></div>
          <div><span class="k">T-02 roof</span><span class="v" id="az-roof" style="color:var(--ac)">Yes</span></div>
        </div>
        <div class="panel" style="flex:1;min-height:0">
          <div class="ph"><span class="tt">${ic('photo', 's14')}Frames with T-02 roof</span><span class="sub">41 frames in 4 clips, from the agent</span><span class="act"><button class="icon-btn">${ic('more', 's14')}</button></span></div>
          <div id="az-frames" style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:8px;overflow:auto"></div>
        </div>
      </div>
    </div>
    <div class="gutter h"></div>
    <div class="seq" id="seq-az"></div>
  </div>
  <div class="gutter v"></div>
  <div class="dock" style="grid-template-rows:auto 1px minmax(0,1fr)">
    <div class="panel">
      <div class="ph"><div class="tabs" role="tablist"><button aria-selected="true">Details</button><button aria-selected="false">Layer</button><button aria-selected="false">Scene</button></div><span class="act"><button class="icon-btn">${ic('lock', 's14')}</button><button class="icon-btn">${ic('more', 's14')}</button></span></div>
      <div style="padding:8px 10px 8px 12px;border-bottom:1px solid var(--ln0);display:flex;gap:10px;align-items:center">
        <span style="width:30px;height:30px;border-radius:var(--r2);background:var(--ac-bg2);display:grid;place-items:center;color:var(--ac)">${ic('tank')}</span>
        <div style="min-width:0"><div style="color:var(--t1);font-weight:600;font-size:13.5px">20-T-0002 <span class="t3" style="font-weight:400">LNG storage tank</span></div><div class="dim" style="font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Al-Zour plant / 20 LNG tanks / T-02</div></div>
      </div>
      <div class="props">
        <details class="pg" open><summary>${ic('chevR', 's12 chev')}Georeference<span class="aside">Plant grid</span></summary><div class="body">
          <div class="prow"><span class="k">Location</span><div class="vec"><span class="fld num"><span class="ax" style="color:var(--ax-x)">E</span>1 446.0</span><span class="fld num"><span class="ax" style="color:var(--ax-y)">N</span>555.4</span><span class="fld num"><span class="ax" style="color:var(--ax-z)">EL</span>100.0</span></div></div>
          <div class="prow"><span class="k">Grid to UTM</span><span class="fld num">+17.999<span class="u">°</span></span></div>
          <div class="prow"><span class="k">Dimensions</span><div class="vec" style="grid-template-columns:1fr 1fr"><span class="fld num"><span class="ax t3">Ø</span>87.6<span class="u">m</span></span><span class="fld num"><span class="ax t3">H</span>51.4<span class="u">m</span></span></div></div>
        </div></details>
        <details class="pg"><summary>${ic('chevR', 's12 chev')}Asset<span class="aside">Register row 412</span></summary><div class="body">
          <div class="prow"><span class="k">Service</span><span class="fld">LNG storage, full containment</span></div>
          <div class="prow"><span class="k">Capacity</span><span class="fld num">225 000<span class="u">m³</span></span></div>
          <div class="prow"><span class="k">Linked</span><div class="chips"><span class="chip">${ic('video', 's12')}6 clips</span><span class="chip">${ic('pano', 's12')}3 panos</span><span class="chip">${ic('flag', 's12')}2 issues</span></div></div>
        </div></details>
        <details class="pg"><summary>${ic('chevR', 's12 chev')}Display<span class="aside">Lit, 100%</span></summary><div class="body">
          <div class="prow"><span class="k">Opacity</span><div class="slider"><span class="fill" style="width:100%"></span><span>Opacity</span><span class="v">1.00</span></div></div>
        </div></details>
        <details class="pg"><summary>${ic('chevR', 's12 chev')}Metadata<span class="aside">14 fields</span></summary><div class="body"></div></details>
      </div>
    </div>
    <div class="gutter h"></div>
    <div class="agent">
      <div class="ph"><span class="tt">${ic('agent', 's14')}Agent</span><span class="sub">3D Viewport</span><span class="act"><button class="icon-btn" data-tip="History">${ic('clock', 's14')}</button><button class="icon-btn" data-tip="Detach to window">${ic('max', 's14')}</button></span></div>
      <div class="ctxbar"><span class="ctx sel">${ic('tank', 's12')}20-T-0002</span><span class="ctx">${ic('layers', 's12')}7 layers</span><span class="ctx">${ic('video', 's12')}DJI_0789 · 15:11:22</span><span class="ctx">${ic('camera', 's12')}Camera</span></div>
      <div class="convo" id="az-convo">
        <div class="msg-u">Show me every clip that passes over Tank T-02 and the frames where the roof is visible.</div>
        <div class="msg-a">
          <div class="who-a"><span class="glyph">${ic('agent', 's12')}</span>Claude Sonnet 4.5 · 4 steps</div>
          <div class="steps">
            <div class="step"><span class="st">${ic('check', 's12')}</span><span class="fn">query_footprints<em>(20-T-0002, 60 m)</em></span><span class="res">6 clips</span></div>
            <div class="step"><span class="st">${ic('check', 's12')}</span><span class="fn">find_frames<em>(roof visible)</em></span><span class="res">41 frames</span></div>
            <div class="step"><span class="st">${ic('check', 's12')}</span><span class="fn">filter_timeline<em>(4 clips)</em></span><button class="undo">${ic('undo', 's12')}Undo</button></div>
            <div class="step pending"><span class="st wait"></span><span class="fn">fly_to<em>(T-02 roof)</em></span><span class="res" style="color:var(--warn)">Needs approval</span>
              <div class="acts"><button class="btn primary sm">${ic('check', 's12')}Approve</button><button class="btn sm">Skip</button></div></div>
          </div>
          T-02 is <b>20-T-0002</b>. <b>6 clips</b> have a footprint within 60 m of it. The roof is visible in <b>41 frames</b> across 4 of them. DJI_0789 is the clearest pass: 104 m above grade, gimbal −25°, roof in frame from 00:06. I filtered the sequencer to those 4 clips and keyed the frames.
          <div class="results" id="az-results"></div>
        </div>
      </div>
      <div class="composer"><textarea placeholder="Ask about this view, or tell the agent what to do" aria-label="Message"></textarea>
        <div class="cb"><button class="icon-btn" aria-label="Attach">${ic('clip', 's14')}</button><button class="icon-btn" aria-label="Add context">${ic('target', 's14')}</button><button class="model">${ic('cloud', 's12')}Claude Sonnet 4.5${ic('chevD', 's12')}</button><button class="send" aria-label="Send">${ic('send', 's14')}</button></div></div>
      <div class="meter"><span>12.4k tokens · $0.04</span><span>Frames + text allowed</span></div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ screen: HCl */
function renderHcl() {
  const iss = HCL_ISSUES;
  $('#scr-hcl').innerHTML = `
  <div class="stage" style="--seq-h:190px">
    <div class="split" style="--a:0.85fr;--b:1.15fr" data-split>
      <div class="vpane">
        ${viewHead('hcl', 'Point cloud EDL', ['Roof NE', 'F12 close'])}
        <div class="vbody" id="vp-hcl">
          <div class="loading" data-loading><span>Loading tank and 280 k points</span><span class="bar"></span></div>
          ${toolcol('pin')}
          ${gizmo('hcl')}
          <div class="ovl stats"><b>Mesh</b> 225 nodes · shell X-ray 30%<br><b>Cloud</b> 280 k pts · intensity<br><b>Video</b> F110 on mesh · f-theta 114°</div>
        </div>
      </div>
      <div class="gutter v" data-gutter></div>
      <div class="vpane">
        <div class="vhead">
          <button class="ed">${ic('video', 's14')}<span>Video</span>${ic('chevD', 's12')}</button><span class="sep"></span>
          <span class="dd">${ic('film', 's12')}<span>Flight 110, external</span>${ic('chevD', 's12')}</span>
          <span class="seg"><button aria-pressed="true">Annotate</button><button aria-pressed="false">Review</button></span>
          <span style="margin-left:auto"></span>
          
          <button class="icon-btn" aria-pressed="true" data-tip="Sync with 3D and timeline">${ic('link', 's14')}</button>
          <button class="icon-btn" aria-pressed="true" data-tip="Agent for this window">${ic('agent', 's14')}</button>
          <button class="icon-btn" data-tip="Maximise pane">${ic('max', 's14')}</button>
        </div>
        <div class="video-wrap" id="hcl-vwrap">
          <video id="hcl-video" muted playsinline preload="auto"></video>
          <div class="hud"><div class="tl"><span>F110</span><span id="hcl-hud-t">00:04.27</span><span style="opacity:.7">frame 128 / 330</span></div><div class="tr2">Elios 3 · f-theta 114°</div>
            <div class="bl"><span><b>Z</b>10.38 m</span><span><b>STANDOFF</b>2.9 m</span><span><b>TILT</b>38.1°</span><span><b>BRG</b>212°</span></div></div>
          <div class="ovl annot-tools" role="toolbar" aria-label="Annotation tools">
            ${[['select', 'Select', 'V'], ['box', 'Box', 'B', 1], ['rbox', 'Rotated box', 'R'], ['poly', 'Polygon', 'P'], ['point', 'Point', '.'], ['brush', 'Brush mask', 'K']].map(([i, l, k, on]) => `<button aria-pressed="${!!on}" data-tip="${l}" data-kbd="${k}">${ic(i)}</button>`).join('')}
            <hr>
            ${[['track', 'Track across frames', 'T'], ['event', 'Time-range event', 'E']].map(([i, l, k]) => `<button data-tip="${l}" data-kbd="${k}">${ic(i)}</button>`).join('')}
          </div>
          <div class="drawbox" id="drawbox" style="left:51.5%;top:35%;width:17%;height:16.5%">
            <span class="lab">F12 · Coating breakdown</span>
            <i class="hd" style="left:0;top:0"></i><i class="hd" style="left:100%;top:0"></i><i class="hd" style="left:0;top:100%"></i><i class="hd" style="left:100%;top:100%"></i>
            <span class="dims">218 × 119 px · 0.46 × 0.25 m</span>
          </div>
          <svg class="cursor-x" id="cursorx" style="left:68.5%;top:51.5%" viewBox="0 0 21 21"><path d="M10.5 1v7M10.5 13v7M1 10.5h7M13 10.5h7" stroke="white" stroke-width="1.5"/><path d="M10.5 1v7M10.5 13v7M1 10.5h7M13 10.5h7" stroke="black" stroke-opacity=".5" stroke-width="3" style="mix-blend-mode:multiply"/></svg>
          <div class="qpop" style="left:calc(51.5% - 230px);top:35%">
            <div class="row"><b style="color:var(--t1);font-weight:600;font-size:12px">Class</b><span class="kbdk">Tab</span></div>
            <div class="opt">${ic('flag', 's12')}Coating blister<span class="kbdk">1</span></div>
            <div class="opt on">${ic('flag', 's12')}Coating breakdown<span class="kbdk">2</span></div>
            <div class="opt">${ic('flag', 's12')}Corrosion<span class="kbdk">3</span></div>
            <div class="row" style="margin-top:2px"><b style="color:var(--t1);font-weight:600;font-size:12px">Severity</b><span class="dim" style="font-size:11px">Tank lining v2</span></div>
            <div class="sevpick">${[5, 4, 3, 2, 1].map(s => `<button aria-pressed="${s === 3}"><i class="sev${s}"></i>${s}</button>`).join('')}<button title="Uncertain, not graded"><i class="hatch"></i>U</button></div>
          </div>
        </div>
        <div class="vbar"><button class="icon-btn" id="hcl-play" aria-label="Play">${ic('play', 's14')}</button><span class="tc" id="hcl-tc">00:04.27</span><div class="scrub" id="hcl-scrub"><span class="p"></span><span class="k ac" style="left:38.8%"></span><span class="k" style="left:29%"></span><span class="k" style="left:52.7%"></span><span class="h"></span></div><span class="tc dim">00:11.00</span></div>
        <div class="inline-agent">
          <div class="q"><span class="who-a" style="margin:0"><span class="glyph">${ic('agent', 's12')}</span></span>
            <div><span class="dim" style="font-size:11.5px;display:block;margin-bottom:3px">Agent · Video · Gemini 2.5 Pro</span>This box sits on the roof head, 0.6 m north-east of nozzle N4. The same breakdown is visible in <b class="t1" style="font-weight:500">3 more frames</b> of Flight 110 (03.2 s to 05.8 s). It back-projects onto the mesh as a 0.46 × 0.25 m patch.</div></div>
          <div class="propose"><span class="sev sev-3"><i>3</i></span><span><b class="t1" style="font-weight:500">Track F12 across 3 frames</b><span class="dim" style="display:block;font-size:11.5px">Adds 3 keyframes as drafts. You approve each.</span></span><span style="display:flex;gap:6px"><button class="btn sm">Skip</button><button class="btn primary sm">${ic('check', 's12')}Approve</button></span></div>
        </div>
        <div class="panel" style="flex:1;min-height:0;border-top:1px solid var(--ln0)">
          <div class="ph"><span class="tt">${ic('track', 's14')}F12 across frames</span><span class="sub">1 keyed, 3 proposed, positions from the flight log</span></div>
          <div id="hcl-keys" style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:8px 10px;overflow:hidden"></div>
        </div>
      </div>
    </div>
    <div class="gutter h"></div>
    <div class="seq" id="seq-hcl"></div>
  </div>
  <div class="gutter v"></div>
  <div class="dock" style="grid-template-rows:minmax(0,1fr) 1px auto;--dock-w:316px">
    <div class="panel">
      <div class="ph"><div class="tabs" role="tablist"><button aria-selected="true">Issues <span class="ct">12</span></button><button aria-selected="false">Nozzles <span class="ct">9</span></button><button aria-selected="false">Photos</button></div><span class="act"><button class="icon-btn">${ic('filter', 's14')}</button></span></div>
      <div style="padding:8px 10px;display:flex;gap:6px;align-items:center;border-bottom:1px solid var(--ln0)">
        <div class="scale-bar" style="flex:1">${[[5, 2], [4, 4], [3, 6]].map(([s, n]) => `<i class="sev${s}" style="flex:${n}"></i>`).join('')}</div>
        <span class="mono dim" style="font-size:11px">2 · 4 · 5 + 1 draft</span>
      </div>
      <div class="issues">
        <div class="iss-h"><span>ID</span><span>Sev</span><span>Issue</span><span style="text-align:right">Height</span></div>
        <div class="iss sel draft"><span class="id">F12</span><span class="sev sev-3"><i>3</i></span><span class="ttl">Coating breakdown<small>Roof head · draft · 2 sightings</small></span><span class="loc">9.62 m</span></div>
        ${iss.map(f => `<div class="iss"><span class="id">${f.id}</span><span class="sev sev-${f.sev}"><i>${f.sev}</i></span><span class="ttl">${f.title}<small>${f.area} · ${f.cls}</small></span><span class="loc">${f.h.toFixed(2)} m</span></div>`).join('')}
      </div>
    </div>
    <div class="gutter h"></div>
    <div class="panel" style="max-height:330px">
      <div class="ph"><span class="tt">F12</span><span class="sub">Draft · created 09:41 by you</span><span class="act"><button class="btn primary sm">Submit for review</button></span></div>
      <div class="props" style="padding:0">
        <div class="body" style="padding:10px 10px 4px 12px;display:flex;flex-direction:column;gap:4px">
          <div class="prow"><span class="k">Class</span><span class="dd" style="justify-content:space-between">Coating breakdown${ic('chevD', 's12')}</span></div>
          <div class="prow"><span class="k">Severity</span><div class="sevpick">${[5, 4, 3, 2, 1].map(s => `<button aria-pressed="${s === 3}"><i class="sev${s}"></i>${s}</button>`).join('')}<button><i class="hatch"></i>U</button></div></div>
          <div class="prow"><span class="k">Criteria</span><span class="t3" style="font-size:11.5px;line-height:1.35">Intact coating loss, no substrate exposed. Re-inspect in 12 months.</span></div>
        </div>
        <div style="padding:6px 10px 10px 12px;display:flex;flex-direction:column;gap:4px">
          <div class="dim" style="font-size:11px;margin-bottom:2px">Sightings</div>
          <div class="sighting"><span class="th" id="sight-frame"></span><span><b>Video frame, box</b><span>F110 · 00:04.27</span></span>${ic('video', 's14')}</div>
          <div class="sighting"><span class="th" style="background:var(--s3);display:grid;place-items:center;color:var(--sev3)">${ic('mesh', 's14')}</span><span><b>Mesh patch, back-projected</b><span>Roof head · 0.12 m²</span></span>${ic('cube', 's14')}</div>
        </div>
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ screen: settings */
function renderSettings() {
  const routes = [
    ['Agent chat', 'All windows', 'Anthropic', 'Claude Sonnet 4.5', 'Cloud'],
    ['Image and video understanding', 'Photo, video, detection', 'Google', 'Gemini 2.5 Pro', 'Cloud'],
    ['Report writing', 'Findings to PDF text', 'Anthropic', 'Claude Opus 4.1', 'Cloud'],
    ['Structured extraction', 'Tables, nozzle schedules', 'OpenAI', 'GPT-5 mini', 'Cloud'],
    ['Model building', 'From drawings and clouds', 'Not set', 'Release B', 'Later'],
  ];
  const windows = [['cube', '3D viewport', 'Act with approval', true], ['map', 'Map', 'Act with approval', true], ['points', 'Point cloud', 'Read only', true], ['photo', 'Photo', 'Act with approval', true], ['video', 'Video', 'Act with approval', true], ['doc', 'Report', 'Draft only', true], ['flag', 'Issues', 'Act with approval', false]];
  $('#scr-settings').innerHTML = `
  <div class="prefs" role="dialog" aria-label="Preferences">
    <div class="prefs-tb">${MARK(14)}<span>Preferences</span><span class="dim">· saved to this machine</span><div class="win-btns"><button aria-label="Minimise">${ic('minimize', 's14')}</button><button class="close" aria-label="Close" data-go="alzour">${ic('x', 's14')}</button></div></div>
    <div class="prefs-body">
      <nav class="prefs-nav" aria-label="Preference sections">
        <span class="grp">General</span>
        <button>${ic('sidebar', 's14')}Interface</button>
        <button>${ic('cube', 's14')}Viewport</button>
        <button>${ic('key2', 's14')}Keymap</button>
        <span class="grp">Intelligence</span>
        <button data-pane="ai" aria-selected="true">${ic('agent', 's14')}AI and agents<span class="n">3</span></button>
        <button data-pane="privacy">${ic('shield', 's14')}Privacy and data</button>
        <span class="grp">Data</span>
        <button data-pane="maps">${ic('map', 's14')}Offline maps<span class="n">4</span></button>
        <button data-pane="sev">${ic('flag', 's14')}Severity models<span class="n">7</span></button>
        <button>${ic('folder', 's14')}File paths</button>
        <button>${ic('cpu', 's14')}System and GPU</button>
      </nav>
      <div class="prefs-main">
        <!-- AI -->
        <section class="pp on" data-pp="ai">
          <div class="pp-h"><div><h2>AI and agents</h2><p>Keys stay in the Windows Credential Manager and never enter project files or logs. Nothing is sent to a provider unless cloud AI is allowed here and by the project policy.</p></div></div>
          <div class="bigswitch" role="group" aria-label="AI mode">
            <button aria-pressed="false"><span class="radio"></span><b>Offline only</b><span>No AI calls leave this machine. Agents use local tools only.</span></button>
            <button aria-pressed="true"><span class="radio"></span><b>Allow cloud AI</b><span>Providers below may be used, within each project's data policy.</span></button>
          </div>
          <div class="cols2">
            <div class="box">
              <div class="box-h"><h3>Providers</h3><p>3 configured</p><span class="act"><button class="btn sm">${ic('plus', 's12')}Local model</button></span></div>
              ${[['A', 'Anthropic', 'Claude models', 'sk-ant-•••• 7Qx2', 'Verified 09:02', ''], ['O', 'OpenAI', 'GPT models', 'sk-proj-•••• k91A', 'Verified Mon', ''], ['G', 'Google Gemini', 'Gemini models', 'AIza•••• uE4c', 'Quota 82% used', 'warn']]
                .map(([l, n, s, k, st, w]) => `<div class="prov"><span class="lg">${l}</span><span><b>${n}</b><small>${s}</small></span><span class="keyfld">${ic('key', 's14')}<span>${k}</span><button class="icon-btn" aria-label="Copy">${ic('copy', 's12')}</button></span><span class="state ${w}"><span class="dot"></span>${st}</span></div>`).join('')}
            </div>
            <div class="box">
              <div class="box-h"><h3>Agent in every window</h3><p>Sees selection, frame, camera</p></div>
              <table class="grid"><tbody>
                ${windows.map(([i, n, p, on]) => `<tr><td style="width:24px;color:var(--t3)">${ic(i, 's14')}</td><td><b>${n}</b></td><td><span class="dd" style="height:22px">${p}${ic('chevD', 's12')}</span></td><td style="width:44px"><span class="sw" role="switch" aria-checked="${on}"></span></td></tr>`).join('')}
              </tbody></table>
            </div>
          </div>
          <div class="box">
            <div class="box-h"><h3>Model routing</h3><p>Pick a provider and model per task</p><span class="act"><span class="state"><span class="dot"></span>Destructive or data-sending actions always ask</span></span></div>
            <table class="grid"><thead><tr><th>Task</th><th>Used by</th><th>Provider</th><th>Model</th><th style="text-align:right">This month</th></tr></thead><tbody>
              ${routes.map(([t, u, p, m, s], i) => `<tr style="${s === 'Later' ? 'opacity:.55' : ''}"><td><b>${t}</b></td><td class="t3">${u}</td><td><span class="dd" style="height:22px">${p}${ic('chevD', 's12')}</span></td><td><span class="dd" style="height:22px">${m}${ic('chevD', 's12')}</span></td><td class="num">${['$18.40', '$42.75', '$6.10', '$1.95', '·'][i]}</td></tr>`).join('')}
            </tbody></table>
          </div>
          <div class="box">
            <div class="box-h"><h3>Project data policy</h3><p>Overrides the global switch for each project</p></div>
            <table class="grid"><thead><tr><th>Project</th><th>May send</th><th>Ask before first send</th><th style="text-align:right">Tokens, 30 days</th></tr></thead><tbody>
              ${[['Al-Zour LNG Terminal', 'Text, frames, images', true, '1.21 M'], ['HCl Tank 710-D-130335', 'Text and selected frames', true, '384 k'], ['EBSM flare stack', 'Text only', true, '96 k'], ['DAMAC Hills residential tower', 'Nothing, offline only', false, '0']]
                .map(([n, s, a, t]) => `<tr><td><b>${n}</b></td><td><span class="dd" style="height:22px">${s}${ic('chevD', 's12')}</span></td><td><span class="sw" role="switch" aria-checked="${a}"></span></td><td class="num">${t}</td></tr>`).join('')}
            </tbody></table>
          </div>
        </section>
        <!-- Maps -->
        <section class="pp" data-pp="maps">
          <div class="pp-h"><div><h2>Offline maps</h2><p>Vector street maps from OpenStreetMap, rendered on this machine. GCC to street level, the world to overview zoom. Used as the 2D map and as the ground of the 3D scene.</p></div><div class="act"><button class="btn">${ic('folder', 's14')}Import pack file</button><button class="btn primary">${ic('plus', 's14')}Add region</button></div></div>
          <div class="box">
            <div class="box-h"><h3>Installed packs</h3><p>9.3 GB of 412 GB free on D:</p><span class="act"><button class="btn sm">${ic('refresh', 's12')}Check for updates</button></span></div>
            <table class="grid"><thead><tr><th>Pack</th><th>Zoom</th><th>Built</th><th>Status</th><th style="text-align:right">Size</th><th></th></tr></thead><tbody>
              ${[['Kuwait', 'z0 to z16', '14 Sep 2025', 'Update available', '412 MB', 'warn'], ['United Arab Emirates', 'z0 to z16', '14 Sep 2025', 'Installed', '1.38 GB', ''], ['Saudi Arabia', 'z0 to z16', '14 Sep 2025', 'Installed', '3.92 GB', ''], ['Qatar', 'z0 to z16', '14 Sep 2025', 'Installed', '286 MB', ''], ['Bahrain', 'z0 to z16', '14 Sep 2025', 'Installed', '74 MB', ''], ['Oman', 'z0 to z16', '14 Sep 2025', 'Installed', '690 MB', ''], ['World overview', 'z0 to z8', '02 Aug 2025', 'Installed', '1.10 GB', ''], ['Arabic labels, GCC', 'all', '20 Sep 2025', 'Downloading 64%', '96 MB', 'dl']]
                .map(([n, z, b, s, sz, k]) => `<tr><td><b>${n}</b>${n === 'World overview' ? '<small>Coastlines, countries, cities, major roads</small>' : ''}</td><td class="mono t3">${z}</td><td class="mono t3">${b}</td><td>${k === 'dl' ? `<div style="display:flex;align-items:center;gap:8px"><span class="state"><span class="dot"></span>${s}</span><span class="prog" style="width:80px;margin:0"><i style="width:64%"></i></span></div>` : `<span class="state ${k}"><span class="dot"></span>${s}</span>`}</td><td class="num">${sz}</td><td style="width:90px;text-align:right">${k === 'warn' ? '<button class="btn sm">Update</button>' : k === 'dl' ? '<button class="btn ghost sm">Pause</button>' : `<button class="icon-btn" aria-label="More">${ic('more', 's14')}</button>`}</td></tr>`).join('')}
            </tbody></table>
          </div>
          <div class="cols2">
            <div class="box"><div class="box-h"><h3>Style</h3></div>
              <div class="setrow"><span><b>Map style follows app theme</b><span>Dark map in dark mode, light map in light mode.</span></span><span class="sw" role="switch" aria-checked="true"></span></div>
              <div class="setrow"><span><b>Label language</b><span>Arabic and English shown together where both exist.</span></span><span class="dd">Arabic + English${ic('chevD', 's12')}</span></div>
            </div>
            <div class="box"><div class="box-h"><h3>Satellite imagery</h3><p>Optional</p></div>
              <div class="setrow"><span><b>No imagery pack installed</b><span>Only sources whose licence allows offline redistribution are offered. Project orthos are always available as layers.</span></span><button class="btn sm">Browse</button></div>
            </div>
          </div>
        </section>
        <!-- Severity -->
        <section class="pp" data-pp="sev">
          <div class="pp-h"><div><h2>Severity models</h2><p>Ordinal levels with a colour, criteria and recommended action. Projects pick a model from these templates and can override it.</p></div><div class="act"><button class="btn">${ic('download', 's14')}Import from kit</button><button class="btn primary">${ic('plus', 's14')}New model</button></div></div>
          <div style="display:grid;grid-template-columns:220px minmax(0,1fr);gap:16px;align-items:start">
            <div class="box" style="padding:6px"><div class="tmpl-list">
              ${[['Tank lining v2', '5 + U', 1], ['Flare / stack', '5'], ['Telecom tower', '4'], ['OHTL tower', '4'], ['Building facade', '5'], ['Road, ASTM D6433', '3'], ['Stockpile', '3']].map(([n, c, s]) => `<button aria-selected="${!!s}">${ic('flag', 's14')}${n}<small>${c}</small></button>`).join('')}
            </div></div>
            <div class="box">
              <div class="box-h"><h3>Tank lining v2</h3><p>Used by HCl Tank 710-D-130335 · client scale, 5 most severe</p><span class="act"><button class="btn sm">Duplicate</button></span></div>
              <div class="sevlv h"><span>Level</span><span>Name</span><span>Colour</span><span>Criteria</span><span>Recommended action</span><span></span></div>
              ${[[5, 'Critical', 'Lining breached, substrate exposed, crack or active leak', 'Remove from service, repair before restart', '#E5484D'], [4, 'High', 'Disbondment over 100 cm², or blister cluster with cracking', 'Repair at next shutdown, within 3 months'], [3, 'Medium', 'Intact blisters or coating loss, no substrate exposed', 'Monitor, re-inspect in 12 months'], [2, 'Low', 'Discolouration, light deposits, cosmetic marks', 'Record, check at next inspection'], [1, 'Observation', 'Context only, no defect', 'None']]
                .map(([l, n, c, a], i) => `<div class="sevlv ${i === 2 ? 'sel' : ''}"><span class="lvl sev${l}" ${l === 5 ? 'style="color:white"' : ''}>${l}</span><span class="nm">${n}</span><span class="sw2"><i class="sev${l}"></i>${['E5484D', 'F1883A', 'EBCB4B', '6FA4E0', '8B919B'][i]}</span><span class="txt">${c}</span><span class="txt t3">${a}</span><button class="icon-btn" aria-label="Reorder">${ic('dots6', 's14')}</button></div>`).join('')}
              <div class="sevlv"><span class="lvl hatch" style="color:var(--t2)">U</span><span class="nm">Uncertain</span><span class="sw2"><i class="hatch"></i>hatch</span><span class="txt">Not graded, needs a closer look or another view</span><span class="txt t3">Assign to reviewer</span><button class="icon-btn">${ic('dots6', 's14')}</button></div>
              <div style="padding:10px 12px;border-top:1px solid var(--ln0);display:flex;gap:8px;align-items:center"><button class="btn sm">${ic('plus', 's12')}Add level</button><span class="dim" style="font-size:12px;margin-left:auto">Issues feed the PDF report with these names and colours</span></div>
            </div>
          </div>
        </section>
        <section class="pp" data-pp="privacy"><div class="pp-h"><div><h2>Privacy and data</h2><p>Before the first send in a project, the app shows exactly which frames, images and text will go to the provider.</p></div></div></section>
      </div>
    </div>
    <div class="prefs-foot">${ic('check', 's14')}<span>Preferences save automatically</span><span class="act"><button class="btn ghost sm">Revert to defaults</button><button class="btn sm" data-go="alzour">Close</button></span></div>
  </div>`;
}

/* ------------------------------------------------------------------ navigation */
let current = null;
const loaded = {};
let sceneMod = null;
async function scene() { return sceneMod || (sceneMod = await import('./option-3-scene.js')); }

export function go(screen, opts = {}) {
  if (!['home', 'alzour', 'hcl', 'settings'].includes(screen)) return;
  current = screen;
  $$('.screen').forEach(s => s.classList.toggle('on', s.id === 'scr-' + screen));
  $$('.switcher [data-go]').forEach(b => b.setAttribute('aria-selected', b.dataset.go === screen));
  const n = { home: 1, alzour: 2, hcl: 3, settings: 4 }[screen];
  $('#caption').textContent = `Option 3: Studio, screen ${n} of 4`;
  renderSidebar(screen); setWsTabs(screen);
  if (screen === 'home') { $('#stA').innerHTML = `${ic('disk', 's12')}<span class="mono">D:\Stratlas  134.7 GB used</span>`; $('#stB').innerHTML = '<span>6 projects, all offline-ready</span>'; } else {
  $('#stB').innerHTML = screen === 'hcl' ? '<span class="mono">Tank frame  X 0.04  Y 8.60  Z -1.32 m</span>' : '<span class="mono">Plant grid  E 1 446.0  N 555.4  EL 100.0</span>';
  $('#stA').innerHTML = screen === 'hcl' ? `${ic('globe', 's12')}<span class="mono">Tank model frame, m</span>` : `${ic('globe', 's12')}<span class="mono">Plant grid, UTM 39N +18.0°</span>`; }
  if (opts.pane) showPane(opts.pane);
  if (sceneMod) sceneMod.setActive(screen);
  if (screen === 'alzour' || screen === 'hcl') {
    scene().then(m => { if (!loaded[screen]) { loaded[screen] = 1; m.init(screen); } m.setActive(current); });
  }
  store.set('screen', screen);
}
function showPane(p) {
  $$('.prefs-nav [data-pane]').forEach(b => b.setAttribute('aria-selected', b.dataset.pane === p));
  $$('.pp').forEach(s => s.classList.toggle('on', s.dataset.pp === p));
}
function toggleSidebar(force) {
  const app = $('#app');
  const v = force ?? !app.classList.contains('sb-collapsed');
  app.classList.toggle('sb-collapsed', v);
  store.set('sb', v);
  const b = $('#sbToggle'); if (b) b.dataset.tip = v ? 'Expand sidebar' : 'Collapse sidebar';
}

function wire() {
  document.addEventListener('click', e => {
    const t = e.target;
    const g = t.closest('[data-go]'); if (g) { go(g.dataset.go, { pane: g.dataset.pane }); return; }
    if (t.closest('#sbToggle, #sbExpand')) { toggleSidebar(); return; }
    if (t.closest('.app.sb-collapsed .sb-brand')) { toggleSidebar(false); return; }
    const nav = t.closest('[data-nav]'); if (nav) { if (nav.dataset.nav === 'home') go('home'); else if (nav.dataset.nav === 'scene' && current === 'home') go('alzour'); return; }
    const op = t.closest('[data-open]'); if (op) {
      $$('.pcard').forEach(c => c.classList.toggle('sel', c === op));
      if (e.detail === 2 && (op.dataset.open === 'alzour' || op.dataset.open === 'hcl')) go(op.dataset.open);
      return;
    }
    const pane = t.closest('.prefs-nav [data-pane]'); if (pane) { showPane(pane.dataset.pane); return; }
    const sw = t.closest('.sw'); if (sw) { sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') !== 'true'); return; }
    const bs = t.closest('.bigswitch button'); if (bs) { $$('.bigswitch button').forEach(b => b.setAttribute('aria-pressed', b === bs)); const off = bs.textContent.includes('Offline'); $('#aiPill').innerHTML = off ? `${ic('cloudOff', 's12')}Offline only` : '<span class="dot"></span>Cloud AI allowed'; return; }
    const pg = t.closest('.pg>summary'); if (pg) return;
    const tw = t.closest('.tr .tg button'); if (tw) {
      const isEye = tw === tw.parentElement.firstElementChild;
      const row = tw.closest('.tr');
      if (isEye) { row.classList.toggle('hid'); tw.innerHTML = ic(row.classList.contains('hid') ? 'eyeOff' : 'eye', 's14'); tw.classList.toggle('off', row.classList.contains('hid')); }
      else { const on = !tw.classList.contains('on-lock'); tw.classList.toggle('on-lock', on); tw.classList.toggle('off', !on); tw.innerHTML = ic(on ? 'lock' : 'unlock', 's14'); }
      return;
    }
    const tr = t.closest('.tree .tr:not(.more)'); if (tr) { $$('.tree .tr').forEach(r => r.classList.toggle('sel', r === tr)); return; }
    const segb = t.closest('.seg button'); if (segb) { $$('button', segb.parentElement).forEach(b => b.setAttribute('aria-pressed', b === segb)); return; }
    const tool = t.closest('.toolcol button, .annot-tools button'); if (tool) { $$('button', tool.parentElement).forEach(b => b.setAttribute('aria-pressed', b === tool)); return; }
    const bm = t.closest('.bm'); if (bm) { $$('.bm', bm.parentElement).forEach(b => b.setAttribute('aria-pressed', b === bm)); if (sceneMod) sceneMod.bookmark(bm.dataset.bm, bm.textContent.trim()); return; }
    const tab = t.closest('.tabs button'); if (tab) { $$('button', tab.parentElement).forEach(b => b.setAttribute('aria-selected', b === tab)); return; }
    const vm = t.closest('[data-vm]'); if (vm) { openViewMenu(vm); return; }
    const iss = t.closest('.iss'); if (iss) { $$('.iss').forEach(r => r.classList.toggle('sel', r === iss)); return; }
  });
  document.addEventListener('keydown', e => {
    if (e.target.matches('textarea, input')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); }
    if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); go('settings'); }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && ['1', '2', '3', '4'].includes(e.key) && !e.target.closest('.vbody')) {
      go(['home', 'alzour', 'hcl', 'settings'][+e.key - 1]);
    }
    if (e.key === 'Escape') closeMenu();
  });
  // pane splitter
  document.addEventListener('pointerdown', e => {
    const gut = e.target.closest('[data-gutter]'); if (!gut) return;
    const split = gut.parentElement; const r = split.getBoundingClientRect();
    gut.classList.add('drag'); gut.setPointerCapture(e.pointerId);
    const mv = ev => { const f = Math.min(0.8, Math.max(0.25, (ev.clientX - r.left) / r.width)); split.style.setProperty('--a', f + 'fr'); split.style.setProperty('--b', (1 - f) + 'fr'); };
    const up = () => { gut.classList.remove('drag'); gut.removeEventListener('pointermove', mv); };
    gut.addEventListener('pointermove', mv); gut.addEventListener('pointerup', up, { once: true });
  });
}
let menuEl = null;
function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
function openViewMenu(btn) {
  closeMenu();
  const cur = btn.querySelector('span').textContent;
  const r = btn.getBoundingClientRect();
  menuEl = document.createElement('div'); menuEl.className = 'menu'; menuEl.setAttribute('role', 'menu');
  menuEl.innerHTML = `<div class="mh">View mode</div>${VIEWMODES.map(([i, l, k]) => `<button role="menuitemradio" aria-checked="${l === cur}" data-mode="${l}">${ic('check', 's14 ck')}${ic(i, 's14')}${l}<span class="kbd">${k}</span></button>`).join('')}
    <hr><div class="mh">Show</div>
    <button role="menuitemcheckbox" aria-checked="true">${ic('check', 's14 ck')}${ic('path', 's14')}Flight paths</button>
    <button role="menuitemcheckbox" aria-checked="true">${ic('check', 's14 ck')}${ic('frustum', 's14')}Camera frustum</button>
    <button role="menuitemcheckbox" aria-checked="true">${ic('check', 's14 ck')}${ic('video', 's14')}Projected video</button>
    <button role="menuitemcheckbox" aria-checked="false">${ic('check', 's14 ck')}${ic('grid', 's14')}Grid</button>`;
  menuEl.style.left = r.left + 'px'; menuEl.style.top = (r.bottom + 4) + 'px'; menuEl.style.position = 'fixed';
  document.body.appendChild(menuEl);
  menuEl.addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.mode) {
      btn.innerHTML = `${ic(VIEWMODES.find(v => v[1] === b.dataset.mode)[0], 's12')}<span>${b.dataset.mode}</span>${ic('chevD', 's12')}`;
      if (sceneMod) sceneMod.setViewMode(btn.dataset.vm, b.dataset.mode);
      closeMenu();
    } else b.setAttribute('aria-checked', b.getAttribute('aria-checked') !== 'true');
  });
  setTimeout(() => document.addEventListener('pointerdown', function h(ev) { if (menuEl && !menuEl.contains(ev.target)) { closeMenu(); } document.removeEventListener('pointerdown', h); }), 0);
}

/* ------------------------------------------------------------------ boot */
async function loadManifestThumbs() {
  // Thumbnails from real assets; probe a few candidates and keep what exists.
  const cand = {
    alzour: ['alzour/clip_dji0789_tanks_poster.jpg'],
    alzourWide: ['alzour/clip_dji0665_overview_poster.jpg'],
    hcl: ['hcl/clip_f110_external_poster.jpg'],
    ebsm: ['ebsm/p024.jpg'],
    damac: ['damac/p0190.jpg'],
  };
  Object.entries(cand).forEach(([k, list]) => { ASSETS.thumbs[k] = A + list[0]; });
}

async function boot() {
  renderTitlebar(); renderStatus(); wireTips(); wire();
  await loadManifestThumbs();
  renderHome(); renderAlzour(); renderHcl(); renderSettings();
  if (store.get('sb', false)) $('#app').classList.add('sb-collapsed');
  const qs = new URLSearchParams(location.search);
  go(qs.get('s') || store.get('screen', 'home'), { pane: qs.get('pane') });
  if (qs.get('sb') === '0') toggleSidebar(true);
  if (qs.get('sb') === '1') toggleSidebar(false);
}
boot();
