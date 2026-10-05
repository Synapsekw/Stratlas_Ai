# Stratlas: competitors and pricing (market research)

Prepared 2026-10-05. Public web pages only: no sign-ups, no quotes requested. Every price shows a source tag `[Sn]`, and the full URLs are listed under Sources. All pages were seen on **2026-10-05** unless marked otherwise. These tags mark how reliable each figure is:

- **(3P)**: the figure comes from a reseller or aggregator, not the vendor's own page.
- **(pre-2025)**: the source is dated before 2025.
- **(inferred)**: our own estimate or reasoning, not a published figure.

USD is used throughout. **FX check:** 1 KWD ≈ **3.24 USD** (about 3.237–3.240 on 2026-10-04; 30-day range 3.234–3.247) [S60]. The working assumption of 3.25 is about 0.3% high. KWD figures below use 3.24.

---

## 1. Summary

1. **No product does the full combination.** No product found combines an offline desktop app, video + 3D + point cloud + map fusion, issue management at scale, an in-app AI agent, builder pipelines and encrypted client packages with a free player.
2. **The closest three are:**
   - **Flyability Inspector 5**: video + point cloud + POIs + reports on the desktop, but tied to Elios 3 data.
   - **Esri ArcGIS Pro + Image Analyst (geospatial video) + Drone2Map/Reality**: powerful, but a costly multi-product stack with no packaged inspection workflow.
   - **DJI FlightHub 2 (on-prem) + DJI Terra**: AI detection, 3D and an analyzer, but cloud/server-centric and DJI-only.
3. **Market price bands:**
   - Viewers and collaboration tools: **$20–150/month**.
   - Desktop processing: **$1.8k–5k/year**, or **$3.5k–11k perpetual**.
   - Cloud platforms: **$1.3k–10k per seat or site per year**.
   - Enterprise: "contact us".
4. **Recommendation: launch at the conservative list prices below. Push enterprise and government deals toward the aggressive band, which is value-based.**

| Tier                            | Monthly | Annual (USD)           | Annual (KWD)   | Seats / machines                                        |
| ------------------------------- | ------- | ---------------------- | -------------- | ------------------------------------------------------- |
| **Player** (package recipients) | Free    | Free                   | Free           | Unlimited, offline                                      |
| **Pro Reviewer**                | $79     | $790                   | KWD 245        | 1 named user, 2 machines                                |
| **Builder**                     | $299    | $2,990                 | KWD 925        | 1 named user, 2 machines, pipelines + package export    |
| **Team / Enterprise**           | n/a     | from $12,000 (5 seats) | from KWD 3,700 | Floating/offline licences, perpetual option, onboarding |

The aggressive option is Pro $149/mo ($1,490/yr), Builder $449/mo ($4,490/yr), Enterprise from $24,000/yr (section 5).

---

## 2. Competitor table

Fit column key, comparing each product with Stratlas: **V** = video fused with 3D/map, **3D** = mesh/point cloud, **M** = ortho/street map, **I** = issue management, **AI** = in-app AI agent, **B** = builder pipelines, **P** = offline client package.

