# Publishing website updates

Website updates use the member portal at `https://quadrion.ai`. Customers sign in with their existing website account in Settings, About. The app checks and downloads in the background; **Restart and update** is always their choice. Offline-only workstations make no updater requests.

## First deployment

1. Deploy the website database migration and portal changes together, following the website repository's migration-history reconciliation instructions. Keep existing releases available for manual download; they are not automatically eligible.
2. Build and validate a signed Windows x64 NSIS desktop release containing the website updater, using the normal release process. Install that first release manually on existing workstations. Older desktop builds cannot discover or install updater functionality they do not contain.
3. Sign in from Settings, About using an active website member account. Enable automatic updates if previously disabled. The website remains the authority for current membership and private downloads.
4. Publish eligible processing-kit and app releases using the sequence below. A draft or merely uploaded file is never offered as an update.

This implementation does not itself build or publish an installer, migrate production, or enable existing portal releases. Store, portable, development and non-Windows-x64 builds explain that automatic installation is unavailable.

## Publishing a processing kit

1. Build the usual `pipeline-pack-X.Y.Z-win-x64.tar.gz` archive. Its internal manifest must identify its version, platform, supported app range, and hashes of its files.
2. Create a pipeline release on the website. Use a stable three-part version, Windows, x64 architecture, and the processing archive format. Enable automatic updates and supply the supported app range in the form `>=X.Y.Z <X.Y.Z`, matching the archive's compatibility.
3. Upload the archive and wait for verification. Publish the release only when the file is verified.
4. Signed-in apps with a compatible version can download this kit independently. Their active kit stays unchanged until the user chooses to restart. The previous selection remains available for recovery.

## Publishing an app

1. Build the signed Windows x64 NSIS installer with a version newer than the installed app. Use the usual installer naming and publisher identity.
2. Publish a compatible eligible processing kit first. Create the app release, enable automatic updates, select Windows x64 and NSIS, and link that baseline kit.
3. Upload the installer, wait for verification, and publish. The updater considers only a valid app/kit combination; publishing an app cannot force an incompatible kit onto a workstation.
4. Existing apps check at startup and every six hours. **Check now** also requests the latest published metadata. Only changed components download.

The updater compares numeric versions, rather than publication dates. Stable versions only are offered. A newer compatible kit can satisfy the app's baseline kit requirement. Release retirement prevents new checks/grants from offering that artifact; already issued private URLs expire after five minutes.

## Transfer and recovery

Metadata checks do not download files or consume download-link reservations. Transfers obtain a short-lived private URL, download directly from storage, and resume partial files by byte range where supported. A fresh URL can be requested for a bounded retry; the portal's download-link quota still applies. Downloads are full component files, not binary patches.

The app verifies size and SHA-256, then checks the installer's publisher/version and the processing archive's manifest and contents. Both requested components must be ready before the restart action is enabled. A ready local update can be applied offline. A busy workstation refuses restart until its work finishes; it does not schedule an unprompted restart later.

The installed app is retained using the existing rollback mechanism. Managed kits are kept outside the legacy kit scan and selected for their app version, so the kept old executable cannot accidentally discover a newly downloaded kit. Projects and settings are not update payloads.

If a transfer fails, Settings, About shows an error and **Try again**. If membership expires, sign in with an active account. Disabling automatic updates or signing out cancels network activity. Local installer and processing archive installation remain available for offline deployment.
