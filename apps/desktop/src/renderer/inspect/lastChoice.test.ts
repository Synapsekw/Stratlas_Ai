// @vitest-environment jsdom
/** The class and severity a person last chose in Inspect, per project, kept on this computer. */
import { annotateUi } from '@aio/annotate';
import { afterEach, describe, expect, it } from 'vitest';
import { lastChoiceFor, rememberChoice, trackDrawingChoice } from './lastChoice';

afterEach(() => {
  localStorage.clear();
  annotateUi.setState({ lastClassId: null, lastSeverity: null });
});

describe('lastChoice', () => {
  it('remembers the last choice per project and seeds the drawing picker', () => {
    rememberChoice('p1', { classId: 'crack', severity: 1 });
    expect(lastChoiceFor('p1')).toEqual({ classId: 'crack', severity: 1 });
    expect(lastChoiceFor('p2')).toBeNull();
    annotateUi.setState({ lastClassId: null, lastSeverity: null });
    const stop = trackDrawingChoice('p1');
    expect(annotateUi.getState()).toMatchObject({ lastClassId: 'crack', lastSeverity: 1 });
    stop();
  });

  it('keeps the stored value under quadrion.inspect.last.<projectId>', () => {
    rememberChoice('p1', { classId: 'corrosion', severity: 'uncertain' });
    expect(JSON.parse(localStorage.getItem('quadrion.inspect.last.p1') ?? 'null')).toEqual({
      classId: 'corrosion',
      severity: 'uncertain',
    });
  });

  it('records what the drawing picker confirms, until unsubscribed', () => {
    const stop = trackDrawingChoice('p1');
    annotateUi.setState({ lastClassId: 'corrosion', lastSeverity: 2 });
    expect(lastChoiceFor('p1')).toEqual({ classId: 'corrosion', severity: 2 });
    stop();
    annotateUi.setState({ lastClassId: 'crack', lastSeverity: 1 });
    expect(lastChoiceFor('p1')).toEqual({ classId: 'corrosion', severity: 2 });
  });

  it('reads a damaged or missing value as no choice', () => {
    localStorage.setItem('quadrion.inspect.last.p1', '{not json');
    expect(lastChoiceFor('p1')).toBeNull();
    localStorage.setItem('quadrion.inspect.last.p1', JSON.stringify({ classId: 3 }));
    expect(lastChoiceFor('p1')).toBeNull();
  });
});
