// Electron main for tools/guide/build-pdf.mjs: loads the built guide page (out/renderer/guide.html)
// in a hidden window, waits until it has laid out, and prints it with printToPDF, the same way
// the app prints the house report. Never shows a window, never touches the network or the
// person's profile.
import { app, BrowserWindow, session } from 'electron';
import { renameSync, writeFileSync } from 'node:fs';

// a throwaway profile the caller made (and removes once Electron has quit)
const [page, out, footer = '', profile = ''] = process.argv.slice(-4);
if (profile) app.setPath('userData', profile);

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
const footerTemplate = `<div style="width:100%;margin:0 16mm;display:flex;justify-content:space-between;font-family:'IBM Plex Sans',sans-serif;font-size:7.5pt;color:#7a8594"><span>${escapeHtml(footer)}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  await app.whenReady();
  // offline: anything but local files is refused
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    cb({ cancel: !/^(file|data|blob|devtools|chrome-extension):/i.test(details.url) });
  });
  const win = new BrowserWindow({
    show: false,
    width: 1240,
    height: 1754,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  try {
    await win.loadFile(page);
    const deadline = Date.now() + 120_000;
    let state = null;
    for (;;) {
      if (Date.now() > deadline) throw new Error('The guide took too long to lay out.');
      state = JSON.parse(
        await win.webContents.executeJavaScript('JSON.stringify(window.__guide ?? null)'),
      );
      if (state?.state === 'error') throw new Error(state.error ?? 'The guide failed to lay out.');
      if (state?.state === 'ready') break;
      await sleep(200);
    }
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      pageSize: 'A4',
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate,
    });
    writeFileSync(`${out}.part`, pdf);
    renameSync(`${out}.part`, out);
    process.stdout.write(
      `${JSON.stringify({ ok: true, bytes: pdf.length, chapters: state.chapters, images: state.images })}\n`,
    );
  } finally {
    win.destroy();
  }
}

run()
  .then(() => {
    app.exit(0);
  })
  .catch((e) => {
    process.stderr.write(`${String(e?.stack ?? e)}\n`);
    app.exit(1);
  });
