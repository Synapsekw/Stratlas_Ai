# Thermal analysis: find hot spots on equipment and report them (design)

Draft, 21 Oct 2026. Branch `feat/thermal-analysis`. No product code yet. Founder input so far: the job is "finding hot spots on equipment and reporting them", and they said "go ahead" after seeing the thermal bench mockup. The tool scope below (tools 1 to 8 of the mockup in the first version, the thermal map later) and every default marked _my call_ come from the session, not from the founder. The founder has since answered the four open questions (21 Oct); those items are marked _founder_ below.

## Intent and why

Drone thermal photos of electrical and mechanical equipment are taken to find components running hotter than they should (loose terminals, overloaded breakers, failing bearings) and to hand a list of them to the people who fix them. Today Quadrion AI shows a radiometric JPEG as an ordinary picture: no temperatures, no way to mark a hot spot, nothing in a report.

The first data set is a DJI Zenmuse XT2 flight: 54 thermal `_R.JPG` photos (640 x 512, FLIR core, FLIR radiometric data inside) each paired with a 4000 x 3000 visual photo taken at the same moment. Most shots are oblique (gimbal pitch 0 to -45 degrees), so the work is per photo, not a stitched thermal map.

Success: the founder imports a thermal flight, finds the hot equipment in minutes, confirms each hot spot with a temperature they trust, and exports a report the maintenance team can act on: thermal and visual side by side, the temperature, how much hotter than similar equipment, severity and where on the site.

## Goals

1. **Temperatures from the photo.** Every pixel of a supported thermal photo reads as degrees Celsius, using the camera's own calibration and per-photo measurement settings (emissivity, distance, air temperature, relative humidity, reflected temperature).
2. **A Thermal bench** in the workbench, next to Measure, Annotate and Volumes, laid out as in the mockup: a tool rail, the photo with palette and range, the measurement settings line, a hot-spot list and a filmstrip of the dataset's thermal photos.
3. **Readings:** spot, box, line and polygon, each showing max, min and mean live (line also as a profile), placed and kept on the photo.
4. **Look:** palettes (Iron, Rainbow, White hot, Black hot, Arctic at least), auto range plus a draggable min/max range, and an isotherm that colours every pixel above a set temperature.
5. **Visual twin:** switch the view between Thermal, Visual, Blend (opacity slider) and Side by side, using the twin photo found the same way as the Edit position branch finds it.
6. **Find hot spots automatically** on the current photo or the whole dataset: pixels above a set temperature, or a set temperature difference (ΔT) above their surroundings. Each candidate appears in the list to confirm or dismiss. Nothing becomes an issue without a person confirming it.
7. **Severity by ΔT:** each confirmed hot spot gets a severity from its ΔT against a reference (similar equipment the person points at, or the surroundings by default), with thresholds the person can edit.
8. **Hot spots become issues, pins and a report section.** A confirmed hot spot is an issue in `issues.json` (class "Hot spot", a thermal severity model, an image sighting on the thermal photo, the temperatures as measurements). The issue shows as a red pin on the map and in the 3D scene, and in Issues like any other finding. Reports gets a "Thermal hot spots" section and a CSV export.

## Non-goals (first version)

- A thermal orthomosaic or thermal point cloud. ODM can build one, but only from straight-down flights with high overlap, and the first data set is oblique. Later, as its own piece.
- Live video or radiometric video (`.seq`, DJI thermal video).
- Cameras other than the two decoder families below (FLIR route and DJI Thermal SDK route, both in the first version, _founder_). Unsupported thermal photos import as ordinary photos, with a note in the bench saying which camera was not recognised.
- Writing temperatures or settings back into the photo files.
- Automatic equipment recognition ("this is a breaker"). The person names the equipment in the note.

## Anti-goals

- **No wrong temperatures shown as right.** A photo that cannot be decoded reliably shows no temperatures at all, never plausible-looking numbers. (The research found `flyr` returns -38 to 101 °C on XT2 photos because it reads the raw record at the wrong offset.) Every decoder is checked against a known value before it ships.
- **No hot spot in a report that a person did not confirm.** Automatic detection only proposes.
- **No silent loss of a person's work.** Changing measurement settings re-reads the temperatures of existing readings and hot spots and updates their numbers and severity. It never deletes them, and an issue a person edited keeps their title, note and status.
- **Not a second issue system.** Hot spots use the existing issue, sighting, severity model and report machinery, not a parallel store.

## Constraints

- Windows only (macOS parked). Licences do not block a choice. Prefer prebuilt binaries and wheels over building from source.
- Heavy work runs in the pipeline pack as a job, like the other pipelines, so the renderer stays responsive. The pack keeps its `APP_RANGE` discipline: a new pack job needs a pack minor bump.
- The app must work offline. Nothing here calls a web service.
- Public repo: no client, site or tester names in code, docs, fixtures or commit messages. Test fixtures are synthetic or from public sample files with a known licence, never the founder's data set.

## Decided (from the session)

### Decoder stack

