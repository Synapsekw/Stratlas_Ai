import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assetFolder, projectFolder } from "./private-sources.mjs";
const require = createRequire(import.meta.url),
  sharp = require("sharp");
const here = path.dirname(fileURLToPath(import.meta.url));
const roadProject = projectFolder(
  "ROAD_PROJECT",
  "the road source project (a path, or a folder name)",
);
const pileProject = projectFolder(
  "STOCKPILE_PROJECT",
  "the stockpile source project (a path, or a folder name)",
);
const facadeAssets = assetFolder(
  "FACADE_ASSETS",
  "the prepared facade assets (a folder name under docs/design/assets, or a path)",
);
const out = path.resolve(here, "../assets/use-cases");
await mkdir(out, { recursive: true });
const json = async (p) => JSON.parse(await readFile(p, "utf8"));
const road = await json(path.join(roadProject, "road.json"));
const issues = (await json(path.join(roadProject, "issues.json"))).issues;
const chosen = [];
for (const type of [...new Set(issues.map((i) => i.classId))]) {
  const group = issues
    .filter((i) => i.classId === type)
    .sort(
      (a, b) =>
        b.severity - a.severity ||
        (b.measurements?.[0]?.value || 0) - (a.measurements?.[0]?.value || 0),
    );
  chosen.push(...group.slice(0, 3));
}
const defects = [];
for (const issue of chosen) {
  const sighting = issue.sightings.find((s) => s.on === "image");
  if (!sighting) continue;
  const photo = sighting.photo + ".webp";
  await copyFile(
    path.join(roadProject, "photos/closeups", photo),
    path.join(out, photo),
  );
  const meta = await sharp(path.join(out, photo)).metadata();
  defects.push({
    id: issue.code,
    type: issue.classId.replaceAll("-", " "),
    severity: issue.severity,
    km: Number(issue.title.match(/km ([\d.]+)/)?.[1] || 0),
    area: issue.measurements?.find((m) => m.kind === "area")?.value || 0,
    extent: issue.measurements?.find((m) => m.kind === "distance")?.value || 0,
    photo,
    polygon: sighting.geom.points,
    size: [meta.width, meta.height],
  });
}
await writeFile(
  path.join(out, "roads.json"),
  JSON.stringify({
    count: issues.length,
    centreline: road.centreline,
    sections: road.pci.sections,
    network: road.pci.network,
    ratings: road.pci.ratings,
    defects,
  }),
);
const vols = await json(path.join(pileProject, "volumes.json"));
await writeFile(
  path.join(out, "volumes.json"),
  JSON.stringify({
    bases: vols.bases,
    captures: vols.captures,
    piles: vols.piles.map(({ id, name, epochs, change, zoneRing }) => ({
      id,
      name,
      epochs,
      change,
      zoneRing,
    })),
    totals: vols.totals,
    density: vols.densityTPerM3,
    deadband: vols.deadbandM,
    pileChange: vols.pileChange,
  }),
);
for (const [from, to] of [
  ["terrain-2020-12-31.glb", "survey-e1.glb"],
  ["terrain-2021-01-10.glb", "survey-e2.glb"],
])
  await copyFile(path.join(pileProject, "models", from), path.join(out, to));
const fac = await json(path.join(facadeAssets, "annotations.json"));
const photos = [];
for (const photo of fac.photos) {
  for (const [key, suffix] of [
    ["photo", ".jpg"],
    ["overlay", "-overlay.png"],
  ])
    await copyFile(
      path.resolve(here, "../assets", photo.files[key]),
      path.join(out, photo.photo_id + suffix),
    );
  photos.push({
    id: photo.photo_id,
    size: photo.size_px,
    photo: photo.photo_id + ".jpg",
    overlay: photo.photo_id + "-overlay.png",
    findings: photo.findings.map((f) => ({
      id: f.finding_id,
      defect: f.defect_id,
      severity: Number(f.severity),
      grade: f.severity_label,
      class: f.class,
      component: f.component,
      zone: f.zone,
      height: Number(f.height_m_approx),
      side: f.side_approx,
      note: f.note,
    })),
    boxes: photo.boxes,
  });
}
await writeFile(
  path.join(out, "facades.json"),
  JSON.stringify({ legend: fac.legend_mask_values, photos }),
);
await import("./build-use-cases.mjs");
console.log(
  `Prepared ${defects.length} source road close-ups, ${vols.piles.length} stockpiles across two dates, and ${photos.length} facade images. Source packages unchanged.`,
);
