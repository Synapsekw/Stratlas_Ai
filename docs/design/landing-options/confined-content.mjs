const capabilities = [
  [
    "01",
    "Bring the interior together",
    "Model, measured surfaces and inspection media in one asset frame.",
    [
      [
        "Engineering geometry",
        "Read the shell, roof, floor, lining, nozzles and internal components together. Keep the model as the reference for the inspection.",
      ],
      [
        "Interior LiDAR",
        "Overlay captured points, adjust point size and colour by elevation, intensity or flight. In the platform, depth shading helps separate nearby surfaces.",
      ],
      [
        "Source media and registration",
        "Connect photos, inspection video and recorded camera poses. Use the local asset frame when geographic coordinates are unavailable.",
      ],
    ],
  ],
  [
    "02",
    "Reveal the space",
    "Choose the view that makes an internal surface readable.",
    [
      [
        "Sections and cutaways",
        "Move a horizontal section through the tank or turn a vertical cut. Compare the model and scan without the surrounding shell obstructing the view.",
      ],
      [
        "Transparency and inside views",
        "Keep the asset outline visible while reading its internals. Orbit, zoom, reset the view or look from inside the structure.",
      ],
      [
        "Layer and finding controls",
        "Show or hide geometry, point clouds, flight paths and issue pins independently. The platform also supports severity filters and a finding heat map.",
      ],
    ],
  ],
  [
    "03",
    "Replay the inspection",
    "Follow the recorded camera through the interior.",
    [
      [
        "One clock across views",
        "Play, pause and seek the recording while the spatial drone position follows its source poses.",
      ],
      [
        "Orbit, follow and drone eye",
        "Read the whole tank, travel alongside the drone or occupy its recorded camera position. Change between the model and measured interior from the same viewpoint.",
      ],
      [
        "Augmented video and telemetry",
        "The desktop platform projects calibrated footage onto registered geometry and shows the camera frustum, flight path and telemetry. This page demonstrates the linked recording, model and scan.",
      ],
    ],
  ],
  [
    "04",
    "Locate and document a finding",
    "Keep the observation attached to its evidence.",
    [
      [
        "Image, video and spatial annotations",
        "Mark points, boxes, rotated boxes and polygons on photos. Use video keyframes and event ranges, and annotate the model or point cloud.",
      ],
      [
        "Cross-view sightings",
        "With registered poses and geometry, carry a photo or video observation into 3D. Group multiple sightings under one issue and return to the original source.",
      ],
      [
        "Measurements in context",
        "Measure between spatial points and retain the coordinate context. The linked evidence preview lets you compare the source positions of two findings.",
      ],
    ],
  ],
  [
    "05",
    "Review the condition",
    "Turn observations into an organised inspection register.",
    [
      [
        "Zones, classes and severity",
        "Find roof, shell, joint and floor observations. Filter the register by severity, classification, source, status or text.",
      ],
      [
        "Review and consolidate",
        "Update issue status, group findings by zone, merge related sightings and use undo or redo while refining the register.",
      ],
      [
        "Assisted analysis",
        "Bind an AI conversation to the current photo, video frame, 3D view or findings. Compare captures, find nearby issues and summarise by zone or class using the configured model and permissions.",
      ],
    ],
  ],
  [
    "06",
    "Deliver a reviewable inspection",
    "Give the recipient the conclusion and the way back to the evidence.",
    [
      [
        "Reports with source evidence",
        "Generate inspection and issue-register PDFs with severity summaries, finding tables, source photos and spatial views in the desktop platform.",
      ],
      [
        "Structured exports",
        "Export a CSV register and supported spatial or annotation formats for follow-on work. Try the connected CSV report preview here.",
      ],
      [
        "Portable, local review",
        "Package the chosen layers and evidence in an .aio project for read-only review, with optional protection and export permissions. Core inspection review works locally; cloud AI is optional.",
      ],
    ],
  ],
];