| Camera family                                                                                                                                                                                   | Route                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FLIR-core cameras, starting with the DJI Zenmuse XT2 (also XT, XT S, FLIR Vue Pro R, FLIR handhelds where the record is the same)                                                               | Extract the FLIR record from the JPEG's APP1 segments. The XT2's raw thermal image is a 16-bit TIFF inside the record. Apply the Planck formula with the camera constants stored in the file (R1, R2, B, F, O), plus our own atmospheric and emissivity correction (the standard FLIR formula: atmospheric transmission from distance, air temperature and humidity; reflected-temperature compensation). |
| DJI R-JPEG cameras in DJI's Thermal SDK 1.7 list: H20T, H20N, H30T, M30T, Mavic 3T, Matrice 4T, Mavic 2 Enterprise Advanced, and whatever else TSDK 1.7 lists (in the first version, _founder_) | DJI Thermal SDK 1.7 (Windows DLLs, January 2025) through our own thin `ctypes` binding. The SDK applies the measurement settings itself. The XT2 is not on DJI's list and always takes the FLIR route.                                                                                                                                                                                                    |

- **Both routes ship in the first version** (_founder_: all the other DJI thermal cameras will be used too, so the DJI route is not deferred).
- **Never `flyr` for XT2**: proven wrong on the sample. `flirimageextractor` is not used either (its dependencies are heavy and dated).
- **exiftool** extracts the FLIR raw image in the research spike, and its readings looked plausible (one sample photo: -13.2 to 109.1 °C, median 25.0 °C). Whether the shipped decoder calls a bundled exiftool or parses the APP1 record in Python is left to the builder (see below). Either way exiftool is the reference the tests compare against.

### Where decoding runs

In the **pipeline pack** (Python and numpy), as pack jobs called through the existing pipeline RPC:

- `thermal.decode`: for a list of photos and their settings, write one temperature raster per photo (float32 °C, same width and height as the thermal image) into the project's derived-data folder, plus a small JSON with the camera constants, the settings used, min, max and a decoder version. Re-run for those photos when their settings change. A 54-photo XT2 set is small: 640 x 512 x 4 bytes is about 1.3 MB a photo.
- `thermal.hotspots`: run detection over a list of decoded rasters with the given rule and return candidates (photo, pixel box, peak, mean, reference, ΔT).

The renderer reads the rasters directly for hover readings, palettes, range and isotherm: palette mapping is a lookup on the float values, so dragging the range or switching palette is instant and needs no job. The physics lives in one place (Python), not duplicated in TypeScript. _My call._

Import marks a photo as thermal when it finds a FLIR record or a DJI thermal R-JPEG marker, and records which decoder family applies.

### UI (as in the mockup)

- **Thermal bench** in the workbench. Opened from a thermal dataset ("Analyse thermal" on the dataset and on any thermal photo, from the right-click action registry, so it is in the sidebar menu too).
- **Tool rail:** Spot, Box, Line, Polygon, Isotherm, Find hot spots.
- **Stage:** the photo, the palette bar with min and max labels, palette picker, range (auto, or drag the ends), the view switch (Thermal / Visual / Blend / Side by side), the hover temperature under the pointer, and below it one line with the camera, height and settings ("Emissivity 0.95 · Distance 18 m · Air 32 °C · Humidity 60% · edit").
- **Settings editor:** per photo, or "apply to selected photos" or the whole dataset in one step. Defaults: emissivity 0.95, distance = the photo's height above takeoff when known, otherwise 10 m, air temperature 25 °C, humidity 50 %, reflected temperature = air temperature. _My call_; the founder can change the defaults later.
- **Hot-spot list:** each entry shows its code, severity chip, peak temperature, ΔT and its reference, and the note. Sort by ΔT, peak or photo. Confirm, dismiss, edit note, set reference ("compare with": click a spot or box on similar equipment, default the surroundings), and a **Leave out of report** toggle. Confirm creates the issue; confirmed issues are in the report by default, and the toggle removes one. There is no separate "Add to report" step (_my call_).
- **Filmstrip** of the dataset's thermal photos, with a red dot on photos that have confirmed or proposed hot spots.

### Severity by ΔT

A built-in severity model "Thermal ΔT", set by ΔT against the reference. The thresholds, the number of levels and the level names are all editable per project in the bench's settings (_founder_: levels must be adjustable). The three levels below are only defaults, _my call_, following the usual electrical-inspection practice of grading the rise over similar equipment:

| Level    | ΔT over reference |
| -------- | ----------------- |
| Watch    | 4 to 15 °C        |
| Serious  | 16 to 40 °C       |
| Critical | above 40 °C       |

Below 4 °C a candidate is not proposed by detection, though a person can still confirm one by hand (severity Watch). Changing a threshold re-grades the hot spots that are still drafts. Reviewed issues keep their severity when thresholds or settings change; their ΔT and peak update, and a "changed since review" mark shows (_my call_).

### Hot spots as issues, pins and a report section

