# Known limits

What Stratlas does not do yet, or does differently on purpose. Testing steps are in [TESTING.md](TESTING.md).

Current limits only; each is removed from this list when fixed.

## Data and positions

- HCl position on the map is approximate (the source has no survey position); flight start times are nominal, relative timing is exact.
- DAMAC origin height is approximate (no survey control in the source).
- Video calibration is one constant offset per clip (orientation, position, time, lens): no bias that changes along a clip. On Al-Zour, **Refine automatically** is weak (the edges rarely agree clearly on the plant); point pairs work.
- No geoid model: camera heights are the drone's absolute or relative altitude plus the offset or take-off height you give; a project's vertical datum is one offset.
- One take-off height per import batch: import flights that took off from different heights separately.
- Al-Zour sea level (93.56 m) is marked indicative; adjust it in the sun popover if the waterline looks high. A few light surf patches near the west breakwater read as land and show as flat patches on the water.
- Al-Zour clip DJI_0668 is 31.5 s long and DJI_0669 starts 60 s after it, so between them the video window shows "No footage at this time". That is correct.

## Viewer

- Issue labels hidden behind the building can lag the camera by about a tenth of a second while orbiting.
- At night the point cloud keeps its daylight colours and takes no shadows.
- Point size cannot go below 1 px, so shrinking has no visible effect where points are already 1 px (Al-Zour overview, HCl from far out). At the Al-Zour overview, larger points merge into a coarser mosaic rather than separate dots.
- **Compare dates**: measure, drawing, the AI agent, video and pile bodies work in the left (main) view only. On the **Low** graphics tier you get two maps or the swipe instead of two 3D views.
- With the right panel open on a 1440 px screen, the Labels and layers buttons move into the **More** menu.
- No Arabic translation yet; **Right to left** mirrors the panels only.

## Reports, packages and maps

- Report branding is one setting for all projects (no per-project override yet).
- Road project reports default to issue pages for all but the lowest level (a page per Ring Road defect would be over 2,000 pages); pick **Every graded issue** to print them all.
- The street map under the Masafi site is soft up close (one 5 km image at about 2.4 m per pixel).

## Builder

- The pipeline pack is not in the installer; it lives in `E:\Stratlas Data\runtime` (now `pipeline-pack-0.2.0`) and must match the build. The app uses the newest pack there.
- **Outline** (mask assist) needs a mask model file in the pipeline pack; none ships yet (licences).
- The HCl sample's GPS and gimbal tags are written from the delivered camera poses (the Elios 3 logs no GPS in the tank) around the approximate HCl origin; a real photo set brings its own tags.
- Cloud AI detection needs Cloud AI on and your own key; cost is an estimate from list prices.

## Release

- Unsigned build: SmartScreen warns on install. No automatic updates: install over the previous version. Store submission waits for M7.
- Old video files are kept in `projects\hcl\video.before-1080` and `projects\alzour\video.before-1080` (about 0.6 GB): delete them once you are happy with M5.

## Change, modelling and local AI (M8)

### Change between dates

