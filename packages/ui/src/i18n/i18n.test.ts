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

describe('pile panel and linked hover strings', () => {
  const expected: Record<string, string[]> = {
    'pile.back': [],
    'pile.position': ['n', 'total'],
    'pile.prev': [],
    'pile.next': [],
    'pile.density': [],
    'pile.densityAria': [],
    'pile.noMaterial': [],
    'pile.pickMaterial': [],
    'pile.volume': [],
    'pile.tonnes': [],
    'pile.vs': ['date'],
    'pile.atDensity': ['density'],
    'pile.first': [],
    'pile.footprint': [],
    'pile.maxHeight': [],
    'pile.base': [],
    'pile.tab.overview': [],
    'pile.tab.profile': [],
    'pile.tab.history': [],
    'pile.more': [],
    'pile.shadeVs': [],
    'pile.lineAxis': ['length'],
    'pile.addDate': [],
    'pile.openLarger': [],
    'pile.cutWhole': [],
    'pile.fill': [],
    'pile.largestDrop': ['chainage', 'value'],
    'pile.lineHint': [],
    'pile.escHint': [],
    'pile.history.title': [],
    'pile.history.both': [],
    'pile.history.first': [],
    'pile.history.was': ['value'],
    'pile.history.note': ['date', 'density', 'material'],
    'hover.following': [],
    'hover.legend': ['date', 'earlier'],
    'hover.snapped': ['chainage'],
    'hover.follows': ['dates'],
    'hover.footer': [],
    'hover.pinned': ['chainage'],
    'hover.pinnedHint': [],
    'hover.split': [],
    'chart.chainageAt': ['value'],
    'chart.deltaCut': ['value'],
    'chart.deltaFill': ['value'],
    'section.close': [],
    'section.addPinHere': [],
  };

  it('has every key with its placeholders and no em or en dashes', () => {
    for (const [k, ph] of Object.entries(expected)) {
      const v = (en as Record<string, string>)[k] ?? '';
      expect(v, k).toBeTruthy();
      expect(v, k).not.toMatch(/[–—]/);
      expect([...placeholders(v)].sort(), k).toEqual(ph);
    }
  });

  it('fills the chart readout and pin strings', () => {
    expect(t('chart.chainageAt', { value: '42.3 m' })).toBe('Chainage 42.3 m');
    expect(t('hover.pinned', { chainage: '71.0 m' })).toBe('71.0 m · pinned');
    expect(t('pile.position', { n: 2, total: 19 })).toBe('Pile 2 of 19');
    expect(t('pile.openLarger')).toBe('Open larger');
    expect(t('pile.addDate')).toBe('+ Date or design');
  });

  it('has the dates strip, cut and fill and materials strings', () => {
    const stageC: Record<string, string[]> = {
      'strip.region': [],
      'strip.play': [],
      'strip.pause': [],
      'strip.previous': [],
      'strip.next': [],
      'strip.speed': ['speed'],
      'strip.loop': [],
      'strip.mode.volume': [],
      'strip.mode.tonnes': [],
      'strip.mode.cutFill': [],
      'strip.compare': [],
      'strip.fit': [],
      'strip.fitAll': [],
      'strip.collapse': [],
      'strip.expand': [],
      'strip.legendCutFill': [],
      'strip.axis.volume': ['unit'],
      'strip.axis.tonnes': [],
      'strip.axis.change': ['unit'],
      'strip.barFill': ['value'],
      'strip.barCut': ['value'],
      'strip.siteTotalOwnScale': [],
      'strip.siteTotalFaded': [],
      'strip.pileChip': ['pile'],
      'strip.clearPile': [],
      'strip.preparing': ['percent'],
      'strip.waiting': ['date'],
      'strip.preview': [],
      'strip.readout.date': ['date'],
      'strip.readout.figures': ['tonnes', 'volume'],
      'strip.readout.delta': ['delta', 'percent'],
      'strip.readout.vs': ['date'],
      'strip.compareLabel': ['delta', 'from', 'to'],
      'strip.bracketFrom': ['date'],
      'strip.bracketTo': ['date'],
      'strip.playhead': [],
      'strip.switch.dates': [],
      'strip.switch.footage': [],
      'strip.switch.aria': [],
      'timelapse.playing': ['date'],
      'timelapse.blend': ['from', 'percent', 'to'],
      'timelapse.between': [],
      'timelapse.crossfade': [],
      'timelapse.swipe': [],
      'timelapse.hold': [],
      'timelapse.siteTotal': [],
      'timelapse.onlyAtSurveys': [],
      'timelapse.lastPassed': ['date'],
      'timelapse.nextSurvey': ['date', 'delta'],
      'timelapse.playbackNote': [],
      'timelapse.fadingIn': [],
      'timelapse.fadingOut': [],
      'volumes.title': [],
      'volumes.source': ['date', 'source'],
      'volumes.export': [],
      'volumes.piles': ['count'],
      'volumes.byMaterial': [],
      'volumes.vs': ['date'],
      'volumes.kpi.volume': [],
      'volumes.kpi.tonnes': [],
      'volumes.segment.inventory': [],
      'volumes.segment.cutFill': [],
      'volumes.segment.materials': [],
      'volumes.groupedBy': ['base'],
      'volumes.deltaVs': ['date'],
      'volumes.col.pile': [],
      'volumes.col.volume': ['unit'],
      'volumes.col.tonnes': [],
      'volumes.col.delta': ['unit'],
      'volumes.siteTotal': [],
      'volumes.noMaterial': [],
      'volumes.more': ['count'],
      'cutfill.from': [],
      'cutfill.to': [],
      'cutfill.insidePiles': [],
      'cutfill.wholeSite': [],
      'cutfill.ignoreUnder': [],
      'cutfill.ignoreAria': [],
      'cutfill.cut': [],
      'cutfill.removed': ['value'],
      'cutfill.fill': [],
      'cutfill.added': ['value'],
      'cutfill.net': [],
      'cutfill.netPiles': ['count', 'value'],
      'cutfill.wholeSiteLine': ['cut', 'fill', 'net'],
      'cutfill.byPile': [],
      'cutfill.byPileHeader': ['unit'],
      'cutfill.folded': ['count', 'value'],
      'cutfill.note': ['delta'],
      'cutfill.legendTitle': ['from', 'to'],
      'cutfill.legendCut': ['value'],
      'cutfill.ignored': ['value'],
      'cutfill.legendFill': ['value'],
      'cutfill.clickPile': [],
      'cutfill.compareFrom': [],
      'cutfill.compareTo': [],
      'cutfill.pair': ['from', 'to'],
      'materials.title': [],
      'materials.add': [],
      'materials.col.material': [],
      'materials.col.density': [],
      'materials.col.swell': [],
      'materials.col.piles': [],
      'materials.col.volume': [],
      'materials.col.tonnes': [],
      'materials.allMaterials': [],
      'materials.unsaved': [],
      'materials.densityFrom': ['new', 'old'],
      'materials.history': [],
      'materials.historyNew': ['date', 'density'],
      'materials.historyKept': ['date', 'density', 'kept'],
      'materials.impact': ['date', 'from', 'other', 'otherTonnes', 'to'],
      'materials.pilesOf': [],
      'materials.unassign': ['pile'],
      'materials.assign': [],
      'materials.cancel': [],
      'materials.save': [],
      'materials.importCsv': [],
      'materials.exportCsv': [],
      'materials.colourBy': [],
      'materials.colourBy.material': [],
      'materials.colourBy.change': [],
      'materials.colourBy.none': [],
      'materials.colour.change': [],
      'materials.colour.none': [],
      'show.caption': [],
      'show.photo': [],
      'show.elevation': [],
      'show.cutFill': [],
      'show.outlines': [],
      'show.labels': [],
      'stockpiles.group': [],
      'stockpiles.count': ['count', 'date'],
      'stockpiles.netChange': ['count'],
      'stockpiles.byMaterial': ['date'],
      'vol.swipe': [],
      'vol.sectionLine': [],
      'vol.swipeBetween': [],
      'mcard.cutPlusFill': [],
    };
    for (const [k, p] of Object.entries(stageC)) {
      const v = (en as Record<string, string>)[k] ?? '';
      expect(v, k).toBeTruthy();
      expect(v, k).not.toMatch(/[–—]/);
      expect([...placeholders(v)].sort(), k).toEqual(p);
    }
    expect(en['base.kitTin']).toBe('Triangulated toe');
    expect(t('timelapse.playing', { date: '5 Jan 2021' })).toBe('Playing · 5 Jan 2021');
    expect(t('volumes.more', { count: 2 })).toBe('+ 2 more');
  });
});

