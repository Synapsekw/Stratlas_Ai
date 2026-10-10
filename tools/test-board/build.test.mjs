import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildModel, buildPage, inline, scriptJson } from './build.mjs';

const config = {
  source: 'docs/TESTING.md',
  title: 'Test run',
  testers: [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ],
  guide: 'How to use this document',
  exclude: ['Stage M7'],
  order: [],
};

const doc = `# Testing

## How to use this document

### Install

- Run the installer.

## Status

| Stage | Status |
| ----- | ------ |
| M5    | Built  |

## Stage M5: your M4 feedback, fixed

Build: the M5 installer.

### Stockpiles

- [ ] Toolbar: **Photo | Elevation** switch.
- [ ] Section tool: the profile appears.
  - the camera stays still

### Notes only

- Nothing to tick here.

## Stage M7 (later): signed builds

- [ ] The update installs.

## Stage M8: change and modelling

### Before you start

Use the demo.

- [ ] Install \`setup.exe\`.
`;

const lines = (model) => model.stages.flatMap((s) => s.groups.flatMap((g) => g.items));

describe('test board build', () => {
  it('keeps every test line of an included stage once, in document order', () => {
    const model = buildModel(doc, config);
    expect(model.stages.map((s) => s.short)).toEqual(['M5', 'M8']);
    expect(lines(model).map((i) => i.html)).toEqual([
      'Toolbar: <b>Photo | Elevation</b> switch.',
      'Section tool: the profile appears.',
      'Install <code>setup.exe</code>.',
    ]);
    expect(lines(model)[1].sub).toEqual(['the camera stays still']);
    expect(new Set(lines(model).map((i) => i.id)).size).toBe(3);
  });

  it('leaves out excluded stages and sections without test lines', () => {
    const titles = buildModel(doc, config).stages.map((s) => s.title);
    expect(titles).not.toContain('Stage M7 (later): signed builds');
    expect(titles).not.toContain('Status');
  });

  it('puts the configured stages first and keeps the rest in document order', () => {
    const model = buildModel(doc, { ...config, exclude: [], order: ['Stage M8'] });
    expect(model.stages.map((s) => s.short)).toEqual(['M8', 'M5', 'M7 (later)']);
  });

  it('keeps the text around the test lines', () => {
    const model = buildModel(doc, config);
    const [m5, m8] = model.stages;
    expect(m5.name).toBe('Your M4 feedback, fixed');
    expect(m5.intro).toContain('Build: the M5 installer.');
    expect(m5.intro).toContain('<h4>Notes only</h4>');
    expect(m5.intro).toContain('Nothing to tick here.');
    expect(m8.groups[0]).toMatchObject({
      title: 'Before you start',
      notes: '<p>Use the demo.</p>',
    });
    expect(model.guide).toEqual([
      { title: 'Install', html: '<ul><li>Run the installer.</li></ul>' },
    ]);
  });

  it('gives a line the same id on every build', () => {
    const ids = (m) => lines(m).map((i) => i.id);
    expect(ids(buildModel(doc, config))).toEqual(ids(buildModel(doc, config)));
    // ids are store document ids: letters, digits and _ - . ~ : @ + only
    for (const id of ids(buildModel(doc, config)))
      expect(id).toMatch(/^[A-Za-z0-9_.~:@+-]{1,200}$/);
  });

  it('escapes text and keeps the data safe inside a script element', () => {
    expect(inline('a <b> & `<i>` **x** [doc](OTHER.md) [site](https://example.com)')).toBe(
      'a &lt;b&gt; &amp; <code>&lt;i&gt;</code> <b>x</b> doc <a href="https://example.com" target="_blank" rel="noreferrer">site</a>',
    );
    expect(scriptJson({ a: '</script>' })).not.toContain('</script>');
    const { html } = buildPage(
      doc,
      config,
      '<title>__TITLE__</title><script>const DATA = __DATA__;</script>',
    );
    expect(html).toContain('<title>Test run</title>');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });

  it('builds the real testing document', () => {
    const real = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
    const text = readFileSync(new URL(`../../${real.source}`, import.meta.url), 'utf8');
    const model = buildModel(text, real);
    const all = lines(model);
    expect(all.length).toBeGreaterThan(100);
    expect(new Set(all.map((i) => i.id)).size).toBe(all.length);
    expect(model.stages.some((s) => s.title.startsWith('Stage M7'))).toBe(false);
    expect(model.guide.length).toBeGreaterThan(0);
    expect(model.owner).toBe('the test lead');
    expect(model.unit).toBe('stage');
  });
});

