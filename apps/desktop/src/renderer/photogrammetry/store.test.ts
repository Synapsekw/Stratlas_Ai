import { describe, expect, it } from 'vitest';
import { photoUi } from './store';

it('opens the wizard with Start over values and closing forgets them', () => {
  const initial = {
    source: { layer: 'p' },
    preset: 'fast' as const,
    gnss: 'auto' as const,
    products: [],
    replaces: 'r1',
  };
  photoUi.getState().openWizard(initial);
  expect(photoUi.getState().view).toEqual({ kind: 'wizard', initial });
  photoUi.getState().close();
  expect(photoUi.getState().view).toBeNull();
  photoUi.getState().openWizard();
  expect(photoUi.getState().view).toEqual({ kind: 'wizard' });
});

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
  const a = { date: '2026-03-14', root: 'D:/Projects/site/' };
  const b = { date: '2026-04-02', root: 'D:/Projects/site/' };

  it('is kept per run, with the day and the project it was meant for, until it is cleared', () => {
    const ui = photoUi.getState();
    ui.setDateWarning('w1', a);
    expect(photoUi.getState().dateWarnings).toEqual({ w1: a });
    ui.setDateWarning('w1', null);
    expect(photoUi.getState().dateWarnings).toEqual({});
  });

  it('the latest day replaces the one before', () => {
    const ui = photoUi.getState();
    ui.setDateWarning('w5', a);
    ui.setDateWarning('w5', b);
    expect(photoUi.getState().dateWarnings.w5).toEqual(b);
    ui.setDateWarning('w5', null);
  });

  it('one run does not touch the warning of another', () => {
    const ui = photoUi.getState();
    ui.setDateWarning('w2', a);
    ui.setDateWarning('w3', b);
    ui.setDateWarning('w2', null);
    expect(photoUi.getState().dateWarnings).toEqual({ w3: b });
    ui.setDateWarning('w4', null);
    expect(photoUi.getState().dateWarnings).toEqual({ w3: b });
    ui.setDateWarning('w3', null);
  });
});

it('keeps a note per run and clears it', () => {
  photoUi.getState().setNote('r1', 'Run r0 is still there: held open');
  expect(photoUi.getState().notes).toEqual({ r1: 'Run r0 is still there: held open' });
  photoUi.getState().setNote('r1', null);
  expect(photoUi.getState().notes).toEqual({});
});
