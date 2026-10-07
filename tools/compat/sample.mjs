// The 0.9 source of the compatibility corpus: the state files of the synthetic demo projects
// (tools/demo, built with `pnpm demo:build --quick`) plus hand-written records for the files the
// demo does not carry (boundary edits, narrative, package origin and header, a change set, a
// procedural model, a conversation, settings). Fictional people only ("Rana Example", "Omar
// Sample"); no client data. The corpus builder filters this through each milestone's schema.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const T0 = '2026-03-02T09:00:00.000Z';
const T1 = '2026-03-09T15:30:00.000Z';
const RANA = 'Rana Example';
const OMAR = 'Omar Sample';

const read = (dir, rel) => JSON.parse(readFileSync(join(dir, rel), 'utf8'));

const fc = (fill, cut) => ({ fill, cut, net: fill - cut });

/** Project folder name to { relative path: JSON }. */
export function sampleFromDemo(demoDir) {
  const tank = 'demo-tank-farm';
  const road = 'demo-access-road';
  const change = 'demo-change-site';
  const volumes = read(demoDir, `${tank}/volumes.json`);
  const pile = volumes.piles?.[0];
  const epoch = pile?.epochs?.[0];
  const roadIssues = read(demoDir, `${road}/issues.json`);
  const changeManifest = read(demoDir, `${change}/manifest.json`);
  const [from = 'd1', to = 'd2'] = (changeManifest.captures ?? []).map((c) => c.id);

  return {
    'tank-farm': {
      'manifest.json': read(demoDir, `${tank}/manifest.json`),
      'issues.json': read(demoDir, `${tank}/issues.json`),
      'volumes.json': volumes,
      'edits/boundaries.json': {
        schema: 'aio.boundaries/1',
        edits: [
          {
            pile: pile?.id ?? 'pile-1',
            epoch: epoch?.id ?? 'e1',
            ring: [
              [0, 0],
              [12.5, 0],
              [12.5, 9.25],
              [0, 9.25],
            ],
            volumes: {
              tin: fc(410.2, 3.1),
              plane: fc(398.7, 0),
              avg: fc(402.4, 1.2),
              low: fc(415, 0),
            },
            areaM2: 115.6,
            topM: 6.4,
            heightM: 4.1,
            autoNet: 404.9,
            author: RANA,
            updatedAt: T1,
          },
        ],
      },
      'report/narrative.json': {
        schema: 'aio.narrative/1',
        parts: {
          summary: {
            versions: [
              {
                text: 'Two tanks show coating loss near the base.',
                source: 'template',
                createdAt: T0,
              },
              {
                text: 'Two tanks show coating loss near the base. One weld needs a closer look.',
                source: 'user',
                createdAt: T1,
                author: RANA,
              },
            ],
          },
          findings: {
            versions: [
              {
                text: 'Findings are listed by severity.',
                source: 'ai',
                createdAt: T1,
                provider: 'local',
                model: 'test-model',
              },
            ],
          },
        },
      },
      'package-origin.json': {
        schema: 'aio.origin/1',
        package: 'Tank farm handover.aio',
        path: 'C:/Users/Example/Desktop/Tank farm handover.aio',
        projectId: 'demo-tank-farm',
        exportedAt: T0,
        exportedBy: OMAR,
        extractedAt: T1,
        extractedBy: RANA,
        encrypted: false,
      },
      'aio-package.json': {
        schema: 'aio.package/1',
        projectId: 'demo-tank-farm',
        createdAt: T0,
        createdBy: OMAR,
        readOnly: true,
        aiPolicy: 'forbid',
        editPolicy: 'allow',
        exports: ['issues-csv', 'report-pdf'],
        excludedLayers: [],
        welcome: {
          message: 'Synthetic handover for the compatibility corpus.',
          tips: ['Open Issues'],
        },
      },
    },
    'access-road': {
      'manifest.json': read(demoDir, `${road}/manifest.json`),
      // Two of the road defects (map and image sightings); the rest only repeat them.
      'issues.json': {
        ...roadIssues,
        issues: roadIssues.issues.filter((_, i) => i % 2 === 0).slice(0, 2),
      },
      'road.json': read(demoDir, `${road}/road.json`),
    },
    'change-site': {
      'manifest.json': changeManifest,
      'issues.json': read(demoDir, `${change}/issues.json`),
      'detections/markers-d1.json': read(demoDir, `${change}/detections/markers-d1.json`),
      'models/detect/marker-detector/model.json': read(
        demoDir,
        `${change}/sources/marker-detector/model.json`,
      ),
      [`change/${from}--${to}.json`]: {
        schema: 'aio.change/1',
        id: `${from}--${to}`,
        from,
        to,
        producer: 'change.compare',
        run: { jobId: 'job-compat-1', at: T1, params: { minAreaM2: 2 } },
        createdAt: T1,
        items: [
          {
            kind: 'issue',
            id: 'i-1',
            label: 'Coating loss grew',
            verdict: 'grown',
            from: 'issue-a',
            to: 'issue-b',
            size: { from: 0.4, to: 0.9, unit: 'm2' },
            review: { status: 'confirmed', by: RANA, at: T1, note: 'Seen on site.' },
          },
          {
            kind: 'detection',
            id: 'd-1',
            verdict: 'new',
            classId: 'marker',
            count: { from: 2, to: 3 },
            toIds: ['M3-p01'],
          },
          {
            kind: 'region',
            id: 'r-1',
            verdict: 'cut',
            outlineLocal: [
              [0, 0, 0],
              [4, 0, 0],
              [4, 0, 3],
            ],
            areaM2: 6,
            volume: { cutM3: 3.5, fillM3: 0, netM3: -3.5 },
            review: { status: 'dismissed', by: OMAR, at: T1 },
          },
          {
            kind: 'component',
            id: 'c-1',
            verdict: 'moved',
            part: 'tank-2',
            offsetM: [0.2, 0, -0.1],
          },
          {
            kind: 'frame',
            id: 'f-1',
            verdict: 'changed',
            a: { layer: 'photos-d1', photo: 'p01' },
            b: { layer: 'photos-d2', photo: 'p01' },
            score: 0.7,
          },
        ],
        layers: [],
        stats: { items: 5 },
        registration: { ok: true, shiftM: 0.04, toleranceM: 0.1 },
        coverage: 0.92,
      },
      'models/site.procmodel.json': {
        schema: 'aio.procmodel/1',
        id: 'site',
        name: 'Site model',
        createdAt: T0,
        updatedAt: T1,
        capture: from,
        sources: [{ kind: 'drawing', ref: 'drawings/plan/plan.dxf' }],
        parts: [
          {
            kind: 'cylinder',
            id: 'tank-1',
            name: 'Tank 1',
            status: 'accepted',
            origin: { by: 'drawing', file: 'plan.dxf', layer: 'TANKS', entity: '1F' },
            base: [10, 0, 5],
            radius: 6,
            height: 9,
            roof: 'cone',
            roofHeight: 1.2,
          },
          {
            kind: 'box',
            id: 'shed',
            status: 'draft',
            confidence: 0.6,
            origin: { by: 'fit', residualM: 0.05, inliers: 1200, inlierShare: 0.8 },
            base: [30, 0, 4],
            size: [6, 3, 4],
            yawDeg: 15,
          },
          {
            kind: 'pipe',
            id: 'line-1',
            status: 'accepted',
            origin: { by: 'manual', author: RANA },
            points: [
              [0, 1, 0],
              [20, 1, 0],
            ],
            diameter: 0.3,
          },
        ],
      },
    },
    userData: {
      'settings.json': {
        cloudAi: false,
        theme: 'dark',
        sidebarCollapsed: false,
        dataRoot: 'C:/Users/Example/Documents/Stratlas Data',
        routes: [],
        direction: 'ltr',
        offlineOnly: true,
        updateCheck: false,
        updateUrl: '',
        reportBranding: { companyName: 'Example Surveys' },
        reportContents: { sections: { appendices: false }, issuePages: 'above-lowest' },
      },
      'conversations/c-compat.json': {
        schema: 'aio.conversation/1',
        id: 'c-compat',
        title: 'Which tanks need work?',
        window: 'scene3d',
        createdAt: T0,
        updatedAt: T1,
        turns: [
          { kind: 'user', id: 'u1', text: 'Which tanks need work?', chips: [], frame: false },
          {
            kind: 'assistant',
            id: 'a1',
            runId: 'run-1',
            parts: [{ type: 'text', text: 'Tank 1 and tank 2.' }],
            status: 'done',
          },
        ],
        steps: {},
        usage: { inputTokens: 120, outputTokens: 12, costUsd: 0, costKnown: true },
      },
    },
  };
}