| Product                                                                                             | Overlap with Stratlas                                                                                                                                                              | Missing vs Stratlas                                                                                                                                                                                  | Deployment                                                           | Published price                                                                                                                                                                                                                                                     | Source                                                         |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **DJI Terra** (Standard / Flagship)                                                                 | 3D/ortho/LiDAR processing; volumes; offline licence option                                                                                                                         | No video fusion, issue management, AI agent, packages or road/PCI                                                                                                                                    | Desktop (Windows); online or offline licence                         | **Standard:** $1,790/yr online, $2,250/yr offline; $5,080 perpetual online, $5,500 perpetual offline. **Flagship:** $3,640/yr; $10,450 perpetual online, $10,900 perpetual offline. All ex-tax. DJI Store lists only online licences (Standard + Modify $2,780/yr). | [S1] (3P reseller), [S2], [S3] (Standard perpetual $4,800, 3P) |
| **DJI FlightHub 2**                                                                                 | Live video, drone pose, 3D route planning, AI object detection (including an LLM prompt), Analyzer (measurements, reports, change detection), on-prem option                       | Not an offline desktop app; DJI fleet only; no point cloud fusion at 800M scale, PCI or packages                                                                                                     | Cloud, or on-premises server                                         | **Enterprise:** $3,280 per device per year (3 years: $8,860). Business version ≈$1,600/yr (3P). Recharge packages e.g. livestream $259.                                                                                                                             | [S4], [S5], [S6] (3P)                                          |
| **PIX4Dmatic** (now merged with PIX4Dsurvey)                                                        | Photogrammetry/LiDAR processing, DTM, volumes, vectorization; offline licence                                                                                                      | No video fusion, issue management, AI agent or client packages                                                                                                                                       | Desktop; offline licence via hardware-ID .lic file                   | **Annual:** Analyst $2,290, Standard $3,990, Pro $4,990. Monthly also offered; page says "from $125/mo". **Perpetual (OTC):** ≈$14,990 for Standard after 2026-01-05 (up from ≈$5,990).                                                                             | [S7], [S8], [S9] (3P), [S10]                                   |
| **PIX4Dmapper**                                                                                     | Classic photogrammetry                                                                                                                                                             | Same gaps as PIX4Dmatic                                                                                                                                                                              | Desktop                                                              | $332.50/mo monthly; ≈$3,990/yr billed annually (17% saving)                                                                                                                                                                                                         | [S11]                                                          |
| **PIX4Dcloud**                                                                                      | Web viewing, volumes, comparison; unlimited users                                                                                                                                  | Cloud only; no video fusion, issue workflow or offline use                                                                                                                                           | Cloud                                                                | Starter $1,290/yr (500 credits); Pro $4,490/yr (2,500 credits); Enterprise: contact                                                                                                                                                                                 | [S12]                                                          |
| **PIX4Dinspect**                                                                                    | AI-assisted inspection, annotations, asset management                                                                                                                              | Cloud only; no offline use; no video-on-model                                                                                                                                                        | Cloud                                                                | Priced per number of inspections; quote only                                                                                                                                                                                                                        | [S13]                                                          |
| **DroneDeploy**                                                                                     | Cloud mapping, 3D, inspection; AI agents (Progress, Safety, Inspection AI) since late 2025                                                                                         | Cloud only; no offline desktop, client packages or video-on-model fusion                                                                                                                             | Cloud SaaS                                                           | **Flight & Analysis:** $4,188/yr (1 user, 3,000 images/map). Ag Lite $1,908/yr. Advanced and team plans: quote. 14-day trial. 3P lists $329–$499 per seat per month.                                                                                                | [S14], [S15] (3P, 2026-03), [S16]                              |
| **Propeller Aero**                                                                                  | Stockpile/earthworks volumes, cut/fill, survey QA                                                                                                                                  | Cloud; no inspection/issue workflow or video fusion; GCP hardware lock-in                                                                                                                            | Cloud + AeroPoints hardware                                          | No list price. 3P estimate: $5k–10k per site per year plus $10k–21k AeroPoints. AeroPoints processing $999/yr per group.                                                                                                                                            | [S17] (3P estimate, 2026-03), [S18]                            |
| **Esri Site Scan for ArcGIS**                                                                       | Flight, processing, volumes, cut/fill, change over time                                                                                                                            | Cloud; no offline desktop review; no video-on-model                                                                                                                                                  | Cloud (ArcGIS Online/Enterprise)                                     | US: contact sales. UK G-Cloud: Single Access £497/user/yr, Single Operator £4,967/user/yr; image tiers £24,833 (50k images) to £280,608 (1M images) per year.                                                                                                       | [S19], [S20] (UK, 2024-05, pre-2025)                           |
| **ArcGIS Drone2Map**                                                                                | Offline desktop processing of drone imagery to 2D/3D                                                                                                                               | No issue management at scale, video fusion or packaged workflow                                                                                                                                      | Desktop, offline-capable; needs an ArcGIS user type                  | Standard ≈$1,750/yr (Esri store, per search snippet). UK: Standard £2,778/yr, Advanced £6,339/yr.                                                                                                                                                                   | [S21] (3P snippet), [S20] (pre-2025)                           |
| **ArcGIS Pro + Image Analyst** (geospatial / full-motion video)                                     | Geospatial video player with MISB metadata, video footprint on map/scene, feature capture from video; 3D scenes and point clouds; AI assistants in beta, Esri moving to agentic AI | Multi-product cost and GIS skills needed; no packaged inspection/issue workflow or volumetrics/PCI templates; packages (.mspk/.slpk) open in free ArcGIS Earth but are not an inspection deliverable | Desktop (Windows only) + ArcGIS licensing                            | Image Analyst $650/yr plus an ArcGIS Pro user type. 3P: Creator ≈$700–865/yr, Professional ≈$3,000/yr, Professional Plus ≈$3,800–4,150/yr.                                                                                                                          | [S22], [S23], [S24] (3P), [S25], [S26], [S27]                  |
| **ArcGIS Reality** (Studio / for Pro)                                                               | Large-area reality mapping                                                                                                                                                         | Processing only                                                                                                                                                                                      | Desktop + server                                                     | Not published. A 3P snippet cites ≈$20,200/yr or $40,400 perpetual; unverified.                                                                                                                                                                                     | [S28] (unverified)                                             |
| **Bentley iTwin Capture** (formerly ContextCapture)                                                 | Reality meshes, Gaussian splats, point-cloud management, AI detection; free "Modeler Flex" companion                                                                               | No video-on-model review, issue workflow or client player package                                                                                                                                    | Desktop + cloud services                                             | WorkSuite from $5,000/yr; Engine from $4,000/yr (12-month Virtuoso licence incl. 2 training "Keys"). 3P: Modeler ≈$4,175 one-time.                                                                                                                                  | [S29], [S30] (3P)                                              |
| **Bentley iTwin platform / iTwin IoT**                                                              | Digital-twin platform, IoT and sensor data                                                                                                                                         | Developer platform, not an end-user inspection app                                                                                                                                                   | Cloud                                                                | Standard $199/mo (200 credits); Premium $499/mo (500 credits); extra credits $1.20                                                                                                                                                                                  | [S31] (per search snippet)                                     |
| **Bentley OpenRoads Designer**                                                                      | Road design and chainage (adjacent to road surveys)                                                                                                                                | Design CAD; no condition survey, video or inspection                                                                                                                                                 | Desktop                                                              | ≈$7,226/yr Virtuoso (3P also lists $6,057). Bentley Copilot coming in early 2026.                                                                                                                                                                                   | [S32], [S33]                                                   |
| **Agisoft Metashape Pro**                                                                           | Photogrammetry; video frame import; Python scripting                                                                                                                               | No review, issue, video-fusion or package layer                                                                                                                                                      | Desktop (Win/Mac/Linux), offline                                     | **$3,499 perpetual** (node-locked); Standard $179; floating ≈$6,998 (3P). Includes 12 months support; updates within major version 2.x.                                                                                                                             | [S34], [S35] (3P), [S36] (3P)                                  |
| **Cintoo**                                                                                          | Cloud point cloud / BIM / 360 streaming, issue tagging; unlimited users                                                                                                            | Cloud; no drone video fusion; no offline player                                                                                                                                                      | Cloud                                                                | 360 Edition from $4,100/yr; Twin Edition $15,000/yr (marketplace snippets). UK £1,347/licence/yr. 30-day trial.                                                                                                                                                     | [S37] (3P), [S38]                                              |
| **NIRA**                                                                                            | Web 3D/point cloud/ortho viewer, annotations, compare, volumes, branding                                                                                                           | Cloud; no video fusion, AI agent, pipelines or offline use (on-prem only for 200+ employee firms)                                                                                                    | Cloud (self-host for Enterprise)                                     | Individual $19–24/mo; Professional $119–149/mo (the lower figure is the annual rate); Enterprise: contact. 15-day trial.                                                                                                                                            | [S39]                                                          |
| **Flyability Inspector 5** (Elios 3)                                                                | Frame-by-frame video review, 3D point cloud, POIs/defects, reports, comparison over time                                                                                           | Elios 3 data only; no ortho/street maps, AI agent, builder pipelines (volumes/PCI) or encrypted client package                                                                                       | Desktop (included with the drone) + Inspector Online (cloud premium) | Desktop: bundled with the drone. Premium Software Plan: quote.                                                                                                                                                                                                      | [S40], [S41]                                                   |
| **Scopito**                                                                                         | Cloud inspection, AI fault detection, PDF reports                                                                                                                                  | Cloud; 2D image-centric; no 3D/video fusion or offline use                                                                                                                                           | Cloud                                                                | Per asset: power line €16 (distribution) / €40 (transmission); wind turbine €160; building €50; solar €20                                                                                                                                                           | [S42] (3P)                                                     |
| **Optelos**                                                                                         | Visual data management, AI analytics, 2D/3D viewers, inspections                                                                                                                   | Cloud; no offline desktop or package                                                                                                                                                                 | Cloud                                                                | 3P: "from $1,000/month". Vendor and Capterra: quote only.                                                                                                                                                                                                           | [S43] (3P), [S44]                                              |
| **Cyberhawk iHawk / Visualive**                                                                     | Visual asset management, digital twin, AI image inspection (O&G, utilities)                                                                                                        | Cloud SaaS tied to Cyberhawk services; no offline package                                                                                                                                            | Cloud                                                                | Not published. Ondas announced its acquisition of Cyberhawk on 2026-06-18.                                                                                                                                                                                          | [S45], [S46]                                                   |
| **Hammer Missions**                                                                                 | Flight planning, 2D/3D processing, reports, comparison; AI on Enterprise                                                                                                           | Cloud; no offline use or video fusion                                                                                                                                                                | Cloud                                                                | Pricing page shows "Request pricing". 3P snippet: Ascend Pro $79/mo annual ($99 monthly); Cruise $225/mo annual ($249 monthly).                                                                                                                                     | [S47], [S48] (3P)                                              |
| **Kespry (Firmatek)**                                                                               | Aggregates/stockpile inventory, multi-site                                                                                                                                         | Cloud + services; no inspection/video/offline                                                                                                                                                        | Cloud                                                                | Quote only                                                                                                                                                                                                                                                          | [S49]                                                          |
| **Stockpile Reports**                                                                               | Stockpile volumes (iPhone/drone), tonnage reports                                                                                                                                  | Single-purpose                                                                                                                                                                                       | Cloud + app                                                          | Free; Professional $20/mo or $200/yr; Business $1,000–5,000/yr (10–50 piles); 200+ piles: contact                                                                                                                                                                   | [S50]                                                          |
| **Vaisala RoadAI** (now under Xweather)                                                             | Road defect detection, signs/markings, video archive, condition data per 10/100 m                                                                                                  | Cloud; vehicle-video only; no drone 3D/ortho fusion or offline use                                                                                                                                   | Cloud                                                                | Not on the vendor page. 3P snippet: small networks (<200 mi) $9,500/yr.                                                                                                                                                                                             | [S51], [S52] (3P)                                              |
| **Vialytics / Better Roads (RoadBotics)**                                                           | Road condition AI, PCI-style ratings                                                                                                                                               | Cloud; smartphone video                                                                                                                                                                              | Cloud                                                                | Vialytics: quote. RoadBotics was ≈$80/mile (3P); platform being sunset.                                                                                                                                                                                             | [S53], [S54] (3P)                                              |
| **Remote GeoSystems LineVision**                                                                    | Geotagged video played in sync with map, on the desktop, offline: the closest "video + map" desktop tool                                                                           | No 3D mesh/point cloud fusion, issue workflow, AI or pipelines                                                                                                                                       | Desktop, offline; also an Online version                             | **Desktop:** Basic $29/mo, $299/yr, $725 perpetual; Pro $59/mo, $599/yr, $1,550 perpetual; Ultimate $119/mo, $1,199/yr, $3,000 perpetual. **Online:** $129–649/mo. 7-day trial.                                                                                     | [S55], [S56]                                                   |
| **Hexagon HxDR Reality Cloud Studio**                                                               | Cloud point cloud registration, meshing, sharing                                                                                                                                   | Cloud; no video, inspection or offline use                                                                                                                                                           | Cloud                                                                | $20 / $139 / $430 per month (2023 launch tiers; token-based processing)                                                                                                                                                                                             | [S57] (pre-2025)                                               |
| **Leica TruView / JetStream**                                                                       | Free point cloud viewer; "TruView Portable" runs from a USB stick with no network, which is a precedent for a free offline player                                                  | Viewer for Leica LGS only; no drone video, map or issue workflow                                                                                                                                     | Desktop, offline                                                     | TruView: free; authoring via Cyclone (quote)                                                                                                                                                                                                                        | [S58]                                                          |
| **Skyline TerraExplorer**                                                                           | Desktop 3D globe; video projected on terrain or as a billboard; meshes and point clouds; floating licences                                                                         | No inspection/issue workflow, AI agent or drone pipelines                                                                                                                                            | Desktop + server                                                     | Not published (only unofficial download sites list prices)                                                                                                                                                                                                          | [S59]                                                          |
| **Trimble Business Center** (Aerial Photogrammetry) / **Trimble Stratus**                           | Survey-grade processing (TBC); cloud aggregates/earthworks (Stratus)                                                                                                               | No inspection, video or package                                                                                                                                                                      | TBC: desktop; Stratus: cloud                                         | TBC photogrammetry module ≈$4,690/yr or ≈$6,000 perpetual (3P); base TBC ≈$1,025/yr (3P). Stratus: quote.                                                                                                                                                           | [S61] (3P), [S62]                                              |
| **Global Mapper Pro**                                                                               | Offline desktop GIS, LiDAR/point cloud, volumes                                                                                                                                    | No video fusion, issue workflow or packages                                                                                                                                                          | Desktop, offline                                                     | $1,745 perpetual (node-locked, 1 yr M&S); floating $2,625 (3P reseller)                                                                                                                                                                                             | [S63] (3P)                                                     |
| **Unleash live**                                                                                    | Video AI (live and recorded), custom defect models, 3D; **fully offline on-prem option**                                                                                           | Server platform, not a desktop review app; no client package                                                                                                                                         | SaaS, VPC, edge or on-prem                                           | Pricing page: briefing only. 3P: Live Stream $149–499/mo.                                                                                                                                                                                                           | [S64], [S65] (3P)                                              |
| **Sterblue**                                                                                        | Grid and wind turbine inspection SaaS, AI defects                                                                                                                                  | Cloud                                                                                                                                                                                                | Cloud                                                                | Site unreachable on 2026-10-05; snippet prices ($0–29/mo) look unreliable and are excluded                                                                                                                                                                          | [S66]                                                          |
| **Abyss Solutions (Abyss Fabric)**                                                                  | AI corrosion mapping, digital inspection for offshore O&G                                                                                                                          | Bundled with robotic inspection services; cloud                                                                                                                                                      | Cloud + services                                                     | Not published                                                                                                                                                                                                                                                       | [S67]                                                          |
| **Avvir**                                                                                           | Scan-vs-BIM progress and deviation                                                                                                                                                 | Construction BIM only; cloud                                                                                                                                                                         | Cloud                                                                | Custom, per project or enterprise (3P)                                                                                                                                                                                                                              | [S68] (3P)                                                     |
| **GCC regional players** (Terra Drone Arabia / CCS, FEDS (Aerodyne-backed), AIN UAE, THE FUTURE 3D) | Drone survey, inspection and digital-twin **services**                                                                                                                             | Mainly service companies using DroneDeploy, Pix4D, DJI Terra, NavVis etc.; no regional desktop product found                                                                                         | Services                                                             | Projects: 3D scanning $3k–12k; large drone surveys $10k–50k+ (THE FUTURE 3D)                                                                                                                                                                                        | [S69], [S70], [S71], [S72]                                     |

