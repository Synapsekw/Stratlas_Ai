import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { privateNames } from "./private-sources.mjs";
const assets = fileURLToPath(new URL("../assets/use-cases/", import.meta.url));
const volume = JSON.parse(await readFile(assets + "volumes.json", "utf8"));
const road = JSON.parse(await readFile(assets + "roads.json", "utf8"));
const facade = JSON.parse(await readFile(assets + "facades.json", "utf8"));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("response", (r) => {
  if (r.status() >= 400) errors.push(r.status() + " " + r.url());
});
const state = () => page.evaluate(() => window.useCasePreview.getState());
async function load(route) {
  await page.goto("http://127.0.0.1:8766/landing-options/" + route + ".html");
  await page.waitForFunction(
    () => document.body.dataset.ready === "true",
    {},
    { timeout: 60000 },
  );
}
async function layout() {
  const s = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    text: document.body.innerText,
    bg: getComputedStyle(document.body).backgroundColor,
  }));
  assert.ok(s.scroll <= s.width, JSON.stringify(s));
  assert.equal(s.bg, "rgb(8, 21, 24)");
  assert.deepEqual(privateNames(s.text), [], "Customer name in visible page");
  await page.evaluate(() =>
    Promise.race([
      Promise.all(
        [...document.images].map((i) => {
          i.loading = "eager";
          return i.decode();
        }),
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(Error("Image loading timed out")), 12000),
      ),
    ]),
  );
}
try {
  await load("roads");
  await layout();
  assert.equal(await page.locator(".road-segment").count(), 31);
  await page.locator("#road-assumption").selectOption("high");
  assert.equal((await state()).network, 77.5);
  assert.equal(
    (await state()).score,
    road.sections[(await state()).section].pci.high,
  );
  await page.locator("#road-chainage").fill("1.1");
  assert.equal((await state()).section, 4);
  await page.locator('.road-segment[data-section="2"]').focus();
  await page.keyboard.press("Enter");
  assert.equal((await state()).section, 2);
  const type = road.defects.at(-1).type;
  await page.locator("#road-type").selectOption(type);
  assert.equal(
    (await state()).filtered,
    road.defects.filter((d) => d.type === type).length,
  );
  assert.equal((await state()).type, type);
  await page.locator("#road-outlines").uncheck();
  assert.equal(await page.locator(".road-photo svg").isVisible(), false);
  await page.locator("#road-outlines").check();
  assert.equal(await page.locator(".road-photo polygon").isVisible(), true);
  console.log(
    "Roads passed: source PCI scenarios, keyboard section selection, chainage, class filters and original defect outlines.",
  );
  await load("volumetric");
  await layout();
  assert.equal((await state()).sceneReady, true);
  assert.equal((await state()).modelCount, 2);
  assert.equal(await page.locator("[data-pile]").count(), 19);
  for (const epoch of ["e1", "e2"]) {
    await page.locator("#volume-date").selectOption(epoch);
    for (const base of ["tin", "plane", "avg", "low"]) {
      await page.locator("#volume-base").selectOption(base);
      const s = await state();
      assert.equal(
        s.net,
        volume.piles.find((p) => p.id === "P02").epochs[epoch].volumes[base]
          .net,
      );
      assert.equal(s.total, volume.totals[epoch][base]);
      assert.equal(s.sceneEpoch, epoch);
    }
  }
  await page.locator("[data-pile=P07]").click();
  assert.equal((await state()).scenePile, "P07");
  assert.equal(
    (await state()).net,
    volume.piles.find((p) => p.id === "P07").epochs.e2.volumes.low.net,
  );
  await page.locator(".case-reset").click();
  assert.equal((await state()).wholeSurvey, true);
  await page.locator(".volume-scene").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => window.useCasePreview.getState().frames > 2);
  await page.screenshot({ path: assets + "volumetric-whole-desktop.png" });
  console.log(
    "Volumes passed: both real terrain models, four source base calculations, date changes, totals and stockpile selection.",
  );
  await load("facades");
  await layout();
  for (const photo of facade.photos) {
    await page.locator(`[data-photo=${photo.id}]`).click();
    assert.equal((await state()).photo, photo.id);
    assert.equal(
      await page.locator("#facade-finding option").count(),
      photo.findings.length,
    );
    await page.locator(".facade-original").evaluate((i) => i.decode());
  }
  assert.ok(
    (await page.locator(".facade-image-caption").innerText()).includes(
      "THERMAL",
    ),
  );
  await page.locator("#facade-masks").uncheck();
  assert.equal(await page.locator(".facade-overlay").isVisible(), false);
  await page.locator("#facade-masks").check();
  await page.locator("#facade-opacity").fill("30");
  assert.equal(
    await page
      .locator(".facade-overlay")
      .evaluate((e) => getComputedStyle(e).opacity),
    "0.3",
  );
  await page.locator("#facade-boxes").uncheck();
  assert.equal(await page.locator(".facade-outlines").isVisible(), false);
  await page.locator("#facade-boxes").check();
  await page.locator("#facade-zoom").click();
  assert.equal((await state()).zoom, true);
  await page.locator("#facade-zoom").click();
  await page.locator("[data-photo=p1736]").click();
  await page.locator("#facade-finding").selectOption("F1399");
  assert.equal((await state()).finding, "F1399");
  console.log(
    "Facades passed: all six source images, linked findings, thermal view, masks, opacity, outlines and zoom.",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ["roads", "volumetric", "facades"]) {
    await load(route);
    await layout();
    await page.locator(".use-case-menu summary").click();
    assert.equal(await page.locator(".use-case-menu a").count(), 5);
    await layout();
    await page.locator(".use-case-menu summary").click();
    await page.locator(".case-workspace").scrollIntoViewIfNeeded();
    await page.screenshot({ path: assets + route + "-mobile.png" });
  }
  await load("confined-spaces");
  await layout();
  assert.equal(await page.locator("main .corrosion-teaser").count(), 0);
  assert.ok(
    !/flare stack|stockpile|road survey|facade/i.test(
      await page.locator("main").innerText(),
    ),
  );
  await page.locator("[data-inside-finding=F05]").click();
  assert.equal(
    await page.evaluate(() => window.inspectionPreview.getState().selected),
    "F05",
  );
  assert.ok(
    (await page.locator(".interior-photo").getAttribute("src")).includes("F05"),
  );
  await page.locator(".scan-colour").selectOption("height");
  assert.equal(
    await page.evaluate(
      () => window.inspectionPreview.getState().scene.scanColour,
    ),
    "height",
  );
  assert.equal(
    await page.evaluate(() => window.inspectionPreview.getState().scene.scanOn),
    true,
  );
  await page.locator(".scan-colour").selectOption("flight");
  assert.equal(
    await page.evaluate(
      () => window.inspectionPreview.getState().scene.scanColour,
    ),
    "flight",
  );
  assert.equal(await page.locator(".capability-index details").count(), 6);
  for (const detail of await page.locator(".capability-index details").all()) {
    if ((await detail.getAttribute("open")) === null)
      await detail.locator("summary").click();
    assert.equal(await detail.locator(".capability-details").isVisible(), true);
  }
  await page.locator(".interior-evidence").scrollIntoViewIfNeeded();
  await page.screenshot({ path: assets + "confined-findings-mobile.png" });
  console.log(
    "Mobile and confined-space controls passed. Checking shared navigation.",
  );
  for (const route of [
    "atlas",
    "index",
    "evidence",
    "reporting",
    "corrosion",
  ]) {
    await page.goto("http://127.0.0.1:8766/landing-options/" + route + ".html");
    const links = await page
      .locator(".use-case-menu a")
      .evaluateAll((a) => a.map((a) => a.getAttribute("href")));
    for (const url of ["roads.html", "volumetric.html", "facades.html"])
      assert.ok(links.includes(url), route + " missing " + url);
    await layout();
  }
  await page.goto("http://127.0.0.1:8766/landing-options/atlas.html");
  assert.equal(await page.locator(".inspection-pages>a").count(), 7);
  assert.deepEqual(errors, []);
  console.log(
    "Confined-space focus, six capability chapters, linked photos and cloud colours passed. All new pages passed mobile layout, source images, navigation and customer-name checks. No browser or HTTP errors.",
  );
} finally {
  await browser.close();
}
