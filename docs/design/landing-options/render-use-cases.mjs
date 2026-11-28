import { writeFile } from "node:fs/promises";
import { caseShell, caseHero, caseCapabilities } from "./use-case-shell.mjs";
const road =
  caseHero(
    "ROAD & INFRASTRUCTURE INSPECTION",
    "Read the road.<br><em>Every metre.</em>",
    "Connect the pavement survey, mapped distresses and condition assessment along one corridor. Move from the network view to a road section, then inspect the original evidence.",
  ) +
  `
<section class="case-lab" aria-label="Interactive road inspection"><div class="lab-heading"><div><span class="eyebrow">THE CORRIDOR, CONNECTED</span><h2>Find the section that needs attention.</h2></div><span class="demo-badge">7.55 KM / 2,115 SOURCE DEFECTS</span></div>
<div class="case-controlbar"><label>PCI severity assumption<select id="road-assumption"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option></select></label><label class="case-wide">Move along the road <output id="road-km-label">0.00 km</output><input id="road-chainage" type="range" min="0" max="7.5467" step="0.01" value="0" aria-label="Chainage in kilometres"></label><div class="case-readout"><span>NETWORK PCI</span><strong id="road-network">87.6</strong></div></div>
<div class="case-workspace road-workspace"><div class="road-corridor"><div class="case-scene-heading"><span>ACTUAL CENTRELINE / SECTION PCI</span><span>SELECT A SECTION</span></div><svg id="road-route" viewBox="0 0 860 590" aria-label="Source road centreline coloured by section condition"></svg><div class="road-legend"></div></div><aside class="case-sidebar"><span class="eyebrow">SELECTED ROAD SECTION</span><h3 class="road-section-title">0.00—0.25 km</h3><div class="road-score"><strong id="road-score">78.1</strong><span id="road-rating">Satisfactory</span></div><p class="road-section-note"></p><div class="road-profile" aria-label="PCI by section"></div><p class="case-note">Scores are the source assessment under the selected Low, Medium or High severity assumption. Changing the assumption changes the scenario, not the recorded defects.</p></aside></div>
<div class="case-evidence-block"><div><span class="eyebrow">FROM THE ROUTE TO THE SURFACE</span><h2>Put a shape<br><em>to the observation.</em></h2><p>Explore 28 source close-ups selected across the defect classes. Each outline follows the original mapped observation.</p><label>Distress type<select id="road-type"><option value="all">All source types</option></select></label><label>Source defect<select id="road-defect"></select></label><label class="inline-toggle"><input id="road-outlines" type="checkbox" checked> Show source outline</label><dl class="case-facts road-defect-facts"></dl></div><figure class="case-photo road-photo"><img alt="Original road survey close-up"><svg aria-label="Original defect outline"></svg><figcaption><span class="road-photo-caption"></span><span>ORIGINAL ORTHOMOSAIC CLOSE-UP</span></figcaption></figure></div></section>` +
  caseCapabilities(
    "From a corridor<br><em>to a clear priority.</em>",
    "The road workspace keeps pavement condition, location and evidence together. Its geospatial tools also support the surrounding infrastructure review.",
    [
      [
        "Build the survey workspace",
        "Bring together an orthomosaic, road centreline, defect polygons and sample units. Set up sample units along the road or on a square grid, with an optional pavement raster.",
      ],
      [
        "Navigate by chainage",
        "Jump to a distance along the centreline or select a chainage range. Search by defect code, class or kilometre and sort by severity, chainage or mapped area.",
      ],
      [
        "Read condition and concentration",
        "Explore the source pavement condition index, the PCI sample-unit grid and defect density. Compare the source severity assumptions and see where observations cluster.",
      ],
      [
        "Inspect the original geometry",
        "Open close-ups, colour defect overlays by type or severity, and control overlay opacity. Measure distance or area on the map while retaining the survey coordinate context.",
      ],
      [
        "Review infrastructure in context",
        "Use map and spatial annotations to document observations around the corridor. Keep their class, severity, location and source evidence in the shared finding register.",
      ],
      [
        "Deliver traceable findings",
        "Carry reviewed findings into report and structured export workflows. Keep the original orthomosaic, polygons and assessment available in the local project for subsequent review.",
      ],
    ],
  );