- Each confirmed hot spot is an `Issue` (`packages/schema/src/annotation.ts`): class "Hot spot" in the class catalogue, the "Thermal ΔT" severity model, `source: 'human'` (or `'agent'` when proposed by detection and then confirmed), and an image sighting (`on: 'image'`) on the thermal photo with the hot-spot box. Where the twin exists, a second image sighting on the visual photo at the same box scaled to its size.
- The temperatures go in `measurements`: peak, mean, reference and ΔT. Today `Measurement.kind` has no temperature and `unit` has no °C. Adding `temperature` and `degC` is a **contract change**: a row in `docs/architecture/contract-changes.md`, and a check of which older app versions refuse projects with these values.
- **Pins:** an issue's map and 3D pin sits at the photo's position, the corrected one from the Edit position branch (`correctedPhoto`). Without that branch the XT2 photos sit 46 m too low and the pins with them. So this branch builds after Edit position lands, or rebases onto it before its pin task. Placing the pin on the equipment itself, by casting the hot-spot pixel onto a mesh or ground surface when the project has one, is a nice-to-have the builder may add if `aik.project`'s ray casting fits (see below).
- **Report section:** the report works through the app's existing Reports feature, with no client template (_founder_: there is no set report format). A new `ReportSectionId` `thermal`, offered only when the project has confirmed hot spots (the same rule `offeredSections` already applies to survey sections). Per hot spot: the thermal photo with the box and palette bar, the visual twin beside it, the temperatures, ΔT and reference, severity, the note, and a small map with its pin. A summary table ranked by severity then ΔT. Adding the section id is part of the same contract change. **CSV:** one row per hot spot with code, severity, peak, mean, reference, ΔT, photo name, latitude, longitude, height, settings and note.

### Settled in the builder check (_my calls_)

- **Thermal/visual alignment** uses a per-camera lens table (FOV ratio and offset; XT2 and each DJI model) with a one-time per-dataset nudge, not a plain proportional scale.
- **Fixtures:** synthetic FLIR APP1 and DJI R-JPEGs from a small generator, plus DJI SDK sample images where their licence allows them in CI. Private field samples stay local only.
- **Existing projects:** thermal photos are detected from metadata when the bench opens, with no re-import.
- **Back-compat:** older app versions ignore unknown measurement and section ids gracefully. Bump the schema only if the repo's existing rules require it, and the builder checks.
- **Reference temperature** is a stored value plus a link to its source spot, and is re-read when settings change.
- **Confirm creates the issue.** Confirmed issues are in the report by default, with a per-issue "leave out of report" toggle (this replaces any separate "Add to report" concept).

- **One equipment fault seen in several photos is one issue.** In the hot-spot list, "Add to existing hot spot" adds the current box as another image sighting of that issue. Its peak is the highest of its sightings. Detection proposes per photo and does not merge across photos.
- **Settings are per photo.** A reading or hot spot uses its photo's settings. Per-reading emissivity overrides (a painted surface next to bare metal) come later.
- **Degrees Celsius only** in the first version, with °F as a later display setting.
- **Twin finding is shared code.** The bench uses the same twin match as the Edit position branch (plus one, then minus one in the DJI number, captured within 3 s), imported from wherever that branch puts it, not written again.

## Left to the builder

- How the FLIR record is read in the shipped decoder: a bundled exiftool (conda-forge or the standalone Windows build, found with `photo.native.find_tool` like ffmpeg) or a direct Python parser of the APP1 segments. Either must match exiftool's raw values on the fixtures.
- The raster file format on disk (raw float32 with a JSON header, a single-band TIFF, or another), the derived-data path, and caching and invalidation by settings plus decoder version.
- Where the DJI SDK DLLs live in the pack and how they are fetched in `tools/pipeline-pack/build.mjs`. The DJI SDK licence terms are recorded in the third-party notices.
- The detection algorithm: thresholding, connected regions, the surroundings ring size, and merging of nearby peaks. It must find the sample's hot terminals without flooding the list with sky and sun glints. A minimum region size and a cap on candidates per photo are expected.
- Rendering of the palette and isotherm (canvas or WebGL), and how the line profile is drawn.
- Whether hot-spot pins can be cast onto a mesh or surface in this version (`aik.project`, ray grid) or stay at the photo position.
- Fixture generator details (fixture policy is settled above).
- The split into tasks, the Execution DAG and the e2e specs (at least: import a thermal fixture, open the bench, read a spot temperature, confirm a detected hot spot, see it in Issues, on the map and in a report).

## Acceptance

There is no vendor reference reading (_founder_), so acceptance is:

1. Our XT2 decoder matches an independent exiftool-raw + Planck reference implementation to 0.01 °C on the same raw values.
2. The DJI route matches TSDK's own output for DJI's sample images that ship with the SDK.
3. Plausibility bounds hold on real data (no values outside physical limits, medians near ambient for sky and ground).

Absolute accuracy against a calibrated reference is unproven until a reference reading exists.

## Follow-ups

- Obtain a reference reading (a calibrated source or a vendor-measured photo) and check absolute accuracy of both routes against it.

## Founder answers (21 Oct)

1. Cameras: all the other DJI thermal cameras too; the DJI route is in the first version.
2. Report: no set format; use the existing Reports feature (a `thermal` section plus CSV), no client template.
3. Severity: levels adjustable (thresholds, number and names, per project); the defaults above remain my call.
4. Reference: no vendor reading exists; see Acceptance.
