import { describe, expect, it } from 'vitest';
import { walkFolder, walkIdOfRecord } from './walkPaths';

describe('walkFolder', () => {
  it('answers walks/<id> for exactly walks/<id>/<file>', () => {
    expect(walkFolder('walks/w1/walk.json')).toBe('walks/w1');
    expect(walkFolder('walks\\site-2\\walk.json')).toBe('walks/site-2');
    expect(walkIdOfRecord('walks/a-b-3/walk.json')).toBe('a-b-3');
  });

  it('refuses any path that could leave the project', () => {
    for (const p of [
      'walks/../walk.json',
      'walks/../evil/walk.json',
      '../walks/w/walk.json',
      'walks/w/../../walk.json',
      'walks/w/..',
      'walks/w/.',
      'walks/w/',
      'walks//walk.json',
      '/walks/w/walk.json',
      'C:/walks/w/walk.json',
      'walks/w/sub/walk.json',
      'walks/.hidden/walk.json',
      'walks/-w/walk.json',
      'walks/W/walk.json',
      'walk.json',
      'other/w/walk.json',
    ]) {
      expect(walkFolder(p), p).toBeNull();
      expect(walkIdOfRecord(p), p).toBeNull();
    }
  });
});