**Takeaway from the table.** The two building blocks Stratlas would combine exist only as separate products:

- **Video + map fusion** exists as niche desktop tools: LineVision, Skyline, ArcGIS geospatial video.
- **Inspection issue management** exists almost only as cloud SaaS: Scopito, Optelos, iHawk, PIX4Dinspect, DroneDeploy Inspection AI.

Free offline viewers exist (Leica TruView Portable, ArcGIS Earth, Bentley Modeler Flex). None combines inspection findings, video and maps in a single encrypted file.

---

## 3. Closest competitors (direct answer)

**Does any single product do the full combination?** **No.** We found nothing that is all of the following at once:

- an offline desktop app on Windows and macOS;
- fusing video, 3D, point clouds and maps;
- with an issue manager for thousands of findings;
- an in-app AI agent;
- bundled build pipelines (volumetrics, PCI, inspection photos);
- and single-file encrypted client packages with a free player.

The closest three:

1. **Flyability Inspector 5 (with Elios 3)** [S40][S41]
   - _Has:_ desktop review that links video to a 3D point cloud, POIs and defect documentation, reports, and comparison over time (cloud premium).
   - _Lacks:_
     - It only handles Elios 3 confined-space data: no ortho, street map or outdoor photogrammetry fusion.
     - No volumetrics or road pipelines.
     - No AI agent.
     - No encrypted package for clients; sharing goes through Inspector Online.
