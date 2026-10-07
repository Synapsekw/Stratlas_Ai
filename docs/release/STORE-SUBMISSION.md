# Microsoft Store submission checklist

For the founder. Publishing is **deferred** (founder decision); everything below is ready so a submission takes an afternoon when the decision is made. Tick the boxes in the release issue.

What is already done in the repository:

- The product is reserved in Partner Center; its identity (`SynapseSolutions.Stratlas`, publisher `CN=93BC08FE-8EF9-44E5-AC18-4B57E9E7759A`) is in `packages/brand/brand.json`, so every MSIX build carries it. No variables needed.
- `release.yml` builds the MSIX on every `v*` tag (artifact `release-windows`). It is unsigned on purpose: Microsoft signs Store packages during certification.
- Tiles and logos at every scale are inside the package (`apps/desktop/build/appx/`); listing images, listing text and the privacy policy draft are in `docs/release/store-listing/`.
- The package declares `runFullTrust`, the `.aio` file type and the `stratlas:` link.

Partner Center labels change from time to time; if one below differs slightly, look for the nearest match.

## 1. Before the first submission (once)

- [ ] **Privacy policy online.** Fill in the brackets in `store-listing/privacy-policy.md` (date, address, support email) and publish it on synapse-solutions.ai, for example `/stratlas/privacy`. Partner Center rejects the submission without a working URL, because cloud AI can send data when the person turns it on.
- [ ] **Support contact:** a support email or page on synapse-solutions.ai.
- [ ] **Demo project approved for publication** (stream D3) and bundled: certification runs the app with no data of yours, and screenshots must not show client sites without permission.
- [ ] **Screenshots:** 4 to 8 PNGs at 1920 x 1080 from the demo project (fused scene, video on the model, issue register, map, volumes). Use only demo data; no client logos or names. `QUADRION_E2E_SHOTS=<folder>` with `apps/desktop/e2e/first-start.spec.ts` saves the welcome and both demo projects.
- [ ] Decide **markets** (all, or the GCC markets you sell in) and **price** (free with Synapse licensing, or a price).

## 2. Get the package

- [ ] Tag the release commit `v<version>` (or run **Actions, release, Run workflow**) and wait for the run to go green.
- [ ] Download the `release-windows` artifact; take `Stratlas-<version>-win-x64-store.msix` and check its hash against `SHA256SUMS-windows.txt`.
- [ ] Each submission needs a **higher version** than the last one (`apps/desktop/package.json`; the MSIX version is `<version>.0`).
- [ ] Optional local check on a Windows machine with the Windows SDK: `appcert.exe test -appxpackagepath Stratlas-<version>-win-x64-store.msix -reportoutputpath report.xml` (Windows App Certification Kit). Fix every failure before uploading.

Local build instead of CI: `pnpm -F @aio/desktop dist:win:store`. If it stops with `spawn UNKNOWN`, point electron-builder at the Windows SDK first: `$env:ELECTRON_BUILDER_WINDOWS_KITS_PATH = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.19041.0\x64"`.

## 3. Create the submission

Partner Center, **Apps and games**, Stratlas, **Start your submission**.

- [ ] **Pricing and availability:** markets; for the first release choose **Private audience** (only the Microsoft accounts you list) or **Hidden in the Store, available by direct link**; make it public later. Price.
- [ ] **Properties:** category **Productivity**; privacy policy URL from step 1; website `https://synapse-solutions.ai`; support contact; system requirements from `store-listing/listing.md`.
- [ ] **Age ratings:** IARC questionnaire. Answers: no violence, no user-generated content shared publicly, no in-app purchases, no location sharing, no personal data collected. Expected rating: Everyone / 3+.
- [ ] **Packages:** upload the `.msix`. Partner Center checks the identity against the reservation; a mismatch means `brand.json` `store` was changed. Device family: **Windows 10/11 Desktop** only.
- [ ] **Store listings, English (United States):** copy description, short description, what's new, features and search terms from `store-listing/listing.md`; upload screenshots; Store logos and display images from `store-listing/images/` (table in `listing.md`).
- [ ] **Submission options, restricted capabilities:** paste the `runFullTrust` justification from `listing.md`.
- [ ] **Notes for certification:** paste the text from `listing.md`.
- [ ] **Submit to the Store.**

## 4. Certification and after

- [ ] Certification takes a few hours to three working days. A failure report names the policy; the usual causes are a missing privacy policy, third-party brands in screenshots, or an app that does not start without data (the demo project covers it).
- [ ] After approval, install from the Store on a clean Windows machine (link from Partner Center for a private or hidden listing): it starts, opens the demo project, `.aio` files open with a double-click, Settings, About shows no "Install update from file" (the Store updates it).
- [ ] Make the listing public when ready (Pricing and availability, Visibility).

## Each later release

- [ ] Bump the version, tag, download the new `.msix` from the `release` run.
- [ ] Partner Center, **Update** the submission: upload the package, update "What's new", submit. Installed copies update through the Store.

## Not needed for the Store

- No code-signing certificate: Microsoft signs the package. The certificate (Azure Trusted Signing or OV, `SECRETS.md`) is for the offline NSIS installer and the portable exe only.
