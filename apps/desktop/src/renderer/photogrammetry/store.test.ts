import { describe, expect, it } from 'vitest';
import { photoUi } from './store';

describe('why the maps of a run did not start', () => {
  it('is kept per run until it is cleared', () => {
    const ui = photoUi.getState();
    ui.setStartError('r1', 'No pipeline pack is installed.');
    ui.setStartError('r2', 'products: Invalid input');
    expect(photoUi.getState().startErrors).toEqual({
      r1: 'No pipeline pack is installed.',
      r2: 'products: Invalid input',
    });
    ui.setStartError('r1', null);
    expect(photoUi.getState().startErrors).toEqual({ r2: 'products: Invalid input' });
  });

  it('the latest reason replaces the one before', () => {
    const ui = photoUi.getState();
    ui.setStartError('r3', 'first');
    ui.setStartError('r3', 'second');
    expect(photoUi.getState().startErrors.r3).toBe('second');
  });
});

describe('a run whose maps were started without the survey date', () => {
  it('is kept per run until it is cleared', () => {
    const ui = photoUi.getState();
    ui.setDateWarning('w1', true);
    expect(photoUi.getState().dateWarnings).toEqual({ w1: true });
    ui.setDateWarning('w1', false);
    expect(photoUi.getState().dateWarnings).toEqual({});
  });

  it('one run does not touch the warning of another', () => {
    const ui = photoUi.getState();
    ui.setDateWarning('w2', true);
    ui.setDateWarning('w3', true);
    ui.setDateWarning('w2', false);
    expect(photoUi.getState().dateWarnings).toEqual({ w3: true });
    ui.setDateWarning('w4', false);
    expect(photoUi.getState().dateWarnings).toEqual({ w3: true });
    ui.setDateWarning('w3', false);
  });
});
