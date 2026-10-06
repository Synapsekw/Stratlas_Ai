/**
 * The user guide screenshots (docs/guide/images), one list: each shot names its file, the
 * chapter that shows it, the project it opens and how to bring the app there. guide-shots.spec.ts
 * takes them off-screen from synthetic data only, so they are safe to run anywhere.
 *
 * `SHOT_PROJECT` is the project every shot opens. It is the synthetic guide sample below; to
 * use the demo project instead, point it at the demo (and the spec's data root at its folder).
 */
import { ProjectManifest, SCHEMA_VERSION, type Issue } from '@aio/schema';
import type { Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

export const GUIDE_SAMPLE_ID = 'guide-sample';
export const GUIDE_SAMPLE_NAME = 'Sample storage tank';

/** The project the shots open: one line to switch to the demo project. */
export const SHOT_PROJECT = { id: GUIDE_SAMPLE_ID, name: GUIDE_SAMPLE_NAME };

export interface GuideShot {
  /** File name in docs/guide/images, without `.png`. */
  id: string;
  /** Chapter slug that shows it (docs/guide/NN-<slug>.md). */
  chapter: string;
  /** The project opened before the shot, or null for the library with no projects. */
  project: { id: string; name: string } | null;
  /** Bring the app from a freshly opened project (or the library) to what the shot shows. */
  setup: (win: Page) => Promise<void>;
}

async function palette(win: Page, query: string): Promise<void> {
  await win.keyboard.press('Control+K');
  const box = win.getByRole('combobox');
  await box.fill(query);
  await win.keyboard.press('Enter');
}

const settingsPage = (name: string) => async (win: Page) => {
  await palette(win, 'Go to Settings');
  await win
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name })
    .click();
  await win.getByRole('heading', { level: 1, name }).waitFor();
};

const screen = (name: string, heading: RegExp) => async (win: Page) => {
  await palette(win, `Go to ${name}`);
  await win.locator('.crumbs b').filter({ hasText: name }).waitFor();
  await win.getByRole('heading', { name: heading }).first().waitFor();
};

export const GUIDE_SHOTS: GuideShot[] = [
  {
    id: 'first-start',
    chapter: 'install',
    project: null,
    setup: async (win) => {
      await win.getByRole('heading', { name: 'No projects in the library yet' }).waitFor();
    },
  },
  {
    id: 'help',
    chapter: 'install',
    project: SHOT_PROJECT,
    setup: async (win) => {
      await win.keyboard.press('F1');
      await win.getByRole('searchbox', { name: 'Search the guide' }).fill('compare dates');
      await win.getByRole('dialog', { name: 'User guide' }).locator('.help-hit').first().click();
      await win.getByRole('heading', { level: 2, name: 'Compare two dates' }).waitFor();
    },
  },
  {
    id: 'projects-library',
    chapter: 'projects',
    project: SHOT_PROJECT,
    setup: async (win) => {
      await palette(win, 'Go to Projects');
      await win.getByTestId('project-card').first().waitFor();
    },
  },
  {
    id: 'palette',
    chapter: 'projects',
    project: SHOT_PROJECT,
    setup: async (win) => {
      await win.keyboard.press('Control+K');
      await win.getByRole('combobox').fill('show');
    },
  },
  {
    id: 'scene-3d',
    chapter: 'scene',
    project: SHOT_PROJECT,
    setup: async (win) => {
      await win.locator('.crumbs b').filter({ hasText: 'Scene' }).waitFor();
      await win.keyboard.press('h');
    },
  },
  {
    id: 'issue-card',
    chapter: 'annotation-and-issues',
    project: SHOT_PROJECT,
    setup: async (win) => {
      await win.locator('.crumbs b').filter({ hasText: 'Scene' }).waitFor();
      await palette(win, 'D02');
      await win.getByText('D02').first().waitFor();
    },
  },
  {
    id: 'issues',
    chapter: 'annotation-and-issues',
    project: SHOT_PROJECT,
    setup: screen('Issues', /Issue register/),
  },
  {
    id: 'new-project',
    chapter: 'building-projects',
    project: null,
    setup: async (win) => {
      await win.getByTestId('new-project').first().click();
      await win.getByRole('heading', { name: 'What is the project?' }).waitFor();
    },
  },
  {
    id: 'reports',
    chapter: 'reports-and-exports',
    project: SHOT_PROJECT,
    setup: screen('Reports', /Project report/),
  },
  {
    id: 'package-export',
    chapter: 'packages',
    project: SHOT_PROJECT,
    setup: async (win) => {
      await palette(win, 'Export project package');
      await win.getByRole('dialog').getByText('Customer policy').waitFor();
    },
  },
  {
    id: 'settings-maps',
    chapter: 'maps',
    project: SHOT_PROJECT,
    setup: settingsPage('Offline maps'),
  },
  {
    id: 'settings-ai',
    chapter: 'ai-agent',
    project: SHOT_PROJECT,
    setup: settingsPage('AI providers'),
  },
  {
    id: 'settings-data',
    chapter: 'settings',
    project: SHOT_PROJECT,
    setup: settingsPage('Data folder'),
  },
  {
    id: 'settings-graphics',
    chapter: 'settings',
    project: SHOT_PROJECT,
    setup: settingsPage('Graphics quality'),
  },
];

