# Signing secrets for CI

`.github/workflows/release.yml` (tag `v*` or **Run workflow**) and `nightly.yml` sign only when these exist. Every one is optional: without them the jobs still pass and upload unsigned (Windows) or ad-hoc signed (macOS) test builds. Values never go in the repository or in chat; add them in GitHub, **Settings, Secrets and variables, Actions**.

Check what a run will do in its **Signing mode** step: `{"win":"azure","mac":"signed+notarised",...}`. Locally, `pnpm -F @aio/desktop dist:config` prints the same.

## Windows: pick one

First match wins.

### A. Azure Trusted Signing (preferred)

Needs an Azure subscription, a Trusted Signing account with a validated identity, a certificate profile, and an app registration (service principal) with the **Trusted Signing Certificate Profile Signer** role on that account.

| Name                  | Kind                 | Value                                                                                         |
| --------------------- | -------------------- | --------------------------------------------------------------------------------------------- |
| `AZURE_SIGN_ENDPOINT` | variable (or secret) | Account endpoint, for example `https://weu.codesigning.azure.net`                             |
| `AZURE_SIGN_ACCOUNT`  | variable (or secret) | Trusted Signing account name                                                                  |
| `AZURE_SIGN_PROFILE`  | variable (or secret) | Certificate profile name                                                                      |
| `AZURE_TENANT_ID`     | secret               | Directory (tenant) ID of the app registration                                                 |
| `AZURE_CLIENT_ID`     | secret               | Application (client) ID                                                                       |
| `AZURE_CLIENT_SECRET` | secret               | Client secret of the app registration                                                         |
| `WIN_PUBLISHER_NAME`  | variable, optional   | Certificate subject CN when it is not exactly `Synapse Solutions` (the company in brand.json) |

The publisher name must match the certificate subject, because "Install update from file" checks that the signer names the company.

### B. Certificate file (.pfx)

Only for a certificate that may live in a file (OV certificates issued since June 2023 live in hardware; use A or C for those).

| Name                   | Kind   | Value                                                                                   |
| ---------------------- | ------ | --------------------------------------------------------------------------------------- |
| `WIN_CSC_LINK`         | secret | The `.pfx` as base64 (`[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))`) |
| `WIN_CSC_KEY_PASSWORD` | secret | Its password                                                                            |

### C. Cloud HSM command

`WIN_SIGN_COMMAND` (variable): a command template with `{file}`, for example DigiCert KeyLocker `smctl sign --keypair-alias=... --input {file}`. Its client must be installed and logged in by an extra workflow step; see `tools/release/win-sign.mjs`.

The Microsoft Store package is never signed by us: Microsoft signs it during certification, and the build drops every Windows signing variable for it.

## macOS

Needs an Apple Developer Program membership (organisation) and a **Developer ID Application** certificate.

| Name                   | Kind   | Value                                                                                          |
| ---------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| `MAC_CSC_LINK`         | secret | Developer ID Application certificate and key exported as `.p12`, base64 (`base64 -i cert.p12`) |
| `MAC_CSC_KEY_PASSWORD` | secret | The `.p12` password                                                                            |

`CSC_LINK` / `CSC_KEY_PASSWORD` are accepted as aliases for the two above; they are only ever passed to the macOS jobs.

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

Already in `packages/brand/brand.json` (public values from Partner Center). The variables `STORE_IDENTITY_NAME`, `STORE_PUBLISHER`, `STORE_PUBLISHER_DISPLAY_NAME` override it; none is needed.