2. **Esri stack: ArcGIS Pro + Image Analyst + Drone2Map / ArcGIS Reality + AI assistants** [S22–S27]
   - _Has:_ geospatial video synchronized to map/scene, 3D and point clouds, offline Drone2Map processing, AI assistant (beta) moving to agents, and free ArcGIS Earth for offline .mspk/.slpk packages.
   - _Lacks:_
     - A ready inspection/issue workflow with evidence photos and severity: it must be built with Field Maps, Survey123 or cloud tools.
     - Video projected onto a mesh with drone-eye view in one workflow.
     - Stockpile and PCI templates.
     - macOS support (ArcGIS Pro is Windows only).
   - It needs GIS expertise and several licences: Pro user type + $650 extension + Drone2Map/Reality.
3. **DJI FlightHub 2 (on-prem) + DJI Terra** [S1][S4][S5]
   - _Has:_ live and recorded video with drone pose, AI detection including an LLM prompt, Analyzer (measurements, reports, change detection), Terra 3D/ortho/LiDAR with offline licences, and an on-prem server option.
   - _Lacks:_
     - An offline desktop review app (FlightHub is a server/web platform).
     - Support for non-DJI data.
     - Large-scale issue management with house-style PDFs.
     - Road PCI and chainage.
     - A client deliverable package and player.

Honourable mentions:

- **Skyline TerraExplorer**: desktop video projection on 3D, but no inspection workflow or AI.
- **Unleash live**: video AI with a fully offline on-prem option, but no desktop or package.
- **LineVision**: offline desktop video + map, but no 3D.

---

## 4. Pricing models in the market

