import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importLogo, LOGO_NAME, removeLogo, sniffLogo } from './branding';
import { reportQuery } from './exports/reportWindow';
import { createAioHandler } from './protocol/handler';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let base: string;
let dir: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-brand-'));
  dir = join(base, 'branding');
  await writeFile(join(base, 'logo.png'), PNG);
  await writeFile(join(base, 'fake.png'), 'not an image');
  await writeFile(join(base, 'mark.svg'), '<?xml version="1.0"?>\n<svg xmlns="x"></svg>');
  await writeFile(join(base, 'doc.pdf'), '%PDF');
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('report logo', () => {
  it('tells PNG, JPEG and SVG apart by their bytes', () => {
    expect(sniffLogo(PNG)).toBe('png');
    expect(sniffLogo(new Uint8Array([0xff, 0xd8, 0xff, 0xdb]))).toBe('jpg');
    expect(sniffLogo(Buffer.from('<svg viewBox="0 0 1 1"></svg>'))).toBe('svg');
    expect(sniffLogo(Buffer.from('<html><svg></svg></html>'))).toBeNull();
  });

  it('copies the logo into the branding folder under a content name', async () => {
    const r = await importLogo(join(base, 'logo.png'), dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file).toMatch(LOGO_NAME);
    expect(await readdir(dir)).toEqual([r.file]);
    const svg = await importLogo(join(base, 'mark.svg'), dir);
    expect(svg.ok && svg.file.endsWith('.svg')).toBe(true);
    await removeLogo(dir, r.file);
    await removeLogo(dir, '../logo.png');
    expect(await readdir(dir)).toEqual(svg.ok ? [svg.file] : []);
    expect(await readdir(base)).toContain('logo.png');
  });

  it('refuses files that are not images', async () => {
    expect((await importLogo(join(base, 'fake.png'), dir)).ok).toBe(false);
    expect((await importLogo(join(base, 'doc.pdf'), dir)).ok).toBe(false);
    expect((await importLogo(join(base, 'missing.png'), dir)).ok).toBe(false);
  });

  it('serves only logo files over aio://branding', async () => {
    const r = await importLogo(join(base, 'logo.png'), dir);
    if (!r.ok) throw new Error(r.error);
    const handler = createAioHandler({
      projectRoot: () => undefined,
      packsDir: () => base,
      brandingDir: () => dir,
    });
    const ok = await handler(new Request(`aio://branding/${r.file}`));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect((await handler(new Request('aio://branding/settings.json'))).status).toBe(404);
    expect((await handler(new Request('aio://branding/..%2Flogo.png'))).status).toBe(404);
  });
});

describe('report window query', () => {
  it('carries the branding only when the person set some', () => {
    expect(reportQuery({ projectId: 'p' }, undefined)).toEqual({ project: 'p' });
    expect(reportQuery({ projectId: 'p' }, {})).toEqual({ project: 'p' });
    const q = reportQuery({ projectId: 'p', issueIds: ['a', 'b'] }, { companyName: 'Synapse' });
    expect(q).toEqual({ project: 'p', ids: 'a,b', branding: '{"companyName":"Synapse"}' });
  });
});
