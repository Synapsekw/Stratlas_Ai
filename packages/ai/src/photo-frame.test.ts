import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { photoPlan } from './photo-frame';
import { scriptedTurn } from './scripted';
import { fixtureIssue, fixtureManifest, fixtureWorkspace } from './test-fixtures';

describe('photo frame plan', () => {
  function workspaceWithPhoto() {
    const ws = fixtureWorkspace();
    const manifest = fixtureManifest();
    manifest.layers.push({
      kind: 'photos',
      id: 'ph',
      name: 'Photos',
      visible: true,
      items: [{ id: 'p024', src: { path: 'photos/p024.jpg' } }],
    });
    ws.getState().openProject({ id: 'p1', root: 'E:/x', manifest }, [
      fixtureIssue({
        code: 'D01',
        severity: 5,
        sightings: [
          {
            on: 'image',
            layer: 'ph',
            photo: 'p024',
            geom: { type: 'box', x: 1, y: 2, w: 3, h: 4 },
          },
          {
            on: 'image',
            layer: 'ph',
            photo: 'p024',
            geom: { type: 'mask', src: { path: 'masks/p024_mask.png' } },
          },
        ],
      }),
      fixtureIssue({
        id: 'other',
        code: 'D02',
        sightings: [
          { on: 'image', layer: 'ph', photo: 'p999', geom: { type: 'point', x: 1, y: 1 } },
        ],
      }),
    ]);
    return ws;
  }

  it('draws the selected photo, its mask overlays and the issues on it', () => {
    const ws = workspaceWithPhoto();
    expect(photoPlan(ws.getState())).toBeNull();
    ws.getState().select({ kind: 'photo', id: 'p024', layer: 'ph' });
    expect(photoPlan(ws.getState())).toEqual({
      src: 'aio://project/p1/photos/p024.jpg',
      overlays: ['aio://project/p1/masks/p024_overlay.png'],
      shapes: [{ code: 'D01', color: '#aabbcc', geom: { type: 'box', x: 1, y: 2, w: 3, h: 4 } }],
    });
  });
});

describe('scripted test model', () => {
  const user = (text: string): LanguageModelV4Prompt => [
    {
      role: 'user',
      content: [
        { type: 'text', text: '<window_context/>' },
        { type: 'text', text },
      ],
    },
  ];

  it('calls a tool by keyword and reports tool results', () => {
    expect(scriptedTurn(user('Please measure this'))).toMatchObject({
      kind: 'tool',
      tool: 'measure_distance',
    });
    expect(scriptedTurn(user('Hello'))).toEqual({
      kind: 'text',
      text: 'Scripted reply to: Hello',
    });
    expect(
      scriptedTurn([
        ...user('measure'),
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'x',
              toolName: 'measure_distance',
              output: { type: 'json', value: { distanceM: 5 } },
            },
          ],
        },
      ]),
    ).toMatchObject({ kind: 'text', text: expect.stringContaining('measure_distance') as string });
  });
});