const volumes =
  caseHero(
    "VOLUMETRIC SURVEYS",
    "Measure the change.<br><em>Explain the number.</em>",
    "Compare survey dates, isolate a stockpile and see how the chosen base changes its volume. Keep the measured terrain, toe boundary and inventory figures in the same view.",
  ) +
  `
<section class="case-lab" aria-label="Interactive volumetric survey"><div class="lab-heading"><div><span class="eyebrow">MEASURED TERRAIN / CONNECTED INVENTORY</span><h2>The ground behind the quantity.</h2></div><span class="demo-badge">19 PILES / 2 DATES / 4 BASES</span></div><div class="case-controlbar"><label>Survey date<select id="volume-date"></select></label><label>Base method<select id="volume-base"></select></label><label>Stockpile<select id="volume-pile"></select></label><button class="case-reset">View whole survey ↺</button></div>
<div class="case-workspace volume-workspace"><div class="volume-scene" tabindex="0" aria-label="Original survey terrain. Drag to orbit and scroll to zoom."><div class="volume-canvas"></div><div class="case-scene-heading"><span class="volume-status" role="status">Loading the original survey model</span><span>DRAG TO ORBIT / SCROLL TO ZOOM</span></div><div class="volume-scene-caption"><span>SELECTED STOCKPILE</span><strong class="volume-name">P02 / Pile 02</strong><span class="volume-date-caption"></span></div></div><aside class="case-sidebar"><span class="eyebrow">SOURCE-COMPUTED VOLUME</span><div class="volume-number"><strong class="volume-net"></strong><span>m³ NET VOLUME</span></div><p class="volume-base-note"></p><dl class="case-facts volume-facts"></dl><div class="volume-compare"><span class="eyebrow">THE TWO SURVEYS</span><div class="volume-bars"></div></div><p class="case-note">Figures come from the source survey grids. Base selection changes the reported calculation; terrain geometry stays the captured surface.</p></aside></div>
<div class="volume-inventory"><div><span class="eyebrow">THE WHOLE INVENTORY</span><h3>Select a pile.</h3><p>Follow the recorded toe boundary and compare the quantities.</p></div><div class="pile-buttons" aria-label="Stockpile register"></div><div class="inventory-total"><span>TOTAL NET / SELECTED DATE & BASE</span><strong></strong></div></div>
<div class="volume-change"><span class="eyebrow">SURFACE CHANGE / SAME COMPARISON FOOTPRINT</span><h2>Material in.<br><em>Material out.</em></h2><div class="change-values"></div><p>Source cut and fill compares the two surfaces over the comparison footprint with a 0.10 m deadband. It is a separate calculation from subtracting base-referenced inventory totals.</p></div></section>` +
  caseCapabilities(
    "A quantity you can<br><em>interrogate.</em>",
    "The desktop volumetric workspace supports the full sequence from survey inputs to boundary correction, change analysis and inventory export.",
    [
      [
        "Bring survey dates together",
        "Create a survey from a DSM GeoTIFF or point cloud and an orthomosaic. Add another survey date to compare the yard over time.",
      ],
      [
        "Choose the base deliberately",
        "Compare triangulated toe, best-fit toe plane, average toe height and lowest toe point. Inspect fill, cut and net volume for each pile; density-based tonnage remains tied to its configured assumption.",
      ],
      [
        "Read the terrain in different ways",
        "Switch photo, elevation and cut/fill displays. Adjust the elevation ramp and range, add hillshade, or swipe between the first and last survey.",
      ],
      [
        "Examine sections and volume bodies",
        "Draw a section through the surveys to compare their profiles. Show volume bodies lifted, in place or hidden, alongside base plates and toe lines.",
      ],
      [
        "Refine the toe boundary",
        "Move boundary vertices, add or remove points, undo an edit and recompute the bases and quantities from the source grids. Save the edited boundary or revert to the automatic result.",
      ],
      [
        "Deliver the inventory",
        "Sort and export the pile register as CSV with fill, cut, net and change. Keep each quantity connected to its pile, date, base and original survey layers.",
      ],
    ],
  );
