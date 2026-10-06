# Release checklist

Manual steps for a release candidate. Tick every box in the release issue. Commands assume the repository root; `<Product>` and `<version>` come from `packages/brand/brand.json` and `apps/desktop/package.json`.

## 1. Prepare

- [ ] `main` is green in CI on Windows and macOS, licence check included.
- [ ] Version bumped in `apps/desktop/package.json` (semver); release notes drafted.
- [ ] `packages/brand/brand.json` is final for this release (name, app id, company). If `icon.svg` changed: `pnpm icons` and commit.
- [ ] `pnpm check` and `pnpm test:e2e` pass locally on a Windows and a Mac machine.
- [ ] Zero-network suite green: every e2e test ran with the guard, none drained unexpected requests.
- [ ] `pnpm -F @aio/desktop dist:config` shows the expected signing mode (no "unsigned" or "placeholders" for a public release).

## 2. Windows signing (offline NSIS installer and portable exe)

- [ ] Cloud HSM certificate available (OV, in DigiCert KeyLocker or SSL.com eSigner); `WIN_SIGN_COMMAND` set, signing client installed and logged in.
- [ ] `pnpm -F @aio/desktop dist:win`
- [ ] Every binary is signed and timestamped:
  ```powershell
  Get-ChildItem apps/desktop/dist/*.exe, apps/desktop/dist/win-unpacked/*.exe | Get-AuthenticodeSignature | Format-Table Status, Path
  signtool verify /pa /v apps/desktop/dist/<Product>-<version>-win-x64-setup.exe
  ```
  Status is `Valid`, signer is Synapse Solutions, a timestamp is present.
- [ ] Fuses are flipped: `npx @electron/fuses read --app apps/desktop/dist/win-unpacked/<Product>.exe` (RunAsNode, NodeOptions, NodeCliInspect disabled; OnlyLoadAppFromAsar and EmbeddedAsarIntegrityValidation enabled).
- [ ] File properties of the exe show product name, company, version and copyright.

## 3. Microsoft Store (MSIX)

- [ ] Partner Center app reserved under the Synapse Solutions company account; name matches `brand.json`.
- [ ] `STORE_IDENTITY_NAME`, `STORE_PUBLISHER`, `STORE_PUBLISHER_DISPLAY_NAME` copied from Partner Center, Product identity.
- [ ] `pnpm -F @aio/desktop dist:win:store`; `dist:config` no longer reports placeholders.
- [ ] Local install test of the package: `Add-AppxPackage` needs a signed package, so either sign a copy with a test certificate or use the Windows App Certification Kit (`appcert.exe test -appxpackagepath ...`) and fix every failure.
- [ ] Submission: upload the `.appx`, store listing (description, screenshots, privacy policy URL), age rating, pricing and markets; justify the `runFullTrust` restricted capability (desktop app packaged with the Desktop Bridge).
- [ ] After certification, install from the Store on a clean machine and launch.

## 4. macOS signing and notarisation

- [ ] Apple Developer Program membership (organisation, D-U-N-S) and a Developer ID Application certificate; `CSC_LINK` and `CSC_KEY_PASSWORD` set.
- [ ] App Store Connect API key: `APPLE_API_KEY` (path to `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
- [ ] `pnpm -F @aio/desktop dist:mac` on a Mac; the log shows signing with the Developer ID identity and a notarisation success.
- [ ] Verify the universal app (`lipo -archs` on its executable lists `x86_64 arm64`):
  ```bash
  codesign --verify --deep --strict --verbose=2 "apps/desktop/dist/mac-universal/<Product>.app"
  spctl --assess --type execute --verbose "apps/desktop/dist/mac-universal/<Product>.app"
  xcrun stapler validate "apps/desktop/dist/<Product>-<version>-mac-universal.dmg"
  ```
  `spctl` says `accepted, source=Notarized Developer ID`; the ticket is stapled (required so Gatekeeper passes offline).
- [ ] Every bundled `.dylib`, `.node` and helper binary is signed (`codesign --verify` covers this with `--deep`).

## 5. Offline install test on a clean VM

Use fresh VMs (Windows 11 x64 and the oldest supported macOS) with **no network adapter** attached.

- [ ] Copy the installers and a test project (fixture package) in through a shared folder or ISO, not the network.
- [ ] Windows NSIS: installs as a standard user with no UAC prompt; the folder can be changed; Start menu and desktop shortcuts appear with the right icon and name.
- [ ] Windows portable exe runs from a USB stick or another folder.
- [ ] macOS: open the dmg, drag to Applications, first launch passes Gatekeeper offline without a "damaged" or "unidentified developer" dialog.
- [ ] The app opens, the library lists the test project, the workspace renders, a video clip plays.
- [ ] No error mentions the network; nothing waits on a timeout.
- [ ] Uninstall (Windows: Apps and features; macOS: delete the app). User data in the data root is kept.

## 6. Zero-network check

- [ ] Automated: the e2e suite passed in CI with the zero-network guard on both OSes.
- [ ] Manual, on the clean VM with a network adapter attached but outbound traffic blocked:
  - Windows: Windows Defender Firewall with an outbound block rule for the app exe; or Resource Monitor, Network tab, filtered on the app process.
  - macOS: Little Snitch or LuLu in alert mode.
- [ ] Run a full session (open project, play video, annotate, export) with cloud AI off: no connection attempts at all.
- [ ] Turn cloud AI on, configure a key: connections go only to the chosen AI provider; turn it off again and confirm they stop.

## 7. Publish

- [ ] SHA-256 checksums for every artifact: `Get-FileHash -Algorithm SHA256 apps/desktop/dist/*.exe` / `shasum -a 256 apps/desktop/dist/*.dmg`.
- [ ] Artifacts, checksums and release notes uploaded to the distribution share; Store submission sent.
- [ ] Tag the release commit `v<version>`.