describe('Inspect strings', () => {
  it('has the Inspect strings', () => {
    expect(t('nav.inspect')).toBe('Inspect');
    expect(t('inspect.left', { count: 1 })).toBe('1 photo still has AI suggestions to check');
    expect(t('askAi.cloud.confirm', { count: 3, provider: 'Anthropic', cost: '$0.04' })).toBe(
      'Send 3 photos to Anthropic, about $0.04?',
    );
    expect(t('queue.acceptAbove', { class: 'Corrosion', pct: 80, count: 5 })).toBe(
      'Accept all Corrosion above 80% (5)',
    );
    expect(t('lightbox.openInInspect')).toBe('Open in Inspect');
    expect(t('askAi.reason.walkLocal')).toBe('Walk frames need the local model.');
  });
});

describe('volumetric report strings', () => {
  it('has the editor, page, viewer, Reports and export strings under vreport.*', () => {
    const want: Record<string, string[]> = {
      'vreport.block': [],
      'vreport.title': [],
      'vreport.field.title.default': [],
      'vreport.reset': [],
      'vreport.pictures.take': [],
      'vreport.pictures.stale': [],
      'vreport.export.pdf': [],
      'vreport.export.html': [],
      'vreport.pages.cover': [],
      'vreport.pages.piles': [],
      'vreport.pages.change': [],
      'vreport.readOnly': [],
      'vreport.oneDate': [],
      'vreport.inShort': [],
      'vreport.page.coverContinued': [],
      'vreport.footer': ['company', 'product'],
      'vreport.page.number': ['n'],
      'vreport.key.grey': ['deadband'],
      'vreport.viewer.savePdf': [],
      'vreport.viewer.csv': [],
      'vreport.short.fell': ['date', 'pct', 'volume'],
      'vreport.short.rose': ['date', 'pct', 'volume'],
      'vreport.short.steady': ['date'],
      'vreport.action.pdf': [],
      'vreport.action.html': [],
      'vreport.error.budget': ['limit'],
      'vreport.error.noPictures': [],
      'vreport.error.notOffered': [],
    };
    for (const [k, p] of Object.entries(want)) {
      const v = (en as Record<string, string>)[k] ?? '';
      expect(v, k).toBeTruthy();
      expect([...new Set(placeholders(v))].sort(), k).toEqual(p);
    }
    // no dashes and no minus signs in front of a number anywhere in the report's text
    for (const [k, v] of Object.entries(en))
      if (k.startsWith('vreport.')) expect(v, k).not.toMatch(/[–—]|-\d|−/);
    expect(t('vreport.field.title.default')).toBe('Stockpile volume report');
    expect(t('vreport.block')).toBe('Customer reports');
    expect(t('vreport.action.pdf')).toBe('Volumetric report (PDF)');
    expect(t('vreport.action.html')).toBe('Volumetric report (HTML)');
    expect(t('vreport.page.coverContinued')).toBe('A, continued');
    expect(t('vreport.footer', { company: 'Acme Survey', product: 'P' })).toBe(
      'Prepared by Acme Survey with P',
    );
    expect(t('vreport.page.number', { n: 2 })).toBe('Page 2');
    expect(t('vreport.band.piles', { count: 1 })).toBe('1 pile');
    expect(t('vreport.band.piles', { count: 19 })).toBe('19 piles');
    expect(t('vreport.short.fell', { volume: '12,499 m³', pct: '8 %', date: '3 September' })).toBe(
      'Stock on hand fell by 12,499 m³ (8 %) since 3 September',
    );
    expect(t('vreport.short.pileLess', { pile: 'P04', volume: '4,100 m³' })).toBe(
      'P04 (4,100 m³ less)',
    );
    expect(t('vreport.short.oneDate', { volume: '9,000 m³', count: 3, date: '3 June' })).toBe(
      'Stock on hand is 9,000 m³ across 3 piles on 3 June.',
    );
  });
});