const facades =
  caseHero(
    "FACADE INSPECTIONS",
    "Every elevation.<br><em>Every observation.</em>",
    "Connect visual and thermal evidence across the building envelope. Explore the source photos, reveal classified regions and keep each observation tied to its component, elevation and recorded finding.",
  ) +
  `
<section class="case-lab" aria-label="Interactive facade inspection"><div class="lab-heading"><div><span class="eyebrow">THE EVIDENCE ON THE ENVELOPE</span><h2>Look closer. Keep the location.</h2></div><span class="demo-badge">6 SOURCE IMAGES / VISUAL + THERMAL</span></div><div class="facade-thumbnails" aria-label="Facade inspection locations"></div><div class="case-controlbar"><label class="inline-toggle"><input id="facade-masks" type="checkbox" checked> Source class masks</label><label>Overlay opacity <output id="facade-opacity-label">65%</output><input id="facade-opacity" type="range" min="0" max="100" value="65" aria-label="Facade mask opacity"></label><label class="inline-toggle"><input id="facade-boxes" type="checkbox" checked> Finding outlines</label><button id="facade-zoom" aria-pressed="false">Inspect at 2×</button></div><div class="case-workspace facade-workspace"><figure class="case-photo facade-photo" tabindex="0" aria-label="Source facade image. Use the zoom button to inspect at twice the scale."><div class="facade-photo-inner"><img class="facade-original" alt="Source facade inspection photo"><img class="facade-overlay" alt="Original class-mask overlay"><svg class="facade-outlines" aria-label="Source detection outlines"></svg></div><figcaption><span class="facade-image-caption"></span><span>ORIGINAL SOURCE EVIDENCE</span></figcaption></figure><aside class="case-sidebar"><span class="eyebrow facade-elevation"></span><h3 class="facade-component"></h3><label>Observation<select id="facade-finding"></select></label><div class="facade-observation" aria-live="polite"></div><dl class="case-facts facade-facts"></dl><div class="facade-legend"></div><p class="case-note">Masks are the source review's region fills, often box-shaped. Locations and heights are approximate; thermal examples show recorded anomalies, not a new diagnosis.</p></aside></div></section>` +
  caseCapabilities(
    "From the elevation<br><em>to the individual issue.</em>",
    "A connected review of cladding, glazing, joints, roof details and other inspected components of the envelope.",
    [
      [
        "Organise the building evidence",
        "Bring registered drone photos, thermal frames and asset geometry into the local project. Use component, zone, elevation and height metadata to orient the review.",
      ],
      [
        "Inspect visual and thermal sources",
        "Zoom into the original evidence. Compare class overlays, observation outlines and source imagery, including thermal anomalies recorded in the source assessment.",
      ],
      [
        "Classify the observed condition",
        "Review cladding and coating damage, glazing, sealants, staining, metalwork and other configured classes. Keep severity and analyst notes beside the photographed region.",
      ],
      [
        "Connect repeated sightings",
        "Keep a finding linked to its source photo and group sightings of the same defect. Where registered geometry is available, use spatial locations to move between the asset and image views.",
      ],
      [
        "Review assisted detections",
        "Inspect proposed detections, accept or reject them, or add a sighting to an existing issue. Edit points, boxes, rotated boxes and polygons with undo and redo.",
      ],
      [
        "Deliver a traceable condition record",
        "Filter and review the finding register, then carry the source images and spatial context into reports and supported exports. Retain the project as a local review workspace.",
      ],
    ],
  );
for (const [file, title, html] of [
  ["roads", "Roads and infrastructure", road],
  ["volumetric", "Volumetric surveys", volumes],
  ["facades", "Facade inspections", facades],
])
  await writeFile(
    new URL("./" + file + ".html", import.meta.url),
    caseShell(file, title, html),
  );
console.log("Rendered roads, volumetric surveys and facade inspections.");
