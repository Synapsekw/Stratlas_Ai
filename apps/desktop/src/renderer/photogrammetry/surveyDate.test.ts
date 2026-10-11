import { describe, expect, it } from 'vitest';
import {
  captureOfRun,
  choiceOf,
  DATE_NOT_SAVED,
  DATE_NOT_SAVED_SHORT,
  dateOptions,
  dateSentence,
  dateWarningPlace,
  dateWarningWords,
  daysNote,
  daysOfItems,
  pickFromChoice,
  pickParams,
  pickSurveyDate,
} from './surveyDate';

const captures = [
  { id: 'c1', label: 'Survey', date: '2026-01-10' },
  { id: 'c2', label: 'After the rain', date: '2026-03-14' },
];
const show = (iso: string) => `<${iso}>`;

describe('pickSurveyDate', () => {
  it('a photos layer that belongs to a date keeps it', () => {
    expect(pickSurveyDate([{ date: '2026-03-14', photos: 9 }], captures, 'c1')).toEqual({
      kind: 'existing',
      captureId: 'c1',
      date: '2026-01-10',
      label: 'Survey',
    });
  });

  it('the day most photos were taken, when the project has a date for it', () => {
    const days = [
      { date: '2026-03-14', photos: 200 },
      { date: '2026-03-13', photos: 3 },
    ];
    expect(pickSurveyDate(days, captures)).toMatchObject({ kind: 'existing', captureId: 'c2' });
  });

  it('a new date when the project has none for that day', () => {
    expect(pickSurveyDate([{ date: '2026-04-02', photos: 12 }], captures)).toEqual({
      kind: 'new',
      date: '2026-04-02',
    });
  });

  it('none when no photo carries a date, and a layer date that is gone is ignored', () => {
    expect(pickSurveyDate(undefined, captures)).toEqual({ kind: 'none' });
    expect(pickSurveyDate([], captures, 'gone')).toEqual({ kind: 'none' });
  });

  it('two dates on one day: the first in the list', () => {
    const twice = [...captures, { id: 'c3', label: 'Second flight', date: '2026-03-14' }];
    expect(pickSurveyDate([{ date: '2026-03-14', photos: 1 }], twice)).toMatchObject({
      captureId: 'c2',
    });
  });
});

describe('daysOfItems', () => {
  it('counts the photos of each day, most photos first', () => {
    expect(
      daysOfItems([
        { takenAt: '2026-03-14T10:00:00+03:00' },
        { takenAt: '2026-03-14T10:00:05+03:00' },
        { takenAt: '2026-03-13T23:59:00+03:00' },
        {},
      ]),
    ).toEqual([
      { date: '2026-03-14', photos: 2 },
      { date: '2026-03-13', photos: 1 },
    ]);
  });

  it('a tie goes to the earlier day', () => {
    expect(
      daysOfItems([{ takenAt: '2026-03-14T08:00:00Z' }, { takenAt: '2026-03-13T08:00:00Z' }]),
    ).toEqual([
      { date: '2026-03-13', photos: 1 },
      { date: '2026-03-14', photos: 1 },
    ]);
  });

  it('gives nothing when no item has a usable date', () => {
    expect(daysOfItems([])).toEqual([]);
    expect(daysOfItems([{}, { takenAt: undefined }])).toEqual([]);
    expect(daysOfItems([{ takenAt: 'yesterday' }, { takenAt: '14/03/2026 10:00' }])).toEqual([]);
  });

  it('skips a date that is not on the calendar', () => {
    expect(
      daysOfItems([
        { takenAt: '2026-99-99T00:00:00' },
        { takenAt: '2026-02-30T10:00:00' },
        { takenAt: '0000-00-00T00:00:00' },
        { takenAt: '2026-03-14T10:00:00' },
      ]),
    ).toEqual([{ date: '2026-03-14', photos: 1 }]);
  });
});

describe('the choice in Options', () => {
  it('round trips through the select value', () => {
    for (const pick of [
      pickSurveyDate([{ date: '2026-03-14', photos: 1 }], captures),
      pickSurveyDate([{ date: '2026-04-02', photos: 1 }], captures),
      pickSurveyDate(undefined, captures),
    ])
      expect(pickFromChoice(choiceOf(pick), captures)).toEqual(pick);
    expect(choiceOf({ kind: 'new', date: '2026-04-02' })).toBe('new:2026-04-02');
    expect(pickFromChoice('gone', captures)).toEqual({ kind: 'none' });
  });

  it('lists None, the dates in date order, and the new day when there is one', () => {
    expect(dateOptions([{ kind: 'new', date: '2026-04-02' }], captures, show)).toEqual([
      { value: '', label: 'None' },
      { value: 'c1', label: '<2026-01-10>' },
      { value: 'c2', label: '<2026-03-14> · After the rain' },
      { value: 'new:2026-04-02', label: 'New: <2026-04-02>' },
    ]);
    expect(dateOptions([{ kind: 'none' }], captures, show)).toHaveLength(3);
  });

  it('offers the new day the person chose after the photos changed', () => {
    const existingC2 = pickSurveyDate([{ date: '2026-03-14', photos: 1 }], captures);
    const chosen = { kind: 'new', date: '2026-05-05' } as const;
    expect(dateOptions([existingC2, chosen], captures, show).map((o) => o.value)).toContain(
      'new:2026-05-05',
    );
    const values = dateOptions([{ kind: 'new', date: '2026-04-02' }, chosen], captures, show).map(
      (o) => o.value,
    );
    expect(values.slice(-2)).toEqual(['new:2026-04-02', 'new:2026-05-05']);
  });

  it('always lists the value the select shows, once', () => {
    const autos = [
      { kind: 'none' },
      pickSurveyDate([{ date: '2026-03-14', photos: 1 }], captures),
      { kind: 'new', date: '2026-04-02' },
    ] as const;
    for (const auto of autos) {
      for (const choice of ['', 'c1', 'new:2026-05-05', 'new:2026-04-02']) {
        const pick = pickFromChoice(choice, captures);
        const values = dateOptions([auto, pick], captures, show).map((o) => o.value);
        expect(values).toContain(choiceOf(pick));
        expect(new Set(values).size).toBe(values.length);
      }
    }
  });
});