/** A PNG with a soft gradient and a darker patch, so photo crops have something to show. */
function samplePng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = (crcTable[(c ^ x) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < width; x++) {
      const patch = x > width * 0.4 && x < width * 0.6 && y > height * 0.35 && y < height * 0.6;
      const v = Math.round(150 + (60 * y) / height) - (patch ? 70 : 0);
      const o = y * row + 1 + x * 3;
      raw[o] = v;
      raw[o + 1] = v - 6;
      raw[o + 2] = v - 18;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The synthetic guide sample in `<dataRoot>/projects/guide-sample`: the unit quad model, two
 * photos and four graded issues. No client data.
 */
export async function writeGuideSample(dataRoot: string, glb: Buffer): Promise<void> {
  const dir = join(dataRoot, 'projects', GUIDE_SAMPLE_ID);
  await mkdir(join(dir, 'models'), { recursive: true });
  await mkdir(join(dir, 'photos'), { recursive: true });
  const manifest = ProjectManifest.parse({
    schema: SCHEMA_VERSION,
    id: GUIDE_SAMPLE_ID,
    name: GUIDE_SAMPLE_NAME,
    customer: 'Synapse Solutions',
    site: 'Demo yard',
    crs: { epsg: 32640 },
    origin: [500000, 2800000, 0],
    captures: [{ id: 'c1', label: 'Survey', date: '2026-01-15' }],
    layers: [
      {
        kind: 'mesh',
        id: 'tank',
        name: 'Tank model',
        src: { path: 'models/tank.glb' },
        transform: [8, 0, 0, 0, 0, 8, 0, 0, 0, 0, 8, 0, 0, 0, 0, 1],
      },
      {
        kind: 'photos',
        id: 'photos',
        name: 'Inspection photos',
        items: [
          { id: 'IMG_0001', src: { path: 'photos/IMG_0001.png' } },
          { id: 'IMG_0002', src: { path: 'photos/IMG_0002.png' } },
        ],
      },
    ],
    severityModels: [
      {
        id: 'sev',
        name: 'General inspection (1 to 3)',
        levels: [
          {
            value: 1,
            label: 'Minor',
            color: '#9fb4c8',
            criteria: 'Monitor at the next inspection',
          },
          { value: 2, label: 'Moderate', color: '#f2b84b', criteria: 'Repair within six months' },
          { value: 3, label: 'Severe', color: '#ee3f4b', criteria: 'Repair now' },
        ],
      },
    ],
    classCatalogues: [
      {
        id: 'cat',
        name: 'Coating',
        assetType: 'tank',
        classes: [
          { id: 'corrosion', label: 'Corrosion', color: '#ee3f4b', severityModel: 'sev' },
          { id: 'blister', label: 'Coating blister', color: '#f2b84b', severityModel: 'sev' },
        ],
      },
    ],
  });
  const issue = (n: number, classId: string, severity: number, x: number, z: number): Issue => {
    const code = `D0${String(n)}`;
    return {
      id: code.toLowerCase(),
      code,
      classId,
      severityModelId: 'sev',
      severity,
      status: n === 1 ? 'approved' : 'draft',
      title: `${classId === 'corrosion' ? 'Corrosion' : 'Coating blister'} on the roof`,
      note: 'Seen on the survey photos.\nZone: Roof',
      author: 'Guide',
      createdAt: '2026-01-16T09:00:00Z',
      updatedAt: '2026-01-16T09:00:00Z',
      source: 'human',
      sightings: [
        { on: 'mesh', layer: 'tank', geom: { type: 'spoint', p: [x, 0, z], n: [0, 1, 0] } },
        {
          on: 'image',
          layer: 'photos',
          photo: n % 2 ? 'IMG_0001' : 'IMG_0002',
          geom: { type: 'box', x: 260, y: 170, w: 130, h: 110 },
        },
      ],
    };
  };
  const issues = [
    issue(1, 'corrosion', 3, 2, -2),
    issue(2, 'blister', 2, 6, -3),
    issue(3, 'corrosion', 2, 5, -6.5),
    issue(4, 'blister', 1, 2.5, -5.5),
  ];
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(dir, 'models', 'tank.glb'), glb);
  await writeFile(join(dir, 'photos', 'IMG_0001.png'), samplePng(640, 480));
  await writeFile(join(dir, 'photos', 'IMG_0002.png'), samplePng(640, 480));
  await writeFile(join(dir, 'issues.json'), JSON.stringify({ schema: 'aio.issues/1', issues }));
}