export function refineConfined(html) {
  const tail = `<section class="interior-evidence" id="interior-findings">
    <div class="section-intro"><span class="eyebrow">FROM THE FLOOR TO THE ROOF</span><h2>Every finding.<br><em>A place inside.</em></h2><p>Explore six original observations from this tank. Select a finding to connect its photograph, height and location in the model above.</p></div>
    <div class="interior-evidence-grid"><div class="interior-register" aria-label="Interior findings"></div><figure class="interior-source"><img class="interior-photo" src="../assets/inspection/F01.jpg" alt="Source photograph of the tank bottom plate"><figcaption><span class="interior-source-id">SOURCE / 109_0256</span><span>ORIGINAL INSPECTION PHOTO</span></figcaption></figure><div class="interior-observation" aria-live="polite"><span class="eyebrow interior-zone">BOTTOM PLATE</span><h3 class="interior-title">Crack in bottom plate</h3><p class="interior-description"></p><dl class="interior-facts"></dl><button class="interior-locate">Locate in the tank ↑</button><a class="interior-open" href="evidence.html?finding=F01">Inspect and annotate the evidence ↗</a></div></div>
    <p class="data-note">Six source findings shown. Grades and observations are retained from the inspection record.</p>
  </section>
  <section class="interior-capabilities" id="interior-capabilities"><div class="section-intro"><span class="eyebrow">THE CONFINED-SPACE WORKFLOW</span><h2>From an enclosed space<br><em>to a complete inspection.</em></h2><p>Explore the platform capabilities behind each step. The live tank above and the connected evidence and report pages let you try the core review workflow.</p></div><div class="capability-index">${capabilities.map(([n, title, deck, items], i) => `<details ${i === 0 ? "open" : ""}><summary><span>${n}</span><div><h3>${title}</h3><p>${deck}</p></div><b aria-hidden="true">+</b></summary><div class="capability-details">${items.map(([heading, copy]) => `<article><h4>${heading}</h4><p>${copy}</p></article>`).join("")}</div></details>`).join("")}</div></section>
  <section class="interior-handover" id="interior-handover"><div><span class="eyebrow">KEEP THE INSPECTION CONNECTED</span><h2>Read the evidence.<br><em>Build the handover.</em></h2><p>Continue with this same tank and its source findings.</p></div><div><a href="evidence.html"><span>01 / REVIEW</span><h3>Findings & evidence</h3><p>Filter observations, inspect source photos, try annotations and measure between finding locations.</p><b>Open the evidence workspace ↗</b></a><a href="reporting.html"><span>02 / DELIVER</span><h3>Reports & handover</h3><p>Select findings, shape the report, download the sample CSV and explore a portable review package.</p><b>Build the sample report ↗</b></a></div></section>
  <section class="questions"><span class="eyebrow">WORKING INSIDE THE ASSET</span><div><details open><summary>Can I change what the drone sees?</summary><p>Yes. Choose Drone eye, then switch the engineering model and LiDAR layers. Both follow the recorded camera position. The desktop platform also supports calibrated video projection onto registered geometry.</p></details><details><summary>How are findings located inside the tank?</summary><p>The source findings carry positions in the same local metre-based frame as the model and scan. The selected photograph and model pin refer to the same recorded observation.</p></details><details><summary>What can I do offline?</summary><p>Review the local model, scan, photos, video, findings and delivered reports. Optional cloud AI requires a configured connection; the underlying inspection remains accessible locally.</p></details><details><summary>What does this live example contain?</summary><p>A real engineering model, 280,000 captured points from two interior flights, an 11-second interior video excerpt with camera poses and six source findings. The camera view here uses a pinhole approximation of the original wide-angle lens.</p></details></div></section>`;
  html = html
    .replace(
      "The outside is<br>only <em>the beginning.</em>",
      "A complete view.<br><em>From the inside.</em>",
    )
    .replace(
      "Reconstruct the space around an inspection. Connect the engineering model, interior LiDAR, recorded flight and observations, then explore the asset from whichever view explains it best.",
      "Inspect the roof, shell, joints and floor in one connected workspace. Bring interior LiDAR, drone footage and engineering geometry together, then follow each finding from its position to the evidence and report.",
    )
    .replace(
      '<section class="inspection-lab"',
      '<nav class="interior-jumps" aria-label="On this page"><a href="#interactive-tank">01 / Explore the interior</a><a href="#interior-findings">02 / Locate findings</a><a href="#interior-capabilities">03 / All capabilities</a><a href="#interior-handover">04 / Review & deliver</a></nav><section class="inspection-lab"',
    )
    .replace(
      '<fieldset class="layer-options">',
      '<fieldset class="layer-options">',
    )
    .replace(
      '</fieldset><span class="eyebrow">03 / CHANGE',
      '</fieldset><label class="scan-colour-label">Read the point cloud<select class="scan-colour" aria-label="Point cloud colour"><option value="intensity">Return intensity</option><option value="height">Height in the tank</option><option value="flight">Capture flight</option></select><span class="scan-colour-note">Turn on Interior LiDAR to explore the measured surfaces.</span></label><span class="eyebrow">03 / CHANGE',
    );
  return (
    html.slice(0, html.indexOf('<section class="corrosion-teaser">')) + tail
  );
}