- Change is found only where both dates have data; outside the overlap nothing is reported.
- Change on dates that are not registered is refused: more than 2 px (orthos, surfaces), 5 cm (point clouds) or a 5 cm height offset (surfaces) apart. Align the layers first; there is no setting in the app for a larger tolerance.
- The change thresholds are the defaults (`Settings.change`); there is no Settings page for them yet.
- Issues marked only on photos or frames (no 3D sighting) are not matched across dates, so they are never **Resolved** or **Grown**.
- An issue is **Resolved** only when photos of the later date cover its place; other later layers do not count, so it shows **Not seen**.
- **Make issue** is not offered on issue changes; **Confirm** links the two issues instead.
- Imagery change does not read PMTiles orthos, and very large orthos are compared on a coarser cell.
- Imagery change areas are always **Changed**: they are not split into added and removed.
- Surface change from COPC point clouds (through PDAL) is untested on real data.
- Surface change reports a height offset between the dates under 5 cm but does not correct it.
- A change heat map layer counts for both dates until it is given a survey date (**Belongs to date...**).
- Nearest-neighbour distance overstates change on sparse clouds, and between clouds of very different density.
- Surface change from a sparse point cloud (a few points per square metre) averages roof and wall points into ground cells at object edges: on the demo change site its volumes are up to a third off, against a few per cent from the height grids. Use a DSM when there is one.
- On sparse clouds, cloud change misses small low changes (the demo's new excavation) and reports small extra regions where the later survey sees faces the earlier one did not.
- Detections count per place on the ground only on posed photos and assume flat ground at the project origin height; on sloping sites one thing may count as two places.
- A model part counts as changed when 1 m2 of its surface, or 1% of it, deviates by more than the threshold (5 cm); the 1 m2 rule is a working default.
- A horizontal shift on flat ground is invisible to cloud change: the points still lie on the same plane.
- A moved object shows as two cloud change regions (new where it is, gone where it was), not as one move.
- The cloud registration check reads only a 40 m square at the centre of the overlap.
- Model change samples 50,000 points of each model; on large models it is slow.
- The cloud change distance under the pointer shows in the main 3D view only.
- The Frames pane assumes flat ground: **Line up the ground** does not line up tall objects.
- Video frames are not compared by **Find changes in matched frames** (`change.frames`): photos only.
- While a clip plays, the Frames pane shows still frames of the other date, not a second video.
- The video of the demo change site is small (384 x 216 pixels, 2 frames per second).

### Models from drawings and point clouds

- DXF only: no DWG. Save DWG drawings as DXF first.
- Parts are edited by numbers only: no drag handles, no overlay of the fit residual on the cloud.
- Straight pipes only; tank roofs are flat or cone.
- Arcs in DXF polylines (bulges) are drawn straight, and block arrays bring in only their first copy.
- Built models are not checked with a glTF validator.
- Fitting parts to point clouds is untested on real scans.

### Local detection

- onnxruntime-node ships a macOS binary for Apple silicon (darwin arm64) only, so Intel Macs have no local detection.
- Local detection checks photos only, not video frames.
- The licence box is ticked before the model card is shown.
- The memory the model runtime uses is not capped.

### Local AI agent

- Local model quality and speed depend on the person's hardware; without a graphics card an answer can take tens of seconds.
- Vision support of a local model is guessed from its name.
- Token counts for local models are estimates (characters divided by 4).
- Ollama may serve a smaller context window than the model's maximum; pick **Compact** for small contexts.
- Tested against a simulated server only; real Ollama, LM Studio and llama.cpp servers are not yet tested.

## Team, history and sync (M9)

### History and audit

- History shows only inside **Edit issue** on the issue card; packages opened in the player show no History, and change items, detections and model parts have no History tab yet (their changes are in the **Audit trail**).
- **Restore** in History puts back issue fields only, and the entry it writes reads "Edit F01" rather than "Restore".
- Edits made outside the app (an older build, a hand edit in Notepad) are found at the next write of that file or the next open of the project, not the moment they happen.
- The journal cache (userData `journal-cache/`) keeps a snapshot of every journaled file, so those JSON files take about twice their size on disk.
- When the credential store (Windows Credential Manager, macOS Keychain) cannot be used, changes are recorded without a signature. **Verify** says so, and in a shared project the other copies hold those changes in quarantine until an owner applies them anyway.
- Signed checkpoints are written every 500 changes and at each audit export, not yet at every sync or exchange file.
- Fork detection is proven on the golden fixtures only; a copied folder that kept writing in an unusual way may be reported as a gap or an order problem rather than a fork.
- Notes saved in the four legacy viewers (through their own storage shim) are not journaled.
- Customer packages do not yet carry the signed audit summary, and the package export has no **Include full history** choice (`PackageHeader.journal` is in the contract only). Packages carry no member list.

### Identity and members

- The Credential Manager entry of the device key is named after the app id (service `ai.synapse-solutions.stratlas...`, account `device-signing`), not "Stratlas device key".
- Identities are self-asserted by default ("Unverified"); an owner certifies a card after checking it with the person. There are no accounts until M10.
- One device key per profile and computer: a lost computer means revoking its device and adding the person's new one. History before the revocation stays valid.

### Review workflow

- The review area (assign, comments, approvals) is inside **Edit issue** on the issue card, and on change items in the Changes panel. Detections, model parts and the register have no review columns yet, and there are no bulk approvals.
- Approvals need a shared project; a private project keeps the status buttons as in 0.8.
- A local edit that makes an approval out of date returns the issue to **Reviewed** while the issue is open in **Edit issue**; after a merge the status is set from the approvals at once.
- The status after a merge is not checked again against the order of statuses (`canTransition`).
- No email or push notifications: **My work** is in the app only.
- No real-time co-editing: people see each other's changes after a sync, not as they type.

### Merging and conflicts

- Roles in exchange-file and shared-folder mode are tamper-evident, not enforced: a change beyond a person's role is held in quarantine on every other copy, but anyone with write access to the folder can still edit its files (seen as "Changed outside Stratlas" in History). Only the team server enforces roles.
- Detections without ids (passes made before M9) merge per pass: the last writer of the whole pass wins.
- Manifest entries (layers, captures) are merged in the history but not yet written back to `manifest.json`.
- Two issues made from one change item on two copies are not offered for merging; merge them by hand in the issue register.
- The merge runs in the main process, not in the data process or a worker; 10,000 incoming changes on a 5,000-issue project take about a second.

### Exchange files and shared folders

- Exchange files are limited to 2 GB (store-mode ZIP, no ZIP64). Send changes only and move large files through a shared folder or a USB copy of the project.
- **Export changes** offers all changes or changes since a date (from midnight on this computer); there is no "since what I last sent to this person" choice yet. The other copy skips what it already has.
- Encryption is by passphrase only (scrypt, AES-256-GCM); encryption to the recipients' keys comes after 1.0. Hashing and scrypt run in the main process.
- Reply files from the free player (client comments and acceptance from a customer package) are not written yet.
- A copy joins a team project by importing one of its exchange files; there is no picker to join a team project straight from a shared folder.
- Cloud-drive folders (OneDrive, Dropbox) as a hub: files the client keeps online only (files on demand) delay reads until they are downloaded; a read slower than 20 seconds counts as "Folder offline" and the next sync tries again.
- Automatic sync runs every 15 minutes and when the window gets focus; it does not run right after each save, and the interval has no Settings page yet.
- The library shows no team badge (mode, unread, conflicts) on a shared project.
- Compare-before-write is a check, then a rename: a save that lands between the two can still be replaced, there is no lease file, and the edit refused with "... was changed by someone else since you opened it" is lost when you click **Reload**.
- `.aio` packages keep their existing encryption (WinZip AES, PBKDF2-SHA1 with 1,000 rounds); exchange files use scrypt.

### Large files

- Hashing of project files runs in the main process (paced to 100 MB/s), not in a worker; indexing a 20 GB folder during playback has not been measured yet.
- The download cache cap (50 GB by default) has no Settings page, and there is no **Free space** button yet.
- Potree 2 clouds and kit image pyramids register only their entry file.
- A layer whose file is not on this computer can still log "could not be loaded" in the developer console; the layer itself shows the "Not on this computer" card.

### Team server (preview)

- A preview: not covered by the 1.0 support policy, and no external security test yet.
- No S3-compatible blob store (files stay on the server's disk), no web interface (command line only), one server process per database.
- The Postgres store is tested in CI only, not run on the development workstation.
- Files are not kept apart per project on the server, and clients cannot download shared packages from it yet.
- The app shows no live server status. Connecting needs the credential store: without it this computer has no device key.
- A server certificate renewed by a CA the computer trusts is not accepted on its own yet: forget the server and connect again with a new invite code.