describe('what the wizard says', () => {
  it('names the date, says when it is new, and says why there is none', () => {
    expect(dateSentence(pickSurveyDate([{ date: '2026-01-10', photos: 1 }], captures), show)).toBe(
      'Survey date: <2026-01-10>',
    );
    expect(dateSentence(pickSurveyDate([{ date: '2026-03-14', photos: 1 }], captures), show)).toBe(
      'Survey date: <2026-03-14> · After the rain',
    );
    expect(dateSentence({ kind: 'new', date: '2026-04-02' }, show)).toBe(
      'Survey date: <2026-04-02> (new)',
    );
    expect(dateSentence({ kind: 'none' }, show)).toBe('No survey date.');
  });

  it('says so when the photos are from more than one day', () => {
    expect(daysNote([{ date: '2026-03-14', photos: 9 }], show)).toBeNull();
    expect(daysNote(undefined, show)).toBeNull();
    expect(
      daysNote(
        [
          { date: '2026-03-14', photos: 200 },
          { date: '2026-03-13', photos: 3 },
          { date: '2026-03-12', photos: 1 },
        ],
        show,
      ),
    ).toBe('The photos are from 3 days. Most are from <2026-03-14>.');
  });
});

describe('pickParams', () => {
  it('an id for a date that exists, a day for a new one, nothing for none', () => {
    expect(
      pickParams({ kind: 'existing', captureId: 'c2', date: '2026-03-14', label: 'x' }),
    ).toEqual({ capture: 'c2' });
    expect(pickParams({ kind: 'new', date: '2026-04-02' })).toEqual({ captureDate: '2026-04-02' });
    expect(pickParams({ kind: 'none' })).toEqual({});
  });
});

describe('captureOfRun', () => {
  const layers = [
    { id: 'l1', capture: 'by-hand' },
    { id: 'l2', capture: 'from-run' },
    { id: 'l3' },
  ];

  it('the date a layer is filed under wins over the one in the run file', () => {
    expect(captureOfRun(['l1', 'l2'], layers, 'from-run')).toBe('by-hand');
  });

  it('falls back to the run file when no layer has a date', () => {
    expect(captureOfRun(['l3', 'gone'], layers, 'from-run')).toBe('from-run');
  });

  it('skips a layer without a date and takes the first that has one', () => {
    expect(captureOfRun(['l3', 'l2'], layers, undefined)).toBe('from-run');
  });

  it('gives nothing when neither has a date', () => {
    expect(captureOfRun(['l3'], layers, undefined)).toBeUndefined();
    expect(captureOfRun([], [], undefined)).toBeUndefined();
  });
});

describe('dateWarningWords', () => {
  it('pins both sentences word for word', () => {
    expect(DATE_NOT_SAVED).toBe(
      'The survey date could not be saved, so these maps are under no date. If their survey date is in Datasets, move them to it.',
    );
    expect(DATE_NOT_SAVED_SHORT).toBe(
      'The survey date could not be saved, so these maps are under no date.',
    );
  });

  it('with a date to offer and layers to file: the short sentence and a button naming the day', () => {
    expect(dateWarningWords('2026-03-14', true, show)).toEqual({
      sentence: DATE_NOT_SAVED_SHORT,
      button: 'File them under <2026-03-14>',
    });
  });

  it('with a date but the maps still being built: the short sentence, no button yet', () => {
    expect(dateWarningWords('2026-03-14', false, show)).toEqual({
      sentence: DATE_NOT_SAVED_SHORT,
      button: null,
    });
  });

  it('with no date to offer: the full sentence and no button', () => {
    expect(dateWarningWords(undefined, true, show)).toEqual({
      sentence: DATE_NOT_SAVED,
      button: null,
    });
    expect(dateWarningWords('', false, show)).toEqual({ sentence: DATE_NOT_SAVED, button: null });
  });
});

describe('dateWarningPlace', () => {
  it('is on the results when the run is ready and its layers are under no date', () => {
    expect(dateWarningPlace({ warned: true, dated: false, ready: true })).toBe('results');
  });

  it('is on the progress while the maps are still being built', () => {
    expect(dateWarningPlace({ warned: true, dated: false, ready: false })).toBe('progress');
  });

  it('is nowhere once the layers are under a date', () => {
    expect(dateWarningPlace({ warned: true, dated: true, ready: true })).toBeNull();
    expect(dateWarningPlace({ warned: true, dated: true, ready: false })).toBeNull();
  });

  it('is nowhere when the run has no warning', () => {
    expect(dateWarningPlace({ warned: false, dated: false, ready: true })).toBeNull();
    expect(dateWarningPlace({ warned: false, dated: false, ready: false })).toBeNull();
  });
});
