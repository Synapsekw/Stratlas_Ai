import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
const local = (name) => new URL(name, import.meta.url);
const findings = JSON.parse(
  await readFile(local('../assets/inspection/findings.json'), 'utf8'),
).filter((f) => ['F01', 'F02', 'F05'].includes(f.id));
const logo = await readFile(
  local('../../brand/quadrion/kit/lockup/quadrion-horizontal-on-light.svg'),
  'utf8',
);
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const images = await Promise.all(
  findings.map(
    async (f) =>
      'data:image/jpeg;base64,' +
      (await readFile(local('../assets/inspection/' + f.photo))).toString('base64'),
  ),
);
const font =
  'data:font/woff2;base64,' +
  (await readFile(local('fonts/plex-regular.woff2'))).toString('base64');
const heading = `<header>${logo}<span>SOFTWARE SAMPLE / CONFINED-SPACE INSPECTION</span></header>`;
const foot = (n) =>
  `<footer><span>Quadrion AI · Four dimensions. One view.</span><span>${String(n).padStart(2, '0')} / 04</span></footer>`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Quadrion AI / Sample inspection report</title><style>@font-face{font-family:Plex;src:url('${font}')}*{box-sizing:border-box}@page{size:A4;margin:0}body{margin:0;font-family:Plex,Arial;color:#172b35;background:#eef2f4}.page{width:210mm;height:297mm;padding:22mm 18mm;position:relative;break-after:page}.page:last-child{break-after:auto}header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #cbd6da;padding-bottom:12mm;gap:22mm}header svg{width:58mm;height:auto}header span{font-size:8px;letter-spacing:1px;line-height:1.7;max-width:48mm}.label{font-size:10px;letter-spacing:1.6px;text-transform:uppercase;color:#267e6a;margin-top:22mm}h1{font-size:49px;line-height:1.08;letter-spacing:-2px;font-weight:400;margin:8mm 0}h2{font-size:30px;letter-spacing:-1px;font-weight:400;margin:6mm 0}p{font-size:13px;line-height:1.8;color:#4a606c}.deck{font-size:17px;max-width:145mm}.rule{margin:13mm 0;border-top:1px solid #b9cbd0}.facts{display:grid;grid-template-columns:repeat(3,1fr);gap:6mm;margin:9mm 0}.facts div{border-top:1px solid #b9cbd0;padding-top:4mm}.facts small{display:block;font-size:9px;letter-spacing:1px;color:#4a606c}.facts b{display:block;font-size:16px;margin-top:2mm;font-weight:400}table{border-collapse:collapse;width:100%;font-size:12px}td,th{text-align:left;padding:4mm 2mm;border-bottom:1px solid #cbd6da}th{font-size:9px;letter-spacing:1px;color:#4a606c}.photo{width:100%;height:91mm;object-fit:contain;background:#dce4e7;margin:4mm 0}.caption{font-size:9px;letter-spacing:.6px}.note{font-size:11px;border-top:1px solid #b9cbd0;padding-top:5mm}footer{position:absolute;bottom:17mm;left:18mm;right:18mm;border-top:1px solid #b9cbd0;padding-top:5mm;display:flex;justify-content:space-between;font-size:9px;color:#4a606c}</style></head><body><section class="page">${heading}<p class="label">A CONNECTED CONDITION RECORD</p><h1>Inside the asset.<br>With the evidence.</h1><p class="deck">An anonymized software sample built from original interior inspection findings and photographs.</p><div class="facts"><div><small>SAMPLE SCOPE</small><b>3 source findings</b></div><div><small>SPATIAL FRAME</small><b>Local asset / metres</b></div><div><small>DELIVERABLE</small><b>Evidence register</b></div></div><div class="rule"></div><h2>Finding register</h2><table><thead><tr><th>REFERENCE</th><th>OBSERVATION</th><th>SOURCE SEVERITY</th></tr></thead><tbody>${findings.map((f) => `<tr><td>${f.id}</td><td>${esc(f.title)}</td><td>${f.severity} / 5</td></tr>`).join('')}</tbody></table><p class="note">This fixed sample illustrates Quadrion AI's connected inspection workflow. It reproduces source observations and recorded severity; it is not a new engineering assessment. Customer and site identifiers are omitted. The interactive website's selected register can be exported separately as CSV.</p>${foot(1)}</section>${findings.map((f, i) => `<section class="page">${heading}<p class="label">${f.id} / ${esc(f.area)}</p><h2>${esc(f.title)}</h2><p>${esc(f.description)}</p><div class="facts"><div><small>CLASS</small><b>${esc(f.class)}</b></div><div><small>SOURCE SEVERITY</small><b>${f.severity} / 5</b></div><div><small>RECORDED HEIGHT</small><b>${f.height.toFixed(2)} m</b></div></div><img class="photo" src="${images[i]}" alt="Source photograph for ${f.id}"><p class="caption">ORIGINAL SOURCE IMAGE / ${esc(f.sourceImage)}</p><p class="note">Recorded position: ${f.position.map((n) => n.toFixed(3)).join(', ')} m in the local asset frame. Retain the source project for spatial review, registration context and the full inspection record.</p>${foot(i + 2)}</section>`).join('')}</body></html>`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(html);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((i) => i.decode()));
  });
  await page.pdf({
    path: fileURLToPath(local('quadrion-inspection-sample.pdf')),
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
  });
  console.log('Created four-page Quadrion sample from F01, F02 and F05.');
} finally {
  await browser.close();
}
