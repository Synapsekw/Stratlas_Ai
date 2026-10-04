import { ProjectManifest, SCHEMA_VERSION } from '@aio/schema';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, launchApp, test } from './fixtures';

const PROJECT = 'e2e-legacy';

/**
 * A tiny legacy viewer in the shape of the delivered offline reviews: a `<script src>` data
 * file, a JSON fetch, a remote font link and a remote fetch that must never leave the machine,
 * the KIT offline flag, the db shim, and a download through the downloads shim.
 */
const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Legacy fixture</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nunito+Sans">
<script src="data/site.js"></script>
</head>
<body>
<h1>Legacy fixture</h1>
<pre id="out">running</pre>
<button id="save" type="button">Save register</button>
<pre id="saved">idle</pre>
<script>
window.KIT = { target: 'artifact' };
(async () => {
  const r = { site: window.SITE_LOADED === true, kit: window.KIT.target, claude: typeof window.claude };
  r.json = (await (await fetch('data/info.json')).json()).name;
  try { await fetch('https://example.com/remote.json'); r.remote = 'reached'; }
  catch (e) { r.remote = 'blocked'; }
  const db = await window.claude.use('db');
  await db.collection('edits').doc('P01').set({ v: 1 });
  r.db = (await db.collection('edits').get()).size;
  document.getElementById('out').textContent = JSON.stringify(r);
})();
document.getElementById('save').addEventListener('click', async () => {
  const out = document.getElementById('saved');
  try {
    const dl = await window.claude.use('downloads');
    await dl.save({ filename: 'register.csv', data: 'pile,volume\\nP01,12.5\\n' });
    out.textContent = 'saved';
  } catch (e) { out.textContent = 'failed: ' + (e && e.code); }
});
</script>
</body>
</html>
`;

async function writeLegacyProject(dataRoot: string): Promise<string> {
  const dir = join(dataRoot, 'projects', PROJECT);
  await mkdir(join(dir, 'legacy', 'data'), { recursive: true });
  const manifest = ProjectManifest.parse({
    schema: SCHEMA_VERSION,
    id: PROJECT,
    name: 'E2E legacy review',
    customer: 'E2E',
    crs: { epsg: 32639 },
    origin: [0, 0, 0],
    captures: [],
    layers: [
      {
        kind: 'legacy',
        id: 'review',
        name: 'Original review',
        viewer: 'volumetric',
        entry: { path: 'legacy/Legacy Review.html' },
      },
    ],
    severityModels: [],
    classCatalogues: [],
  });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(dir, 'legacy', 'Legacy Review.html'), HTML);
  await writeFile(join(dir, 'legacy', 'data', 'site.js'), 'window.SITE_LOADED = true;\n');
  await writeFile(join(dir, 'legacy', 'data', 'info.json'), JSON.stringify({ name: 'info' }));
  return dir;
}

test('a legacy viewer runs offline in the review, with its shims and no network', async ({
  dataRoot,
  network,
}) => {
  await writeLegacyProject(dataRoot.root);
  const app = await launchApp(dataRoot);
  await network.attach(app);
  try {
    const win = await app.firstWindow();
    await win.getByTestId('project-card').filter({ hasText: 'E2E legacy review' }).click();

    // A legacy-only project lands on its original review.
    await expect(win.locator('.crumbs b')).toHaveText('Original review');
    await expect(win.locator('.review-h')).toContainText('E2E legacy review');
    await expect(win.locator('.review-h')).toContainText('Original review (read-only snapshot)');
    await expect(win.locator('.sb-nav .nav-item', { hasText: 'Original review' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    const frame = win.frameLocator('[data-testid="legacy-frame"]');
    await expect(frame.locator('#out')).not.toHaveText('running');
    expect(JSON.parse((await frame.locator('#out').textContent()) ?? '{}')).toEqual({
      site: true,
      kit: 'offline',
      claude: 'object',
      json: 'info',
      remote: 'blocked',
      db: 1,
    });

    // downloads shim -> parent -> dialog:saveFile -> file on disk.
    const target = join(dataRoot.base, 'register.csv');
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: path });
    }, target);
    await frame.locator('#save').click();
    await expect(frame.locator('#saved')).toHaveText('saved');
    expect(await readFile(target, 'utf8')).toBe('pile,volume\nP01,12.5\n');

    // Back to the native workspace.
    await win.getByRole('button', { name: 'Back to workspace' }).click();
    await expect(win.locator('.crumbs b')).toHaveText('Scene');

    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});
