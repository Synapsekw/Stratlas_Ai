import { describe, expect, it } from 'vitest';
import { meshSighting, photoSighting, tankModel, videoSighting } from '../testing';
import { formatClock, severityLabel, sightingLabel } from './common';

describe('labels', () => {
  it('formats video clock times', () => {
    expect(formatClock(56.43)).toBe('0:56.4');
    expect(formatClock(61)).toBe('1:01.0');
  });

  it('names severities from the model', () => {
    expect(severityLabel(tankModel, 5)).toBe('Critical');
    expect(severityLabel(tankModel, 'uncertain')).toBe('Uncertain');
    expect(severityLabel(undefined, 2)).toBe('');
  });

  it('describes sightings', () => {
    expect(sightingLabel(photoSighting)).toBe('Photo F01 · box');
    expect(sightingLabel(videoSighting)).toBe('Video f108 · 0:01.0');
    expect(sightingLabel(meshSighting)).toBe('Mesh tank · point');
  });
});
