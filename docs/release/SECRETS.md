# Signing secrets for CI

Only `.github/workflows/release.yml` signs, and only for a `v*` tag (pushed, or **Run workflow** with the tag chosen under "Use workflow from"). Every other run, `release.yml` on a branch included, and every run of `nightly.yml` and `ci.yml`, builds unsigned (Windows) or ad-hoc signed (macOS), whatever secrets exist: the nightly reads none of them, and `STRATLAS_NO_SIGNING=1` makes `tools/release/brand-config.mjs` drop any signing variable before electron-builder runs. The reason is the signature quota below.

Every secret is optional: without them the jobs still pass and upload unsigned or ad-hoc signed test builds. Values never go in the repository or in chat; add them in GitHub, **Settings, Secrets and variables, Actions** ([founder setup guide, section 8](FOUNDER-SETUP-GUIDE.md#8-adding-secrets-and-variables-to-github)).

Check what a run will do in its **Signing mode** step: `{"win":"keylocker","mac":"signed+notarised",...}` and a line `Windows signing route: keylocker (...)`. Locally, `node tools/release/brand-config.mjs --route` prints the route the current environment would use (names only, never values), and `node tools/release/win-sign.mjs --dry-run <file>` prints the sign command with the thumbprint redacted. Both sign nothing.

## Signatures per release (quota)

DigiCert KeyLocker includes **1,000 signatures a year**; more are sold in blocks of 1,000 ([KeyLocker licensing](https://docs.digicert.com/en/digicert-keylocker/overview/licensing.html)). Each file signed once is one signature. One release run of `release.yml` signs:

| File                                                                     | Signatures |
| ------------------------------------------------------------------------ | ---------- |
| `win-unpacked/<Product>.exe`, the app (packed once for both installers)  | 1          |
| `win-unpacked/resources/elevate.exe`, the NSIS elevation helper          | 1          |
| The NSIS uninstaller, built and signed before it goes into the installer | 1          |
| `<Product>-<version>-win-x64-setup.exe`                                  | 1          |
| `<Product>-<version>-win-x64-portable.exe`                               | 1          |
| **Total per release**                                                    | **5**      |

Not signed, so not counted:

- **DLLs and native addons.** electron-builder signs only `.exe` files unless `win.signExts` is set, and `electron-builder.yml` does not set it. Electron's DLLs, the onnxruntime and DirectML DLLs (already signed by Microsoft) and the `.node` addons are left as shipped.
- **The Store MSIX.** Microsoft signs it during certification; the build drops every signing variable for it.
- **macOS.** Apple's Developer ID has no signature quota.

One hash algorithm only: `signingHashAlgorithms: [sha256]` in `electron-builder.yml`. electron-builder's default (`sha1` and `sha256`) would sign every file twice, 10 per release. A test (`tools/release/brand-config.test.mjs`) keeps both settings.

So 1,000 a year covers about 200 release runs, roughly 4 a week. A re-run of a release job costs another 5, and electron-builder retries a signature up to 3 times after a network error, which may count. Each release run writes the real number to its job summary ("Windows signing: N exe files signed and verified"). A nightly that signed would have used about 1,800 a year on its own, which is why it never signs.

## Windows: routes

Tried in this order; the first whose values are all set is used, and only that one: the build removes the other routes' variables before electron-builder runs, and fails if the route at build time differs from the one the **Signing mode** step logged.

| Order | Route                     | Switches on when these are set                                                                                  | Status                                                                                     |
| ----- | ------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1     | Azure Artifact Signing    | `AZURE_SIGN_ENDPOINT`, `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`         | Kept for an eligible subsidiary; a Kuwaiti company cannot use it today                     |
| 2     | DigiCert KeyLocker        | `SM_HOST`, `SM_API_KEY`, `SM_CLIENT_CERT_FILE_B64`, `SM_CLIENT_CERT_PASSWORD`, `SM_CODE_SIGNING_CERT_SHA1_HASH` | **Our route** ([setup guide, section 1](FOUNDER-SETUP-GUIDE.md#1-windows-code-signing-b2)) |
| 3     | Certificate file (`.pfx`) | `WIN_CSC_LINK`                                                                                                  | Only for a certificate allowed to live in a file                                           |
| 4     | Custom command            | `WIN_SIGN_COMMAND`                                                                                              | Any other cloud HSM; SSL.com eSigner is the documented fallback                            |

After the build, `release.yml` checks every `.exe` in the installers and the unpacked app: `signtool verify /pa` must pass, the signature must be timestamped, and the signer's subject CN must equal `WIN_PUBLISHER_NAME` (default: `signing.windowsPublisher` in `packages/brand/brand.json`, else the company). It also applies the app's own update check (ADR 0003): the signer must equal `signing.windowsPublisher` when that is set, otherwise its CN or O must contain the company. Any failure fails the release.

### Publisher name (all routes)

| Name                 | Kind     | Value                                                                                                                         | Read by                                                            |
| -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `WIN_PUBLISHER_NAME` | variable | The certificate subject CN, copied letter for letter, for example `Synapse Solutions Company W.L.L.` (setup guide, section 1) | `release.yml` (Azure `publisherName`, and the check after signing) |

### 1. Azure Artifact Signing

Needs an Azure subscription, an Artifact Signing (formerly Trusted Signing) account with a validated identity, a certificate profile, and an app registration with the **Artifact Signing Certificate Profile Signer** role on that account. Public-trust identities are only issued in some countries (setup guide, section 1).

| Name                  | Kind                 | Value                                                             | Read by       |
| --------------------- | -------------------- | ----------------------------------------------------------------- | ------------- |
| `AZURE_SIGN_ENDPOINT` | variable (or secret) | Account endpoint, for example `https://weu.codesigning.azure.net` | `release.yml` |
| `AZURE_SIGN_ACCOUNT`  | variable (or secret) | Signing account name                                              | `release.yml` |
| `AZURE_SIGN_PROFILE`  | variable (or secret) | Certificate profile name                                          | `release.yml` |
| `AZURE_TENANT_ID`     | secret               | Directory (tenant) ID of the app registration                     | `release.yml` |
| `AZURE_CLIENT_ID`     | secret               | Application (client) ID                                           | `release.yml` |
| `AZURE_CLIENT_SECRET` | secret               | Client secret of the app registration                             | `release.yml` |

### 2. DigiCert KeyLocker (our route)

DigiCert OV code signing with the key in KeyLocker, DigiCert's cloud HSM. The founder creates these in DigiCert ONE after the certificate is issued ([setup guide, section 1, "Access for GitHub"](FOUNDER-SETUP-GUIDE.md#1-windows-code-signing-b2)). The names are the ones in [DigiCert's GitHub guide](https://docs.digicert.com/en/digicert-keylocker/ci-cd-integrations-and-deployment-pipelines/scripts/github/scripts-for-signing-using-ksp-library-on-github.html). All are read only by `release.yml`, job **package (Windows)**; nothing else reads them.

| Name                             | Kind   | What it is                                                                                          | Where it comes from                                                                     |
| -------------------------------- | ------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `SM_HOST`                        | secret | DigiCert ONE host URL, for example `https://clientauth.one.digicert.com`                            | Shown with the API token in DigiCert ONE                                                |
| `SM_API_KEY`                     | secret | KeyLocker API token; also used to download the KeyLocker tools                                      | DigiCert ONE, profile, **API tokens** (shown once)                                      |
| `SM_CLIENT_CERT_FILE_B64`        | secret | The client authentication certificate (`.p12`) as base64                                            | DigiCert ONE, **Client authentication certificates**; converted with PowerShell (guide) |
| `SM_CLIENT_CERT_PASSWORD`        | secret | That `.p12` file's password                                                                         | Shown once when the client certificate is created                                       |
| `SM_CODE_SIGNING_CERT_SHA1_HASH` | secret | SHA-1 thumbprint of the code-signing certificate (40 hex characters; spaces and colons are ignored) | DigiCert ONE, KeyLocker, **Certificates**, the code-signing certificate                 |

What `release.yml` does with them, following DigiCert's documented GitHub flow:

1. **Signing mode** picks the route and logs it.
2. **Set up DigiCert KeyLocker** (only on the KeyLocker route): decodes `SM_CLIENT_CERT_FILE_B64` to `$RUNNER_TEMP/keylocker-client.p12` (exported as `SM_CLIENT_CERT_FILE`), downloads and installs `Keylockertools-windows-x64.msi` with the API key, runs `smctl windows ksp list` and `smctl windows certsync`, and checks that the certificate with that thumbprint is now in the store. The normalised thumbprint is masked with `add-mask`; nothing prints a secret.
3. **Build**: electron-builder calls `tools/release/win-sign.mjs` per file, which runs `signtool sign /sha1 <thumbprint> /tr http://timestamp.digicert.com /td SHA256 /fd SHA256 <file>`; DigiCert's KSP signs with the key in KeyLocker.
4. **Verify**: `signtool verify /pa` and the publisher check above.
5. **Remove the KeyLocker client certificate**: deletes the `.p12` in an `always()` step, also when the job failed.

The secrets go only to the steps that need them, never to `pnpm install`.

### 3. Certificate file (.pfx)

Only for a certificate that may live in a file (OV certificates issued since June 2023 live in hardware; use route 1 or 2 for those).

| Name                   | Kind   | Value                                                                                   | Read by       |
| ---------------------- | ------ | --------------------------------------------------------------------------------------- | ------------- |
| `WIN_CSC_LINK`         | secret | The `.pfx` as base64 (`[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))`) | `release.yml` |
| `WIN_CSC_KEY_PASSWORD` | secret | Its password                                                                            | `release.yml` |

### 4. Custom command (`WIN_SIGN_COMMAND`)

`WIN_SIGN_COMMAND` (variable): a command template with `{file}`, run once per file through the shell (`cmd.exe` on Windows) by `tools/release/win-sign.mjs`. It must timestamp, sign with SHA-256 and exit non-zero on failure. Secrets must not be written into the variable; reference them as environment variables (`%NAME%`).

#### Fallback: SSL.com eSigner

Only if DigiCert fails ([setup guide, section 1, fallback steps](FOUNDER-SETUP-GUIDE.md#fallback-steps-sslcom-esigner-only-if-digicert-fails)). Signing uses SSL.com's CodeSignTool, which signs and timestamps in place ([CodeSignTool command guide](https://www.ssl.com/guide/esigner-codesigntool-command-guide/)). The founder adds:

| Name                 | Kind     | Value                                                                                |
| -------------------- | -------- | ------------------------------------------------------------------------------------ |
| `ES_USERNAME`        | secret   | SSL.com account username                                                             |
| `ES_PASSWORD`        | secret   | SSL.com account password                                                             |
| `ES_CREDENTIAL_ID`   | secret   | eSigner credential ID of the code-signing certificate (SSL.com dashboard, the order) |
| `ES_TOTP_SECRET`     | secret   | The eSigner TOTP secret code shown with the QR code at enrolment                     |
| `WIN_SIGN_COMMAND`   | variable | The template below                                                                   |
| `WIN_PUBLISHER_NAME` | variable | The certificate subject CN                                                           |

```bat
CodeSignTool.bat sign -username="%ES_USERNAME%" -password="%ES_PASSWORD%" -credential_id="%ES_CREDENTIAL_ID%" -totp_secret="%ES_TOTP_SECRET%" -input_file_path={file}
```

To switch it on, the team adds two things to `release.yml`, job **package (Windows)**: a step before the build that downloads CodeSignTool for Windows ([ssl.com/download/codesigntool-for-windows](https://ssl.com/download/codesigntool-for-windows/)) and puts its folder on `PATH`, and the four `ES_*` secrets in the **Build** step's `env`. The KeyLocker secrets must then be absent, or route 2 wins. eSigner plans count signings per month (setup guide, section 1): 5 per release, so the 20-a-month plan covers 4 releases a month.

The Microsoft Store package is never signed by us: Microsoft signs it during certification, and the build drops every Windows signing variable for it.

## macOS

Needs an Apple Developer Program membership (organisation) and a **Developer ID Application** certificate. Read by `release.yml`, job **package (macOS universal)**, for a `v*` tag only.

| Name                   | Kind   | Value                                                                                          |
| ---------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| `MAC_CSC_LINK`         | secret | Developer ID Application certificate and key exported as `.p12`, base64 (`base64 -i cert.p12`) |
| `MAC_CSC_KEY_PASSWORD` | secret | The `.p12` password                                                                            |

`CSC_LINK` / `CSC_KEY_PASSWORD` are accepted as aliases for the two above; they are only ever passed to the macOS job.

Notarisation, one of:

| Name                          | Kind   | Value                                                                    |
| ----------------------------- | ------ | ------------------------------------------------------------------------ |
| `APPLE_ID`                    | secret | Apple ID email of a team member with the Developer role                  |
| `APPLE_APP_SPECIFIC_PASSWORD` | secret | App-specific password created at account.apple.com, Sign-In and Security |
| `APPLE_TEAM_ID`               | secret | 10-character team ID (developer.apple.com, Membership)                   |

or an App Store Connect API key (preferred by Apple, survives password changes):

| Name               | Kind   | Value                                  |
| ------------------ | ------ | -------------------------------------- |
| `APPLE_API_KEY_P8` | secret | Contents of the `AuthKey_XXXX.p8` file |
| `APPLE_API_KEY_ID` | secret | Key ID                                 |
| `APPLE_API_ISSUER` | secret | Issuer ID                              |

With a certificate but no notarisation credentials, the app is signed but not notarised (Gatekeeper still warns). Without a certificate it is ad-hoc signed and the notarisation step is skipped.

## Microsoft Store identity

Already in `packages/brand/brand.json` (public values from Partner Center). The variables `STORE_IDENTITY_NAME`, `STORE_PUBLISHER`, `STORE_PUBLISHER_DISPLAY_NAME` override it; none is needed. They are not signing values, so the nightly reads them too.