| Model                                                    | Who uses it                                                                        | Typical band (USD)                                                                                                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Per seat / named user, annual** (monthly at a premium) | Pix4D, DroneDeploy, NIRA, Hammer, Esri, Bentley                                    | Viewers $230–1,800/yr. Desktop processors $1.8k–5k/yr. Cloud platforms $1.3k–4.5k/yr.                                                                               |
| **Per device / machine**                                 | DJI Terra (1 device), FlightHub 2 (per drone)                                      | $1.8k–3.6k/yr                                                                                                                                                       |
| **Perpetual + maintenance**                              | Agisoft, DJI Terra, Pix4D OTC, LineVision, Global Mapper, TBC                      | $725–14,990 one-off. Perpetual is about **2.4–3.8× the annual price**: DJI Terra Standard 2.8×, Flagship 2.9×, PIX4Dmatic Standard ≈3.8× (3P), LineVision 2.4–2.6×. |
| **Per site / project**                                   | Propeller (est. $5–10k per site per year), Optelos project pricing, Avvir          | $5k–10k per site per year                                                                                                                                           |
| **Per asset / inspection**                               | Scopito (€16–160 per asset), PIX4Dinspect                                          | €16–160 per asset                                                                                                                                                   |
| **Credits / tokens** (processing)                        | PIX4Dcloud (500–2,500 credits included), Bentley iTwin ($1.20/credit), HxDR tokens | Bundled with the plan, plus top-ups                                                                                                                                 |
| **Per network length**                                   | RoadAI (≈$9.5k/yr for small networks, 3P), RoadBotics (≈$80/mile, 3P)              | ≈$9.5k/yr                                                                                                                                                           |
| **Enterprise "contact us"**                              | All major vendors (SSO, on-prem, API, white-label)                                 | Quote only                                                                                                                                                          |

**Annual discounts.** Pix4D annual billing saves ≈17% versus monthly [S11][S12], the same as "2 months free". NIRA's annual rate is ≈20% below monthly [S39]. LineVision annual ≈ 10× monthly [S55]. Multi-year (3-year) terms are offered by Pix4D [S8] and FlightHub 2 (3 years $8,860 vs 3 × $3,280 = $9,840, ≈10% off) [S4].

**How desktop/offline vendors handle licensing:**

- **Pix4D** [S10]
  - Normal licences check in online.
  - A separate _offline licence_ is issued as a .lic file bound to the machine's Hardware ID.
  - Offline OTC (perpetual) licences are version-locked with no upgrades.
  - Offline subscriptions run 3- or 5-year terms with upgrades.
  - Trials cannot be used offline.
  - Since 2026-01-05, perpetual prices rose sharply (≈$14,990, 3P) to push buyers to subscriptions.
- **DJI Terra** [S1][S2]
  - 1-device licences, online or offline activation.
  - Offline costs ≈$420–460 more (≈5–25% premium).
  - Perpetual ≈2.85× the annual price.
  - DJI's own store sells online licences only; offline licences go through dealers.
- **Agisoft** [S34][S35]
  - Perpetual only (node-locked $3,499 Pro), with 12 months support and free updates within the major version.
  - Floating licences cost ≈2× node-locked.
  - Wire transfer accepted. No subscription for desktop.
- **Bentley** [S29]: 12-month "Virtuoso" subscriptions that bundle training credits.
- **Esri** [S22][S23]: annual user types, plus extensions at $650/yr each.

---

## 5. Recommendation for Stratlas

### Design principles

- **Price the review layer below the processors.** Most buyers already pay for Pix4D, DJI Terra or Metashape ($1.8k–5k/yr), because Stratlas **imports** photogrammetry outputs rather than replacing that step. The Builder tier should therefore sit at or below a processor seat. The Pro reviewer tier should sit in the viewer band ($100–150/mo).
- **The free player is the growth loop.** Every package a Builder sends puts Stratlas in front of the client organization. Precedents are Leica TruView Portable, ArcGIS Earth and Bentley Modeler Flex. Keep the player free, unlimited, offline and unbranded-optional (white-label on Enterprise only).
- **No processing credits.** Pipelines run locally on the customer's machine, unlike PIX4Dcloud credits, iTwin credits at $1.20, or HxDR tokens. Say this loudly: "No credits, no per-image caps, no per-site fees."
- **AI is BYOK, so there is no AI margin to protect.** Do not charge for AI chat. Charge only for _curated detection model packs_ and optional managed keys.
- **Licensing mechanics** copied from what customers already accept:
  - **Activation:** online, plus an offline .lic file bound to the machine (as Pix4D and DJI do).
  - **Seats:** 2 machine activations per named seat.
  - **Grace period:** 30 days at term end.
  - **Floating licences:** Team tier only, at about 2× the named-seat price (the Agisoft ratio).

### Option A: Conservative (recommended launch list)

| Tier                  | What's included                                                                                                                                                                  | Monthly | Annual USD       | Annual KWD (@3.24) | Justification                                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Player**            | Opens .aio packages read-only, offline, Win/Mac                                                                                                                                  | Free    | Free             | Free               | Matches free-viewer precedents [S58][S29][S26]                                                                                                                        |
| **Pro Reviewer**      | Open/edit projects, issues, evidence boxes, compare dates, house-style PDF, BYOK AI agent, offline maps; **no pipelines or package export**                                      | $79     | $790             | KWD 245            | Below NIRA Pro ($119–149/mo) [S39]; between LineVision Pro ($599/yr) and Ultimate ($1,199/yr) [S55]; about Hammer Ascend Pro ($79/mo) [S48]                           |
| **Builder**           | Everything + Python pipelines (photogrammetry import, inspection photos, two-date stockpile cut/fill, road PCI/chainage), AI defect detection with review, encrypted .aio export | $299    | $2,990           | KWD 925            | Below PIX4Dmatic Standard ($3,990) [S7], DJI Terra Flagship ($3,640) [S1], DroneDeploy ($4,188) [S14], iTwin Capture ($4–5k) [S29]; above DJI Terra Standard ($1,790) |
| **Team / Enterprise** | From 5 seats (e.g. 2 Builder + 3 Pro); floating licence server; air-gapped licences; white-label player; priority support; 1 onboarding day                                      | n/a     | **from $12,000** | from KWD 3,700     | Around 1–2 Propeller sites [S17], Cintoo 360–Twin ($4.1k–15k) [S37], RoadAI small-network ($9.5k, 3P) [S52]                                                           |

