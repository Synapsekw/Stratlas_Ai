import { afterEach, describe, expect, it } from 'vitest';
import { en } from './en';
import {
  catalogueProblems,
  directionOf,
  getLocale,
  placeholders,
  setLocale,
  t,
  type Catalogue,
} from './index';

afterEach(() => {
  setLocale('en');
});

describe('t', () => {
  it('returns the English string for a key', () => {
    expect(t('nav.projects')).toBe('Projects');
  });

  it('fills placeholders', () => {
    expect(t('settings.maps.installed', { count: 3, size: '1.3 GB' })).toBe('3 · 1.3 GB');
  });

  it('picks the plural form from the count', () => {
    expect(t('library.count', { count: 1 })).toBe('1 project');
    expect(t('library.count', { count: 6 })).toBe('6 projects');
  });

  it('falls back to English for keys a locale does not have yet', () => {
    const ar: Catalogue = { 'nav.projects': 'المشاريع' };
    setLocale('ar', ar);
    expect(getLocale()).toBe('ar');
    expect(t('nav.projects')).toBe('المشاريع');
    expect(t('nav.issues')).toBe('Issues');
  });
});

describe('directionOf', () => {
  it('knows the right-to-left scripts', () => {
    expect(directionOf('ar')).toBe('rtl');
    expect(directionOf('ar-KW')).toBe('rtl');
    expect(directionOf('he')).toBe('rtl');
    expect(directionOf('en')).toBe('ltr');
    expect(directionOf('fr-FR')).toBe('ltr');
  });
});

