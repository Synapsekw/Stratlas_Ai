# Microsoft Store submission (MSIX)

Route: an MSIX package built by `pnpm -F @aio/desktop dist:win:store`. Microsoft signs Store packages during certification, so this channel needs no code-signing certificate. The offline installer (USB, NAS) is a separate channel and still needs an OV certificate.

Partner Center labels change from time to time; if a label below differs slightly, look for the nearest match.

## 1. Reserve the product (5 minutes)

1. Go to **partner.microsoft.com/dashboard**, sign in with the Synapse Solutions developer account.
2. **Apps and games**, then **New product**, then **MSIX or PWA app**.
3. Reserve a name. "Stratlas" works while the name is temporary. The **package identity is created from the first reserved name and never changes**, even after you rename the app later (you can reserve more names and switch the display name), so if the final name is known, reserve that one instead.

## 2. Copy the identity values to the build

1. Open the product, then **Product management**, then **Product identity**.
2. Copy these three values into the build environment (or send them to the team; they are public identifiers, not secrets):

| Partner Center field                             | Build variable                 |
| ------------------------------------------------ | ------------------------------ |
| `Package/Identity/Name`                          | `STORE_IDENTITY_NAME`          |
| `Package/Identity/Publisher` (starts with `CN=`) | `STORE_PUBLISHER`              |
| `Package/Properties/PublisherDisplayName`        | `STORE_PUBLISHER_DISPLAY_NAME` |

3. Build: `pnpm -F @aio/desktop dist:win:store`. Output: `apps/desktop/dist/*.msix` (or `.appx`).

## 3. Fill in the submission

Start a submission from the product overview (**Start your submission**). Sections:

### Pricing and availability

- **Markets:** all, or only the GCC markets you sell in.
- **Visibility:** for the first release choose **Private audience** (only Microsoft accounts you list can see and install it) or **Hidden in the Store, available by direct link**. Make it public later.
- **Pricing:** Free (licensing handled by Synapse), or a price.

### Properties

- **Category:** Productivity (or Business).
- **Privacy policy URL: required.** The app can send data to AI providers when the person turns cloud AI on. Host a short policy on synapse-solutions.ai (draft below).
- **Website / support contact:** synapse-solutions.ai support page or email.
- **System requirements:** recommended hardware: 16 GB RAM, a DirectX 12 GPU with 4 GB VRAM; minimum: 8 GB RAM, integrated GPU.

### Age ratings

Complete the IARC questionnaire: no violence, no user-generated public content, no purchases inside the app. Expected result: Everyone / 3+.

### Packages

- Upload the `.msix` from step 2. Partner Center checks that its identity matches the reserved product; a mismatch means the variables in step 2 were not set when building.
- Device family: **Windows 10/11 Desktop** only.

### Store listing (English)

- **Description, short description, features:** use the draft below.
- **Screenshots:** at least 1, up to 10, 1366 x 768 or larger (1920 x 1080 recommended). We supply them from the app (Al-Zour fusion, HCl inspection, DAMAC issues, Ring Road map, Masafi volumes). Use only screenshots your clients allow to be public, or the demo project.
- **Store logos:** generated from `packages/brand` by the release tools.
- **Search terms:** drone inspection, digital twin, point cloud, reality capture, asset integrity, offline GIS, LiDAR.

### Submission options

- **Restricted capabilities: `runFullTrust`.** Partner Center asks why. Paste:
  > Stratlas is a desktop application built with Electron. It needs full trust to read large project folders chosen by the user (multi-gigabyte drone video, point clouds and 3D models on local disks and network shares), to store API keys in Windows Credential Manager, and to run its bundled processing tools. It makes no network requests unless the user turns on cloud AI or downloads a map pack.
- **Notes for certification:** "The app works offline. To test, open the bundled demo project from the Projects screen. Cloud AI is off by default and needs the tester's own API key."

## 4. Submit and wait

- **Submit to the Store.** Certification usually takes a few hours to 3 business days.
- If it fails, the report names the policy; the most common causes are a missing privacy policy, screenshots containing third-party brands, or the app not starting without data. The demo project avoids the last one.

## 5. Updates

Each new version: raise the version in `apps/desktop/package.json`, rebuild the MSIX, start a new submission, upload the package. The Store updates installed copies automatically.

## Draft listing text

**Short description (up to 100 characters):** Offline drone inspection workspace: video, 3D models, point clouds and maps in one view.

**Description:**
Stratlas brings everything a drone inspection or survey produces into one offline workspace. Open a project and see the 3D model, the point cloud, the orthomosaic and the street map together, play the drone video with the flight path in 3D, and watch each frame drape onto the asset from the drone's own position.

Mark issues on photos, video frames, models and point clouds, grade them with your severity model, and see one issue across every view. Review stockpile volumes, road defects and facade findings, and export what your client needs.

Stratlas runs fully offline, including street maps for the GCC. Optional AI assistants from Anthropic, OpenAI or Google work in every window with your own API key, and only when you turn them on.

**Features:**

- Fused 3D scene: models, point clouds, orthomosaics, offline maps
- Drone video synced to its flight path and projected onto the model
- Annotation suite with severity models across photos, video, 3D and maps
- Offline street maps for Kuwait, the UAE and the GCC
- Optional AI agents with your own keys, off by default

## Draft privacy policy (publish on synapse-solutions.ai)

Stratlas processes your project data on your computer. It does not collect personal data or usage statistics and makes no network requests by default. If you turn on cloud AI and add your own API key, the text and images you choose to send in an AI conversation go to the provider you selected (Anthropic, OpenAI or Google) under that provider's terms; Stratlas shows what will be sent before the first message in a project. API keys are stored in Windows Credential Manager on your computer. If you download a map pack, the app contacts the map data server you chose. Contact: (your support email).

## Still needed for the full release

- A **demo project** bundled with the Store build (non-client data) so certification and new users can try the app without project data. Action: choose a dataset we may publish, or we build a synthetic one.
- An **OV code-signing certificate** for the offline installer channel.
