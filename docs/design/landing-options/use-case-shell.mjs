export const useCases = [
  ["confined-spaces.html", "Confined spaces"],
  ["roads.html", "Roads & infrastructure"],
  ["volumetric.html", "Volumetric surveys"],
  ["facades.html", "Facade inspections"],
  ["corrosion.html", "Corrosion in 3D"],
];
export function useCaseMenu() {
  return `<details class="use-case-menu"><summary>Use cases <span aria-hidden="true">⌄</span></summary><div>${useCases.map(([url, title]) => `<a href="${url}">${title} <span>↗</span></a>`).join("")}</div></details>`;
}
export function caseShell(file, title, content) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${title} | Stratlas</title><link rel="icon" href="brand.svg"><link rel="stylesheet" href="atlas-theme.css"><link rel="stylesheet" href="inspection.css"><link rel="stylesheet" href="use-cases.css"></head><body data-page="${file}"><a class="skip-link" href="#main">Skip to content</a><header class="product-nav"><a class="brand" href="atlas.html"><img src="brand.svg" alt=""><span>stratlas</span></a><nav aria-label="Product pages"><a href="atlas.html">Overview</a>${useCaseMenu()}<a href="#capabilities">Capabilities</a><a href="reporting.html">Reports & handover ↗</a></nav></header><main id="main">${content}</main><footer class="product-footer"><div><a class="brand" href="atlas.html"><img src="brand.svg" alt=""><span>stratlas</span></a><p>One connected view of the asset.<br>From capture to handover.</p></div><div>${useCases.map(([url, label]) => `<a href="${url}">${label} ↗</a>`).join("")}</div><div><a href="atlas.html">Platform overview ↗</a><a href="evidence.html">Findings & evidence ↗</a><a href="reporting.html">Reports & handover ↗</a><span class="footer-note">Local product preview · Real survey data</span></div></footer><script type="module" src="../assets/use-cases/use-cases.bundle.js"></script></body></html>`;
}
export function caseHero(kicker, title, copy) {
  return `<section class="page-intro case-intro"><p class="eyebrow"><span class="tiny-square"></span>${kicker}</p><div class="intro-row"><h1>${title}</h1><p>${copy}</p></div></section>`;
}
export function caseCapabilities(title, deck, items) {
  return `<section class="explain-section case-capabilities" id="capabilities"><div class="section-intro"><span class="eyebrow">FROM SURVEY TO DECISION</span><h2>${title}</h2><p>${deck}</p></div><div class="explanation-list">${items.map(([heading, copy], i) => `<article><span>${String(i + 1).padStart(2, "0")}</span><div><h3>${heading}</h3><p>${copy}</p></div></article>`).join("")}</div></section>`;
}