describe('test board build by vertical', () => {
  const setup = `# Setup

## Setup: install and add the projects

Once per tester.

### Project packages

- [ ] Projects lists all seven.
`;
  const byVertical = {
    ...config,
    unit: 'vertical',
    verticals: [
      { id: 'setup', short: 'SETUP', name: 'Install', about: 'Once.' },
      { id: 'survey', short: 'SURVEY', name: 'Survey' },
      { id: 'unused', short: 'NONE', name: 'No lines' },
      { id: 'app', short: 'APP', name: 'App' },
    ],
    fallback: 'app',
    rules: [
      { stage: 'Setup', to: 'setup' },
      { group: 'Before you start', to: 'setup' },
      { text: '^Section tool', to: 'app' },
      { stage: 'Stage M5', group: 'Stockpiles', to: 'survey' },
    ],
  };

  it('puts every line in one vertical, the first fitting rule deciding', () => {
    const model = buildModel(doc, byVertical, setup);
    expect(model.unit).toBe('vertical');
    expect(model.stages.map((s) => [s.short, lines({ stages: [s] }).map((i) => i.html)])).toEqual([
      ['SETUP', ['Projects lists all seven.', 'Install <code>setup.exe</code>.']],
      ['SURVEY', ['Toolbar: <b>Photo | Elevation</b> switch.']],
      ['APP', ['Section tool: the profile appears.']],
    ]);
    expect(lines(model).every((i) => !('plain' in i))).toBe(true);
  });

  it('names a group by its milestone and keeps the milestone text with it', () => {
    const [setupV, survey] = buildModel(doc, byVertical, setup).stages;
    expect(setupV.intro).toBe('<p>Once.</p>');
    expect(setupV.groups.map((g) => g.title)).toEqual([
      'Project packages',
      'M8 · Before you start',
    ]);
    expect(survey.groups[0].title).toBe('M5 · Stockpiles');
    expect(survey.groups[0].notes).toContain(
      '<summary>About M5: Your M4 feedback, fixed</summary>',
    );
    expect(survey.groups[0].notes).toContain('Build: the M5 installer.');
  });

  it('keeps the ids a line has without verticals, so answers stay with their lines', () => {
    const flat = lines(buildModel(doc, config)).map((i) => i.id);
    const grouped = lines(buildModel(doc, byVertical)).map((i) => i.id);
    expect([...grouped].sort()).toEqual([...flat].sort());
  });

  it('adds the lines of an extra document after the testing document, under their own ids', () => {
    const extra = `# Extra

## Stage X: drafts

Draft lines.

### Stockpiles

- [ ] A drafted line.
`;
    const rules = [{ stage: 'Stage X', to: 'survey' }, ...byVertical.rules];
    const survey = buildModel(doc, { ...byVertical, rules }, setup, extra).stages.find(
      (s) => s.short === 'SURVEY',
    );
    expect(survey.groups.map((g) => g.title)).toEqual(['M5 · Stockpiles', 'X · Stockpiles']);
    expect(survey.groups[1].items[0].id).toMatch(/^extra:stage-x-drafts:/);
    expect(survey.groups[1].notes).toContain('Draft lines.');
  });

  it('refuses a rule that names no vertical', () => {
    const bad = { ...byVertical, rules: [], fallback: 'nowhere' };
    expect(() => buildModel(doc, bad)).toThrow('No vertical "nowhere"');
  });

  it('places every line of the real testing document', () => {
    const real = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
    const text = readFileSync(new URL(`../../${real.source}`, import.meta.url), 'utf8');
    const grouped = {
      ...real,
      verticals: byVertical.verticals,
      fallback: 'app',
      rules: [
        { stage: 'Setup', to: 'setup' },
        { group: 'Before you start', to: 'setup' },
        { stage: 'Stage M11', to: 'survey' },
      ],
    };
    const model = buildModel(text, grouped, setup);
    const flat = lines(buildModel(text, real, setup));
    expect(lines(model).length).toBe(flat.length);
    expect(new Set(lines(model).map((i) => i.id)).size).toBe(flat.length);
    expect(model.stages.map((v) => v.short)).toEqual(['SETUP', 'SURVEY', 'APP']);
    expect(model.stages[0].groups[0].title).toBe('Project packages');
  });
});