### Option B: Aggressive (value-based; use once there are 3+ reference customers)

| Tier              | Monthly | Annual USD       | Annual KWD     | Justification                                                                                                                                                          |
| ----------------- | ------- | ---------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Player            | Free    | Free             | Free           | Same as Option A                                                                                                                                                       |
| Pro Reviewer      | $149    | $1,490           | KWD 460        | At NIRA Pro's top rate; still about 1/3 of a processing seat                                                                                                           |
| Builder           | $449    | $4,490           | KWD 1,390      | At PIX4Dcloud Pro ($4,490) [S12] and below PIX4Dmatic Pro ($4,990) [S7]. One Builder seat replaces 1 Propeller site plus a stockpile tool plus a road-AI subscription. |
| Team / Enterprise | n/a     | **from $24,000** | from KWD 7,400 | Around FlightHub 2 Enterprise ×7 devices, or 2–4 Propeller sites (inferred)                                                                                            |

### Common terms (both options)

- **Annual discount:** annual price = 10× monthly, i.e. 2 months free (≈17%), matching Pix4D [S11]. 3-year prepay: an extra 10% off (FlightHub 2 precedent [S4]).
- **Perpetual option** (GCC government and enterprise ask for it):
  - Price: Builder perpetual = **3× annual** (A: $8,970 ≈ KWD 2,770; B: $13,470 ≈ KWD 4,160). Pro perpetual = 3× annual. This sits in the 2.4–3.8× market range [S1][S8][S55].
  - Includes 12 months maintenance. After that, **maintenance & updates at 20% of perpetual per year** (inferred industry norm, not a sourced figure).
  - If maintenance lapses, the licence stays on the last version, as with Pix4D OTC offline and Agisoft [S10][S35].
- **Trial:**
  - 14-day full Builder trial, online activation. Comparables: DroneDeploy 14 days, Pix4D/NIRA 15 days, LineVision 7 days, Cintoo 30 days [S14][S7][S39][S55][S38].
  - For enterprise or air-gapped pilots, a **paid 60-day POC** (e.g. $2,500, credited against the first-year licence; inferred) with an offline licence file. Pix4D does not allow offline trials [S10].
- **Add-ons:**
  - _Processing:_ none. Pipelines are local and unlimited; this is a differentiator.
  - _AI:_ BYOK included at no charge. Optional **Detection model packs** (corrosion/coating, road distress, stockpile segmentation): $1,000–2,500 per pack per year (inferred; Scopito charges €1/image for analysis [S42]). Optional **managed AI key** for organizations that cannot hold API keys: provider cost +20%, invoiced quarterly (inferred).
  - _Map packs:_ GCC country street/base map packs included. Other regions $99/yr each, or unlimited on Team. Respect OSM ODbL attribution.
  - _Onboarding / services:_
    - Remote onboarding (2 × half-day): $1,500 (KWD 465).
    - On-site GCC day: $2,500 (KWD 770).
    - House-style report template set-up: $2,000–4,000 one-off.
    - Bentley bundles training Keys into Virtuoso, so offer "1 onboarding day included" on Team [S29].
- **Seats / machines:** named user, 2 activations. Floating seat = 2× named (Team only). Player: unlimited installs.

### GCC enterprise and government procurement norms

- **Kuwait** [S73]:
  - Government purchases above **KD 75,000** go through the Central Agency for Public Tenders (CAPT).
  - Foreign firms need a local agent for execution. Kuwaiti businesses get a **10% price preference**, and the law gives a 15% preference to domestic/GCC-produced items.
  - Bid and performance bonds are typically **5–10%**, and firms often add 10–15% to cover that risk.
  - **Synapse being Kuwaiti is a real advantage here.** Quote in KWD, annual licence plus a perpetual alternative.
  - **No VAT in Kuwait;** the government plan rules it out before 2028 [S74].
- **Saudi Arabia (KSA):**
  - Local content rules give national products a **10% price preference** (foreign bids are evaluated as if 10% higher), and the LCGPA mandatory list must be checked [S75].
  - **Withholding tax of 15%** applies on software royalties paid to non-residents (5% for technical services) [S76], and 15% VAT is reverse-charged for B2B [S77].
  - Action: quote KSA deals either "net of WHT" with gross-up, or through a KSA reseller.
- **UAE:** 5% VAT, reverse-charged by UAE business buyers on software from foreign suppliers [S78].
- **Typical deal shape (inferred):**
  - Annual licence invoiced up front in local currency.
  - Government payment terms of 60–90+ days.
  - Perpetual + 20% annual maintenance often preferred by government buyers because it is capex.
  - Paid POC before the tender.
  - Arabic quotation documents and local agent/reseller margins of 15–30% (inferred) must fit inside the list price. Price the Team tier so a reseller margin still leaves a profit.

---

## 6. Positioning

### Clearly differentiated

- **Offline / air-gapped by design.**
  - The video, model, point cloud, ortho and street maps all run locally.
  - Encrypted single-file deliverables open in a free offline player.
  - Cloud-first incumbents (DroneDeploy, Propeller, PIX4Dcloud, Scopito, Optelos, iHawk, Cintoo, NIRA) cannot serve sites where data may not leave the premises without on-prem deals for 200+ employee firms (NIRA) or server installs (FlightHub, Unleash live).
