import { readFile } from 'node:fs/promises';
const identity = JSON.parse(
  await readFile(new URL('../../../packages/brand/brand.json', import.meta.url), 'utf8'),
);
export const disciplines = [
  ['confined-spaces', 'Confined spaces', 'See inside the asset', 'inspection/tank-poster.webp'],
  ['corrosion', 'Corrosion in 3D', 'Put condition on the surface', 'corrosion/teaser.webp'],
  ['roads', 'Roads & infrastructure', 'Follow every observation', 'use-cases/f1158.webp'],
  ['volumetric', 'Volumetric surveys', 'Understand what changed', 'use-cases/terrain-poster.webp'],
  ['facades', 'Facade inspections', 'Read the building envelope', 'use-cases/p1736.jpg'],
];
const mark = `<a class="q-brand" href="atlas.html" aria-label="${identity.productName} home"><img src="quadrion-wordmark.svg" width="192" height="35" alt="${identity.productName}"></a>`;
function header(page) {
  return `<header class="q-header">${mark}<button class="q-menu-button" aria-expanded="false" aria-controls="q-navigation">Menu <span>+</span></button><nav id="q-navigation" aria-label="Main navigation"><a href="atlas.html" ${page === 'atlas' ? 'aria-current="page"' : ''}>Platform</a><details class="q-use-cases"><summary>Solutions <span>⌄</span></summary><div>${disciplines.map(([id, title, deck]) => `<a href="${id}.html" ${id === page ? 'aria-current="page"' : ''}><strong>${title}</strong><span>${deck}</span></a>`).join('')}</div></details><a href="evidence.html" ${page === 'evidence' ? 'aria-current="page"' : ''}>Evidence</a><a href="reporting.html" ${page === 'reporting' ? 'aria-current="page"' : ''}>Deliverables</a><a class="q-header-cta" href="atlas.html#experience">Explore the software <span>↗</span></a></nav></header>`;
}
function footer() {
  return `<footer class="q-footer"><div>${mark}<p>${identity.tagline}</p><span>Spatial intelligence by ${identity.company}.</span></div><div><span class="q-label">ONE PLATFORM</span><a href="atlas.html#experience">Interactive product tour</a><a href="atlas.html#intelligence">Contextual AI & local workflows</a><a href="evidence.html">Findings & evidence</a><a href="reporting.html">Reports & portable projects</a></div><div><span class="q-label">EXPLORE SOLUTIONS</span>${disciplines.map(([id, title]) => `<a href="${id}.html">${title}</a>`).join('')}</div><p class="q-footer-note">Interactive software preview · Original inspection and survey data · Source registration and sample scope are described in each experience.</p></footer>`;
}
const journeys = {
  'confined-spaces': [
    'Explore the interior',
    [
      [
        'Reveal the structure',
        'A section opens the shell. The scan records what is inside.',
        'interior',
      ],
      [
        'Follow the inspection',
        'Move with the recorded camera through the enclosed space.',
        'flight',
      ],
      [
        'Locate the evidence',
        'One finding connects a position, a photograph and a review.',
        'finding',
      ],
    ],
  ],
  corrosion: [
    'Follow a surface observation',
    [
      ['See the whole stack', 'Understand the height and structure before moving closer.', 'whole'],
      ['Reveal the condition', 'Original masks stay attached to their mapped surfaces.', 'masks'],
      [
        'Return to the source',
        'Inspect the camera view and the photograph behind a patch.',
        'source',
      ],
    ],
  ],
  roads: [
    'From corridor to condition',
    [
      ['Follow the corridor', 'Move by chainage through the captured road assessment.', 'corridor'],
      ['Inspect a defect', 'Read a mapped outline against the original survey imagery.', 'defect'],
      [
        'Compare the assessment',
        'See how the source severity assumption affects PCI.',
        'condition',
      ],
    ],
  ],
  volumetric: [
    'Read the survey in time',
    [
      ['Choose a stockpile', 'Frame its recorded toe boundary in the survey.', 'pile'],
      [
        'Compare two dates',
        'Hold the camera position while changing the captured surface.',
        'dates',
      ],
      [
        'Understand the base',
        'Compare the source quantities and their calculation method.',
        'base',
      ],
    ],
  ],
  facades: [
    'From elevation to observation',
    [
      ['Orient the evidence', 'Select a component and its recorded elevation.', 'elevation'],
      [
        'Reveal classified regions',
        'Compare the original image with its source review masks.',
        'regions',
      ],
      [
        'Explore thermal evidence',
        'Inspect an original thermal capture and its recorded finding.',
        'thermal',
      ],
    ],
  ],
  evidence: [
    'Follow one finding',
    [
      ['Inspect the source', 'Read the photograph and the spatial position together.', 'proof'],
      [
        'Review the observation',
        'Record review status without losing the source connection.',
        'review',
      ],
      ['Carry it forward', 'Include the finding in the sample report.', 'deliver'],
    ],
  ],
  reporting: [
    'An answer with its evidence',
    [
      ['Choose the findings', 'Build the register from the reviewed observations.', 'choose'],
      ['Shape the report', 'Include the summary, register and original photographs.', 'report'],
      ['Keep a copy', 'Download a source-based sample or export your selected register.', 'export'],
    ],
  ],
};
export function journey(page) {
  const j = journeys[page];
  if (!j) return '';
  return `<section class="q-journey" aria-label="${j[0]}"><span class="q-label">${j[0]}</span><div>${j[1].map(([title, copy, action], i) => `<button data-guide="${action}" aria-pressed="false"><span class="q-step-number">0${i + 1}</span><span><strong>${title}</strong><small>${copy}</small></span><b aria-hidden="true">↗</b></button>`).join('')}</div><p class="q-guide-status" role="status">Choose a chapter to explore the live example.</p></section>`;
}
export function finishPage(html, page) {
  html = html
    .replace(/Stratlas/gi, identity.productName)
    .replace(/<header\b[\s\S]*?<\/header>/, header(page))
    .replace(/<nav class="product-subnav"[\s\S]*?<\/nav>/, '')
    .replace(/<footer\b[\s\S]*?<\/footer>/, footer())
    .replace(
      '<head>',
      '<head><meta name="theme-color" content="#0B0F13"><meta name="description" content="Quadrion AI brings drone video, 3D models, survey points and inspection evidence into one connected spatial workspace.">',
    )
    .replace('</head>', '<link rel="stylesheet" href="quadrion.css"></head>')
    .replace('</body>', '<script type="module" src="quadrion-site.js"></script></body>');
  if (page !== 'atlas')
    html = html.replace(/(<section class="page-intro[\s\S]*?<\/section>)/, '$1' + journey(page));
  if (page === 'reporting')
    html = html.replace(
      '<button class="download-csv">',
      '<a class="q-pdf-download" href="quadrion-inspection-sample.pdf" download>Download sample PDF <span>↓</span></a><button class="download-csv">',
    );
  return html;
}
