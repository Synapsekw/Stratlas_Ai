// Settings written by this build stay readable by an 0.8 build on the same machine (rollback or a
// second installed copy). 0.8 keeps each top-level field that its own schema accepts and drops
// the rest (apps/desktop/src/main/settings.ts `merge` at 0.8.0). Its `reportContents` is strict
// over the eight sections it knows, so one later section id would have lost every report choice.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REPORT_SECTIONS_08,
  createSettingsStore,
  defaultSettings,
} from '../../apps/desktop/src/main/settings.ts';
import * as v08 from './schema-0.8/index.mjs';

/** What 0.8.0 keeps of a settings file: each field its schema accepts, as in its `merge`. */
function read08(raw) {
  const kept = {};
  for (const [key, field] of Object.entries(v08.Settings.shape)) {
    if (!(key in raw)) continue;
    const r = field.safeParse(raw[key]);
    if (r.success) kept[key] = r.data;
  }
  return kept;
}

describe('settings an 0.8 build reads', () => {
  let dir;
  let file;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aio-compat-settings-'));
    file = join(dir, 'settings.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps the house report choices when audit and approvals are toggled', async () => {
    const store = createSettingsStore(file, defaultSettings('C:/Data'));
    await store.set({
      theme: 'light',
      reportContents: {
        sections: { appendices: false, audit: false, approvals: false },
        issuePages: 'none',
      },
      team: { autoSync: true, intervalMin: 15 },
    });
    const disk = JSON.parse(await readFile(file, 'utf8'));
    const seen = read08(disk);
    expect(seen.reportContents).toEqual({ sections: { appendices: false }, issuePages: 'none' });
    expect(seen.theme).toBe('light');
    expect(v08.Settings.safeParse(disk).success).toBe(true);
  });

  it('would have lost them with the later sections inside reportContents (the T0 risk)', () => {
    const raw = { reportContents: { sections: { appendices: false, audit: false } } };
    expect(read08(raw).reportContents).toBeUndefined();
  });

  it('knows the same eight sections as the 0.8 schema', () => {
    expect([...REPORT_SECTIONS_08]).toEqual(v08.ReportSectionId.options);
  });
});