- **Video projected on the model with drone-eye view and telemetry trace.** Only niche tools do part of this: LineVision (2D map only), Skyline, Esri geospatial video and Flyability (Elios only).
- **Inspection deliverable plus player.** None of the free viewers (TruView, ArcGIS Earth, Modeler Flex) carries findings, evidence photos, severity and reports in one encrypted file.
- **One tool covers several GCC verticals:** inspection, stockpiles, roads (PCI/chainage) and multi-date comparison. Otherwise a buyer would need roughly three subscriptions: Propeller/Stockpile Reports, RoadAI/Vialytics and Scopito/Optelos.
- **Local vendor:** Kuwaiti price preference, KWD invoicing, on-site support, no WHT or reverse-charge friction in Kuwait.

### Head-on with cheap or bundled incumbents (risks)

- **Stockpile volumes:**
  - Stockpile Reports Professional costs $200/yr [S50].
  - PIX4Dcloud and DroneDeploy include volumes.
  - DJI Terra already computes volumes.
  - Do not lead with volumes alone.
- **Basic 3D viewing / sharing:** NIRA at $19–149/mo, PIX4Dcloud Starter with unlimited users, ArcGIS Earth (free).
- **DJI ecosystem bundling:** FlightHub 2 has AI detection with an LLM prompt and an Analyzer, and is sold alongside drones and Docks. Flyability Inspector is free with the Elios 3.
- **AI agents are becoming table stakes:**
  - DroneDeploy launched Progress, Safety and Inspection AI agents [S79].
  - Esri ships AI assistants and is moving to agentic AI [S80].
  - Bentley Copilot arrives in OpenRoads in 2026 [S33].
  - "AI agent" alone will not differentiate for long; "AI that works on your offline project and drives the 3D camera" can.
- **Offline vs AI contradiction.** The BYOK agent calls cloud LLM APIs.
  - For air-gapped or government sites, ship an "AI off / local model" mode and state clearly which data leaves the machine.
  - Otherwise the offline claim is weakened.
- **Builder needs a processor.** Customers still need Pix4D, Terra or Metashape for photogrammetry, so Builder must stay at or below a processor seat. Aggressive pricing ($4,490) needs reference cases.
- **Vendor-size risk for buyers.** Mitigate with source-code escrow, perpetual licences and the open/exportable formats Stratlas already uses.

### Landing-page message (draft)

- **Headline:** _Drone video, 3D and maps in one offline workspace, delivered to your client as one file._
- **Sub-headline:** _Review thousands of findings on the model, ask the AI to find them, and ship an encrypted package anyone can open with the free Stratlas Player. No cloud, no credits, no per-site fees._
- **Proof points:**
  1. Runs fully offline on Windows and macOS.
  2. Projects drone video on the 3D model and streams up to ~800M points.
  3. Stockpiles, road PCI and inspection photos are built in.
  4. Your own AI key, or AI switched off for air-gapped sites.
  5. Kuwait-based support, KWD invoicing, annual or perpetual licences.
- **CTA:** "Download the free Player", "Start 14-day Builder trial", "Book a GCC on-site pilot".
- **Avoid:** claiming photogrammetry processing (Stratlas imports it), and claiming "fully offline AI" unless local-model mode ships.

---

## Sources

All seen 2026-10-05. Notes in brackets.

