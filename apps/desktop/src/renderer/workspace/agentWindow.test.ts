import { describe, expect, it } from 'vitest';
import { agentWindow } from './agentWindow';

describe('agentWindow', () => {
  it('keeps the Scene pane the person used last', () => {
    expect(agentWindow('video', '3d')).toBe('video');
    expect(agentWindow('map', 'split')).toBe('map');
  });

  it('falls back to the stage when focus was left on another screen', () => {
    expect(agentWindow('issues', '3d')).toBe('scene3d');
    expect(agentWindow('report', 'map')).toBe('map');
    expect(agentWindow(null, 'split')).toBe('scene3d');
  });
});