describe('the English catalogue', () => {
  it('has no problems', () => {
    expect(catalogueProblems(en, en)).toEqual([]);
  });

  it('uses no em or en dashes (CONTRIBUTING)', () => {
    for (const [k, v] of Object.entries(en)) expect(v, k).not.toMatch(/[–—]/);
  });

  it('has the volumetric parity strings, the card under mcard.*', () => {
    const keys = [
      'chart.addSurface',
      'chart.direction',
      'mcard.recomputeStandard',
      'mcard.carried',
      'mcard.allPiles',
      'base.smart',
      'base.mean',
      'vol.ignoreSmaller',
      'vol.status.ok',
      'cleanup.straight',
      'heat.editColours',
      'settings.angles.dms',
      'report.already',
      'empty.volumes.title',
    ];
    for (const k of keys) expect(Object.keys(en), k).toContain(k);
    expect(t('chart.direction', { a: 'A', b: 'B' })).toBe('A → B');
    expect(t('mcard.spread', { pct: '3%' })).toBe('±3% across bases');
  });

  it('has the strings for adding a survey date', () => {
    const keys = [
      'change.surveyDateNew',
      'change.surveyDateNewDay',
      'change.surveyDateAdd',
      'change.surveyDateCancel',
      'change.surveyDateNewTag',
      'change.surveyDateFrom.photos',
      'change.surveyDateFrom.video',
      'change.surveyDateFrom.both',
      'tree.addDate',
      'tree.addDate.tip',
      'tree.addDate.date',
      'tree.addDate.name',
      'tree.addDate.namePlaceholder',
      'tree.addDate.submit',
      'tree.addDate.folder',
      'tree.addDate.folderHint',
      'tree.addDate.folderTitle',
      'tree.addDate.exists',
      'tree.addDate.invalid',
      'tree.datePrompt.existing',
      'tree.datePrompt.new',
      'tree.datePrompt.file',
      'tree.datePrompt.later',
      'palette.addSurveyDate',
      'palette.importFlightFolder',
    ];
    for (const k of keys) {
      const v = (en as Record<string, string>)[k];
      expect(v, k).toBeTruthy();
      expect(v, k).not.toMatch(/—/);
    }
    expect(t('tree.datePrompt.title', { count: 1 })).toBe(
      '1 dataset in Every date was recorded on a survey day.',
    );
    expect(t('tree.datePrompt.title', { count: 3 })).toBe(
      '3 datasets in Every date were recorded on survey days.',
    );
    expect(t('tree.datePrompt.done', { count: 1 })).toBe('Filed 1 dataset.');
    expect(t('tree.datePrompt.done', { count: 4 })).toBe('Filed 4 datasets.');
    expect(t('tree.datePrompt.mixed', { count: 1 })).toBe(
      '1 dataset holds photos from several days. Move it by hand.',
    );
    expect(t('tree.datePrompt.mixed', { count: 2 })).toBe(
      '2 datasets hold photos from several days. Move them by hand.',
    );
    expect(en['change.surveyDateNew']).toBe('New survey date...');
  });

  it('has the strings for placing findings on a model', () => {
    expect(t('place.offer', { count: 2 })).toBe('Connect 2 findings to a model?');
    expect(t('place.offer', { count: 1 })).toBe('Connect 1 finding to a model?');
    expect(t('place.result', { placed: 12, count: 14, layer: 'Mesh 3 Mar' })).toBe(
      'Placed 12 of 14 on Mesh 3 Mar.',
    );
    expect(t('place.missed', { count: 2 })).toBe('2 missed the model.');
    expect(t('place.match', { code: 'AI-31', other: 'AI-12', date: '3 Mar' })).toBe(
      'AI-31 looks like AI-12 from 3 Mar',
    );
    expect(t('place.menu', { count: 1 })).toBe('Place on model...');
    expect(t('place.menu', { count: 3 })).toBe('Place 3 on model...');
    expect(t('place.changed', { count: 1 })).toBe('1 changed while placing and was left as it is.');
    expect(t('place.changed', { count: 2 })).toBe(
      '2 changed while placing and were left as they are.',
    );
    expect(t('place.selectionFailed', { count: 1, error: 'disk full' })).toBe(
      'The points of 1 finding could not be saved: disk full',
    );
    expect(t('place.selectionFailed', { count: 3, error: 'disk full' })).toBe(
      'The points of 3 findings could not be saved: disk full',
    );
    expect(t('place.undoStale')).toBe(
      'Not undone: another change came after the placement. Ctrl+Z undoes one step at a time.',
    );
    for (const [k, v] of Object.entries(en))
      if (k.startsWith('place.')) expect(v, k).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('has the strings for lining up dates', () => {
    const keys = [
      'lineUp.title',
      'lineUp.action',
      'lineUp.confirm',
      'lineUp.cancel',
      'lineUp.notNow',
      'lineUp.keep',
      'lineUp.keepHint',
      'lineUp.measuring',
      'lineUp.shift',
      'lineUp.east',
      'lineUp.west',
      'lineUp.north',
      'lineUp.south',
      'lineUp.confident',
      'lineUp.moves',
      'lineUp.layers_one',
      'lineUp.layers_other',
      'lineUp.items_one',
      'lineUp.items_other',
      'lineUp.before',
      'lineUp.after',
      'lineUp.done',
      'lineUp.undone',
      'lineUp.redone',
      'lineUp.removed',
      'lineUp.offer',
      'lineUp.source.ortho',
      'lineUp.source.dsm',
      'lineUp.refuse.texture',
      'lineUp.refuse.disagree',
      'lineUp.refuse.overlap',
      'lineUp.refuse.aligned',
      'lineUp.refuse.range',
      'lineUp.refuse.far',
      'lineUp.refuse.noImagery',
      'lineUp.turn',
      'lineUp.cloudsNoTurn',
      'lineUp.failed',
      'lineUp.folder',
      'lineUp.remove',
      'change.misaligned',
      'change.stale',
      'change.rerun',
    ];
    for (const k of keys) {
      const v = (en as Record<string, string>)[k];
      expect(v, k).toBeTruthy();
      expect(v, k).not.toMatch(/[–—]/);
    }
    expect(t('lineUp.items', { count: 1 })).toBe('1 drawn item');
    expect(t('lineUp.items', { count: 3 })).toBe('3 drawn items');
    expect(t('lineUp.layers', { count: 1 })).toBe('1 dataset');
    expect(t('lineUp.layers', { count: 2 })).toBe('2 datasets');
    expect(t('change.misaligned', { distance: '2.01 m' })).toBe('These dates are 2.01 m apart.');
    expect(t('lineUp.turn', { deg: '0.25', pct: '+0.35%' })).toBe('turned 0.25°, scaled +0.35%');
    expect(t('lineUp.cloudsNoTurn')).toBe("Point clouds move but don't turn yet.");
    expect(t('lineUp.refuse.disagree')).toBe(
      "These dates cannot be lined up: their parts don't fit one shift, turn and scale, so part of the site may have warped or changed too much.",
    );
    expect(t('lineUp.refuse.range')).toBe(
      'These dates cannot be lined up: one is turned more than 1° or scaled more than 1% against the other, or would move more than 500 m.',
    );
  });

  it('has the strings for editing photo positions', () => {
    const keys = [
      'position.edit',
      'position.reset',
      'position.title_one',
      'position.title_other',
      'position.x',
      'position.y',
      'position.z',
      'position.unit',
      'position.hint.one',
      'position.hint.many',
      'position.original',
      'position.save',
      'position.cancel',
      'position.edited',
      'position.say.saved_one',
      'position.say.saved_other',
      'position.say.reset_one',
      'position.say.reset_other',
      'position.say.undone',
      'position.say.redone',
      'position.why.pinned',
      'position.why.unplaced',
      'position.why.notEdited',
      'position.invalid',
      'position.reread',
      'position.reread.confirm',
      'position.reread.refined',
      'position.reread.pickFolder_one',
      'position.reread.pickFolder_other',
      'position.say.reread_one',
      'position.say.reread_other',
      'position.say.rereadKept_one',
      'position.say.rereadKept_other',
      'position.say.rereadMissing_one',
      'position.say.rereadMissing_other',
      'position.twin.used',
      'position.twin.none',
      'position.say.twins_one',
      'position.say.twins_other',
    ];
    for (const k of keys) {
      const v = (en as Record<string, string>)[k];
      expect(v, k).toBeTruthy();
      expect(v, k).not.toMatch(/[–—]/);
    }
    expect(t('position.title', { count: 1 })).toBe('Position');
    expect(t('position.title', { count: 2 })).toBe('Shift 2 photos');
    expect(t('position.say.saved', { count: 1 })).toBe('Moved 1 photo.');
    expect(t('position.say.saved', { count: 3 })).toBe('Moved 3 photos.');
    expect(t('position.say.reset', { count: 1 })).toBe('Put 1 photo back where it was imported.');
    expect(t('position.say.twins', { count: 1 })).toBe(
      '1 thermal photo placed at its visual twin.',
    );
  });

  it('has the strings for prepared surfaces and their states', () => {
    const want: Record<string, string> = {
      'surface.state.ready': 'ready',
      'surface.state.preparing': 'preparing {pct} %',
      'surface.state.prepare': 'Prepare',
      'surface.state.none': 'No elevation for this date',
      'surface.preparing.title': 'Preparing survey surfaces',
      'surface.preparing.count': 'Preparing {done} of {total}',
      'surface.preparing.onOpen':
        'Started on its own when the project opened. You can keep working.',
      'mcard.surfacePreparing': 'Surface preparing',
      'mcard.noElevation': 'No elevation for this date',
      'mcard.notMeasured': 'Not measured on this date',
      'chart.building': 'Building the height surface for {date}…',
      'chart.buildingRest':
        'The {ready} line is ready; {waiting} and the cut/fill shading appear when it finishes.',
      'settings.autoPrepare.label': 'Prepare survey surfaces when a project opens',
      'settings.autoPrepare.hint': 'Runs in the background and shows in Jobs. You can cancel it.',
    };
    for (const [k, v] of Object.entries(want)) {
      expect((en as Record<string, string>)[k], k).toBe(v);
    }
    expect(t('surface.state.preparing', { pct: 62 })).toBe('preparing 62 %');
    expect(t('surface.preparing.count', { done: 1, total: 2 })).toBe('Preparing 1 of 2');
  });

  it('finds missing keys and placeholder mismatches in a translation', () => {
    expect(placeholders('{count} of {total}')).toEqual(['count', 'total']);
    const bad: Catalogue = { 'library.count_one': '{n} مشروع', 'nope.key': 'x' };
    const problems = catalogueProblems(bad, en);
    expect(problems).toContain('library.count_one: placeholders {n} do not match {count}');
    expect(problems).toContain('nope.key: not in the English catalogue');
  });
});

describe('RF coverage texts', () => {
  it('name the Coverage panel, never the old RF tab', () => {
    const rf = Object.entries(en).filter(([k]) => k.startsWith('rf.'));
    expect(rf.filter(([, v]) => /\bRF tab\b/.test(v)).map(([k]) => k)).toEqual([]);
    expect(t('rf.layer.none')).toContain('Coverage panel');
  });

  it('never promise that Auto-plan plans a draft (F6)', () => {
    expect(t('rf.autoplan.left.draft')).not.toMatch(/include drafts/i);
  });
});

describe('the thermal bench strings', () => {
  it('has the workbench tab, the analyse action and the thermal group', () => {
    const keys = [
      'wb.tab.thermal',
      'actions.thermal.analyse',
      'thermal.palette.iron',
      'thermal.palette.rainbow',
      'thermal.palette.whiteHot',
      'thermal.palette.blackHot',
      'thermal.palette.arctic',
      'thermal.range.auto',
      'thermal.hover',
      'thermal.settings.line',
      'thermal.settings.edit',
      'thermal.settings.emissivity',
      'thermal.settings.distance',
      'thermal.settings.air',
      'thermal.settings.humidity',
      'thermal.settings.reflected',
      'thermal.settings.reflectedSameAsAir',
      'thermal.settings.applyPhoto',
      'thermal.settings.applySelected_one',
      'thermal.settings.applySelected_other',
      'thermal.settings.applyAll',
      'thermal.settings.clamped',
      'thermal.decoding_one',
      'thermal.decoding_other',
      'thermal.status.unsupported',
      'thermal.status.unverified',
      'thermal.status.implausible',
      'thermal.readOnly',
      'thermal.none',
      'thermal.filmstrip',
    ];
    for (const k of keys) {
      const v = (en as Record<string, string>)[k];
      expect(v, k).toBeTruthy();
      expect(v, k).not.toMatch(/[–—]/);
    }
    expect(en['wb.tab.thermal']).toBe('Thermal');
    expect(en['actions.thermal.analyse']).toBe('Analyse thermal');
    expect(t('thermal.hover', { temp: '42.5' })).toBe('42.5 °C');
    expect(t('thermal.settings.line', { e: '0.95', d: '10', a: '20', h: '50' })).toBe(
      'Emissivity 0.95 · Distance 10 m · Air 20 °C · Humidity 50%',
    );
    expect(t('thermal.settings.applySelected', { count: 1 })).toBe('1 selected photo');
    expect(t('thermal.settings.applySelected', { count: 3 })).toBe('3 selected photos');
    expect(t('thermal.decoding', { count: 1 })).toBe('Reading temperatures of 1 photo');
    expect(t('thermal.decoding', { count: 4 })).toBe('Reading temperatures of 4 photos');
  });
});
