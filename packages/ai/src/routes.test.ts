import { describe, expect, it } from 'vitest';
import { defaultRoutes, offlineRoutes, routeFor, type ModelRoute } from './routes';

describe('the engineer route', () => {
  it('follows the vision route by default', () => {
    const vision = routeFor(defaultRoutes(), 'vision');
    expect(routeFor(defaultRoutes(), 'engineer')).toEqual({ ...vision, task: 'engineer' });
  });

  it('follows a changed vision route, including its "Treat as vision model" setting', () => {
    const routes: ModelRoute[] = [
      { task: 'vision', provider: 'openai', model: 'acme-vlm-2', treatAsVision: true },
    ];
    expect(routeFor(routes, 'engineer')).toEqual({
      task: 'engineer',
      provider: 'openai',
      model: 'acme-vlm-2',
      treatAsVision: true,
    });
  });

  it('uses its own route when one is set', () => {
    const routes: ModelRoute[] = [
      { task: 'vision', provider: 'anthropic', model: 'claude-opus-5-5' },
      { task: 'engineer', provider: 'openai', model: 'gpt-6-luna' },
    ];
    expect(routeFor(routes, 'engineer')).toEqual({
      task: 'engineer',
      provider: 'openai',
      model: 'gpt-6-luna',
    });
  });

  it('runs on the local model under the Offline agent preset', () => {
    expect(routeFor(offlineRoutes('llava'), 'engineer')).toEqual({
      task: 'engineer',
      provider: 'local',
      model: 'llava',
    });
  });

  it('explains a missing route when neither engineer nor vision is set', () => {
    expect(() => routeFor([], 'engineer')).toThrow('Choose one in Settings');
  });

  it('other tasks still need their own route', () => {
    const routes: ModelRoute[] = [{ task: 'vision', provider: 'anthropic', model: 'x' }];
    expect(() => routeFor(routes, 'chat')).toThrow('Choose one in Settings');
  });
});