- [S1] https://www.djiterrasoftware.com/buy/ (3P DJI Terra reseller, USD ex-tax)
- [S2] https://store.dji.com/product/dji-terra-subscription
- [S3] https://www.dronenerds.com/collections/parts-software/products/dji-terra-standard-permanent (3P)
- [S4] https://store.dji.com/product/dji-flighthub-2-enterprise-version-1-year-1-device
- [S5] https://store.dji.com/product/dji-flighthub-2
- [S6] https://dronebundle.com/blog/dji-flighthub (3P, Business ≈$1,600/yr, from search snippet)
- [S7] https://www.pix4d.com/pricing/pix4dmatic/
- [S8] https://www.pix4d.com/pricing/
- [S9] https://checkthat.ai/brands/pix4d/pricing (3P, perpetual ≈$14,990 after 2026-01-05)
- [S10] https://support.pix4d.com/hc/offline-license-pix4dmatic and https://support.pix4d.com/hc/pix4dmatic-and-pix4dsurvey-unification
- [S11] https://www.pix4d.com/pricing/pix4dmapper/
- [S12] https://www.pix4d.com/pricing/pix4dcloud/
- [S13] https://support.pix4d.com/hc/en-us/articles/360040384471-Pix4Dinspect-FAQ
- [S14] https://www.dronedeploy.com/pricing
- [S15] https://www.skyebrowse.com/news/posts/dronedeploy-review (3P, dated 2026-03-13; competitor-authored)
- [S16] https://www.dronedeploy.com/blog/dronedeploy-unveils-agentic-ai-and-robotics-products-at-horizons-2025
- [S17] https://www.skyebrowse.com/news/posts/skyebrowse-vs-propeller-aero (3P estimate, 2026-03-13; competitor-authored)
- [S18] https://help.propelleraero.com/hc/en-us/articles/19383553319703-Annual-AeroPoints-Processing-Subscription
- [S19] https://www.esri.com/en-us/arcgis/products/arcgis-reality/products/site-scan-for-arcgis
- [S20] https://assets.applytosupply.digitalmarketplace.service.gov.uk/g-cloud-14/documents/579509/766668459761814-pricing-document-2024-05-02-1136.pdf (Esri UK G-Cloud, 2024-05, pre-2025)
- [S21] https://www.esri.com/en-us/arcgis/products/arcgis-reality/products/arcgis-drone2map/buy (price from search snippet; page fetch showed no price, so treat as 3P)
- [S22] https://www.esri.com/en-us/store/overview (Image Analyst $650/yr)
- [S23] https://www.esri.com/en-us/arcgis/products/arcgis-image/options/arcgis-image-analyst
- [S24] https://www.trustradius.com/products/arcgis/pricing (3P user-type estimates)
- [S25] https://doc.esri.com/en/arcgis-pro/latest/help/analysis/image-analyst/the-full-motion-video-player.html
- [S26] https://doc.arcgis.com/en/arcgis-earth/use/add-data.htm
- [S27] https://www.esri.com/arcgis-blog/products/arcgis-online/geoai/whats-new-in-ai-assistants-june-2026
- [S28] https://doc.esri.com/en/arcgis-reality-studio/latest/help/about-licensing.html (licensing; price unverified)
- [S29] https://www.bentley.com/products/itwin-capture-worksuite
- [S30] https://www.sota2.com/products/bentley-systems-itwin-capture-modeler (3P)
- [S31] https://developer.bentley.com/pricing/ (from search snippet)
- [S32] https://en.virtuosity.com/software/openroads-designer (from search snippet)
- [S33] https://www.geoweeknews.com/articles/bentley-systems-announces-new-ai-programs-and-capabilities-at-its-year-in-infrastructure-event
- [S34] https://www.agisoft.com/buy/online-store/
- [S35] https://www.agisoftmetashape.com/is-metashape-a-one-time-purchase-understanding-agisofts-licensing-model/ (3P info site)
- [S36] https://drone-parts-center.com/en/product/agisoft-metashape-professional-floating-license/ (3P)
- [S37] https://marketplace.microsoft.com/en-us/product/web-apps/cintoo1668184635990.cintoocloud?tab=PlansAndPrice (snippet; page returned 403)
- [S38] https://www.applytosupply.digitalmarketplace.service.gov.uk/g-cloud/services/419773349588614
- [S39] https://nira.app/pricing/
- [S40] https://www.flyability.com/inspector
- [S41] https://knowledge.flyability.com/software-and-cloud/inspector/inspector-5
- [S42] https://softwarefinder.com/analytics-software/scopito (3P, undated)
- [S43] https://sourceforge.net/software/product/Optelos/ (3P snippet)
- [S44] https://www.capterra.com/p/241392/Optelos/pricing/
- [S45] https://dronedj.com/2024/10/09/cyberhawk-ai-drone-inspection-visualive/ (2024, pre-2025)
- [S46] https://www.ondas.com/post/ondas-to-acquire-cyberhawk-expanding-into-critical-infrastructure-intelligence-through-software-d
- [S47] https://www.hammermissions.com/pricing
- [S48] Search snippet of hammermissions.com/pricing (3P; prices not visible on the fetched page)
- [S49] https://firmatek.com/kespry-cloud/
- [S50] https://www.stockpilereports.com/pricing.html
- [S51] https://www.xweather.com/products/roadai
- [S52] Search snippet citing Vaisala RoadAI small-network plan (3P; vendor page shows no price)
- [S53] https://www.vialytics.com/packages-and-pricing
- [S54] https://www.softwaresuggest.com/roadbotics (3P)
- [S55] https://remotegeo.com/software/buy/ and https://www.esri.com/en-us/arcgis-marketplace/listing/products/0b820fa659714bacbddce31da8163ac1
- [S56] https://remotegeo.com/software/linevision-desktop/
- [S57] https://www.geoweeknews.com/news/hexagon-reality-cloud-studio-capture-data-point-cloud-registration-meshing (2023, pre-2025)
- [S58] https://rcdocs.leica-geosystems.com/truview/latest/tv-leica-truview-introduction
- [S59] https://www.skylinesoft.com/ and https://support.skylinesoft.com/hc/en-us/articles/360014199979-TerraExplorer-License-Options
- [S60] https://www.xe.com/en-us/currencyconverter/convert/?Amount=1&From=KWD&To=USD and https://www.google.com/finance/quote/KWD-USD (rate 3.237–3.240 on 2026-10-04, from search snippets)
- [S61] https://allterracentral.com/products/tbc-module-aerial-photogrammetry-modulesubscription (3P)
- [S62] https://sitechgulf.com/our-solutions/geospatial-site-positioning-systems/drones/trimble-stratus/
- [S63] https://3dmappingtools.com/products/global-mapper-pro-1-year-updates (3P)
- [S64] https://unleashlive.com/pricing
- [S65] https://www.g2.com/products/unleash-live-unleash-live/reviews (3P snippet)
- [S66] https://sterblue.com/ (connection refused 2026-10-05)
- [S67] https://abysssolutions.co/case-studies/capturing-data-visualizing-insights-the-future/
- [S68] https://www.thefuture3d.com/software/avvir/ (3P)
- [S69] https://terra-drone.com.sa/
- [S70] https://www.feds.group/about
- [S71] https://ainuae.ae/about-us/
- [S72] https://www.thefuture3d.com/locations/middle-east/
- [S73] https://trade.gov/country-commercial-guides/kuwait-selling-public-sector (dated 2026-04-23)
- [S74] https://www.vatcalc.com/kuwait/kuwait-election-means-vat-implementation-unlikely-soon/ and https://www.taxinme.com/guides/kuwait.php
- [S75] https://www.clydeco.com/en/insights/2026/09/local-content-in-saudi (dated 2026-09-01)
- [S76] https://taxsummaries.pwc.com/saudi-arabia/corporate/withholding-taxes and https://www.dlapiper.com/en/insights/publications/gulf-tax-insights/2024/gulf-tax-insights-february-2024/taxation-of-software-payments-in-saudi-arabia (2024, pre-2025)
- [S77] https://zatca.gov.sa/en/MediaCenter/Publications/Documents/VAT%20Circular%20-%20RCM-EN.pdf (2023, pre-2025)
- [S78] https://mercuriusteam.com/reverse-charge-mechanism-uae-vat-guide/
- [S79] https://www.dronedeploy.com/blog/dronedeploy-unveils-agentic-ai-and-robotics-products-at-horizons-2025
- [S80] https://www.esri.com/about/newsroom/arcnews/the-next-era-of-ai-and-arcgis
