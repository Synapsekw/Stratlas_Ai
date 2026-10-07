# Founder setup guide: accounts and certificates for Stratlas 1.0

For the founder of Synapse Solutions (Kuwait). This guide covers the outside accounts, certificates and decisions that the 1.0 release needs: founder blockers B1 to B6 in [CHECKLIST-1.0.md](CHECKLIST-1.0.md). You do not need to be a release engineer. Each section says what to click, what to type, what it costs, how long it takes and what to send back to us.

_Facts checked on 7 October 2026. Exchange rate used: 1 USD = 0.310 KWD (7 Oct 2026, [currencyconvert.online](https://currencyconvert.online/usd/kwd)). KWD figures are rounded. Vendors change prices and menu labels; if a label differs slightly, look for the nearest match._

**Three rules for the whole guide**

1. **Never paste a secret in chat or email,** not to us and not to anyone else. Secrets (passwords, private keys, `.p12`, `.p8` and `.pfx` files, API keys, client secrets) go straight into GitHub, as described in [section 8](#8-adding-secrets-and-variables-to-github). You send us only the public values listed under "What to send back".
2. **Keep a private, offline copy** of every file and password in a password manager (for example 1Password or Bitwarden) under a "Stratlas release" folder. Several of these are shown only once.
3. **"Check:"** marks something we could not confirm from an official source, or that depends on Kuwait. Confirm it when you reach that step and tell us if it differs.

---

## Overview

| #   | Item                                                            | Why we need it                                                                                              | Cost (USD, approx. KWD)                                                                 | Time to get                                                                       | Blocks                                            | Start first?                                 |
| --- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------- |
| 0   | Company document pack and D-U-N-S number                        | Every vendor below checks the same company facts. D-U-N-S is required by Apple and speeds up the others     | Free                                                                                    | D-U-N-S: about 7 business days (Apple's figure); Kuwait can take longer           | Apple (B4); speeds up Windows (B2) and Store (B3) | **Yes, day 1**                               |
| 1   | Windows code signing (B2): OV certificate in DigiCert KeyLocker | Signs the website installer and portable exe so Windows trusts them and in-app updates can check the signer | $996 a year (KWD 309)                                                                   | 1 to 3 weeks (order, company checks, phone call)                                  | Signed Windows installer for our website, RC1     | **Yes, day 1** (after the document pack)     |
| 2   | Microsoft Partner Center company account and Store name (B3)    | Publishing in the Microsoft Store                                                                           | Free (company accounts have been free since May 2026)                                   | Confirm existing account: 1 hour. New company account: 2 to 5 business days       | Store submission, final MSIX identity             | **Yes, day 1** (confirm what already exists) |
| 3   | Apple Developer Program, organisation (B4)                      | Developer ID certificate and notarisation, so macOS opens the app without warnings                          | $99 a year (KWD 31)                                                                     | 1 to 3 weeks after D-U-N-S arrives                                                | Signed and notarised macOS build, RC1             | After D-U-N-S                                |
| 4   | Cosign signing for the Team Server image (B5)                   | Customers can prove the server image came from us                                                           | Free                                                                                    | 5 minutes (a decision)                                                            | Team Server leaving preview                       | Any time                                     |
| 5   | External penetration test of the Team Server (B6)               | Independent security check before the server leaves preview; procurement teams will ask for it              | Typically $8,000 to $25,000 (KWD 2,500 to 7,750)                                        | Quotes 1 to 2 weeks; booking lead time 2 to 6 weeks; test and report 2 to 3 weeks | `HostingModel.server` leaving `preview`           | **Yes, request quotes in week 1**            |
| 6   | Final product name (B1)                                         | Store listing, installers, About box, docs                                                                  | Searches free; Kuwait trademark filing: official fees plus agent fees (ask for a quote) | Searches: 1 to 2 days. Kuwait trademark registration: about 5 to 7 months         | Store listing, final `brand.json`, RC1            | **Yes, searches in week 1**                  |
| 8   | GitHub secrets                                                  | The release build reads every certificate and key from here                                                 | Free                                                                                    | 10 minutes per item                                                               | All signed builds                                 | As each item arrives                         |

**Not needed from you:** a certificate for the Microsoft Store package. Microsoft signs the MSIX during certification ([Microsoft Learn: MSI/EXE package requirements, FAQ](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements)). Our certificate is only for the installer and portable exe we offer on our own website.

## Recommended order

Long-lead items start in parallel on day 1.

**Day 1 (about 3 hours in total)**

- [ ] Section 0: collect the company document pack (1 hour).
- [ ] Section 0: request the D-U-N-S number through Apple's free tool (20 minutes). This is the slowest item; everything Apple waits for it.
- [ ] Section 2, part A: sign in to Partner Center and confirm the existing account and Store name (1 hour).
- [ ] Section 1: order the DigiCert OV code-signing certificate with KeyLocker (30 minutes). Validation starts at once.

**Week 1**

- [ ] Section 6: run the name searches and decide the product name, or confirm "Stratlas" (2 to 4 hours).
- [ ] Section 5: send the penetration test brief to two or three firms for quotes (1 hour).
- [ ] Section 4: tick the cosign decision (5 minutes).
- [ ] Answer the certificate authority's phone call and emails as they come.

**Weeks 2 to 3**

- [ ] Section 3: enrol in the Apple Developer Program as soon as the D-U-N-S number arrives; then create the Developer ID certificate and notarisation key.
- [ ] Section 1: when the certificate is issued, create the KeyLocker access credentials and add them to GitHub.
- [ ] Section 5: choose a test firm and book a date.
- [ ] Send us the dates for B2 to B6 (blocker B8) so the 1.0 checklist can show them.

---

## 0. Company document pack and D-U-N-S number

Every vendor in this guide checks the same facts about Synapse Solutions: legal name, address, phone, website and who may act for the company. If the facts match everywhere, approvals are quick. If the English legal name differs by one word between documents, expect delays.

### You need

- Commercial registration certificate (commercial licence) from the Ministry of Commerce and Industry (MOCI), current, issued or reissued within the last 12 months if possible.
- Kuwait Chamber of Commerce and Industry membership certificate (useful as extra proof of existence and address).
- Articles of association or the document that names the authorised signatory.
- An English translation of each Arabic document. Check: some certificate authorities and Apple may ask for a certified (sworn) translation, or for notarised documents. Ask a sworn translator for a quote now so you are not waiting later.
- Your passport or Kuwait Civil ID (Apple and some authorities verify the person acting for the company).
- A public company phone number that you answer, ideally a landline listed in a public directory (Kuwait Chamber directory, Google Business Profile, D-U-N-S record).
- The live company website, `synapse-solutions.ai`, with the company name, address and phone in the footer or on a Contact page. Apple rejects placeholder pages and social media links ([Apple: enrolment](https://developer.apple.com/programs/enroll/)).
- An email address on that domain for yourself (for example `founder@synapse-solutions.ai`). Gmail or Outlook.com addresses are refused by Microsoft and Apple ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account?tabs=company), [Apple](https://developer.apple.com/programs/enroll/)).

### Steps

- [ ] Write down the company's **exact English legal name** as it should appear everywhere, for example `Synapse Solutions Company W.L.L.` (use your real one). Use it letter for letter in every form below.
- [ ] Write down the registered address in English, exactly as on the commercial registration.
- [ ] Scan each document to PDF (colour, all pages) into one folder `Company pack`.
- [ ] Order sworn English translations of the Arabic documents (1 to 3 days, typically a small fee per page).
- [ ] Check that the website shows the legal name, address and phone, and that it loads over HTTPS.
- [ ] Check that your `@synapse-solutions.ai` mailbox receives external mail (send yourself a test from a personal account).
- [ ] Go to Apple's D-U-N-S page, [developer.apple.com/support/D-U-N-S](https://developer.apple.com/support/D-U-N-S/), and click the lookup tool link. Sign in with an Apple Account (create one with your company email if you have none; turn on two-factor authentication when asked).
- [ ] Enter the legal entity name, headquarters address, mailing address and your work contact details. Click **Check**.
- [ ] If Apple finds a record: check that the name and address are exactly right. If they are wrong, ask D&B to correct them (Apple shows the link). Note the 9-digit number.
- [ ] If Apple finds nothing: click **Submit** to request a free number from D&B. Note the request reference.
- [ ] Wait. Apple says D&B takes up to 5 business days and then up to 2 more business days before Apple can see the number ([Apple: D-U-N-S](https://developer.apple.com/help/account/membership/D-U-N-S/)). If nothing arrives after 2 weeks, contact D&B through [support.dnb.com/?CUST=APPLEDEV](https://support.dnb.com/?CUST=APPLEDEV).
- [ ] When the number arrives, save it in the password manager note (it is not secret, but you will type it several times).

Time: 1 to 2 hours of your work, then 1 to 4 weeks of waiting.

Check: D&B in Kuwait is served by Dun & Bradstreet South Asia Middle East ([dnbsame.com](https://dnbsame.com/db-d-u-n-s-number)). Third-party sites report that some countries take up to 30 business days. If D&B calls or emails asking for documents, answer the same day.

### What to send back

- The D-U-N-S number and the exact English legal name (both public; chat or email is fine).

### Common problems

- **Name mismatch.** D&B lists a trade name, Apple and the certificate authority expect the legal name. Fix the D&B record first.
- **Branch or trade name.** Apple does not accept branches, trade names or sole proprietorships; it must be the legal entity ([Apple: D-U-N-S](https://developer.apple.com/support/D-U-N-S/)).
- **Old documents.** Some validators want documents issued within the last 12 months.

---

## 1. Windows code signing (B2)

### What this is

Windows shows a red "Unknown publisher" warning for an unsigned installer, and our own "Install update from file" refuses an installer whose signer does not name the company. A code-signing certificate fixes both. Since June 2023 the private key of every public code-signing certificate must live in tamper-proof hardware: a USB token or a cloud HSM ([Entrust summary of the CA/Browser Forum rule](https://www.entrust.com/blog/2022/09/ca-browser-forum-updates-requirements-for-code-signing-certificate-private-keys/)). Our builds run on GitHub's servers, so we need a **cloud HSM**, not a USB token.

Since 1 March 2026 a code-signing certificate lasts at most 460 days, so a "3-year" purchase is a prepaid subscription with a free reissue each year ([CA/Browser Forum ballot CSC-31](https://cabforum.org/2025/11/17/ballot-csc-31-maximum-validity-reduction)).

### How our build chooses

`release.yml` and `brand-config.mjs` try three routes in this order, and the first one with its values set wins ([SECRETS.md](SECRETS.md)):

| Order | Route                                    | What it needs in GitHub                                                                                                                              | Fit for us                                                                |
| ----- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| A     | Azure Trusted Signing (Artifact Signing) | `AZURE_SIGN_ENDPOINT`, `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `WIN_PUBLISHER_NAME` | **Not available to a Kuwaiti company today** (see below)                  |
| B     | Certificate file (`.pfx`)                | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`                                                                                                               | Not possible: new OV certificates cannot be exported to a file            |
| C     | Cloud HSM command                        | `WIN_SIGN_COMMAND` (variable) plus the provider's own credentials                                                                                    | **Our route: DigiCert KeyLocker (primary) or SSL.com eSigner (fallback)** |

### Why not Azure Artifact Signing (route A)

Microsoft renamed Trusted Signing to **Artifact Signing**. It is the cheapest option (Basic $9.99 a month, about KWD 3.10, with 5,000 signatures a month, [Azure pricing](https://azure.microsoft.com/pricing/details/artifact-signing/), [Azure retail price list](<https://prices.azure.com/api/retail/prices?$filter=contains(productName,'Signing')>)). But public-trust certificates are only issued to organisations in the United States, Canada, the EU, the United Kingdom, Australia, New Zealand, Japan, South Korea, Singapore, Switzerland, Norway and Israel ([Microsoft Learn: Artifact Signing quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)). Kuwait and the other GCC countries are not on the list. Microsoft staff also said in 2025 that organisations need at least 3 years of verifiable business history ([Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/2243504/trusted-signing-for-other-countries)); the 2026 docs no longer say so.

- Check: only if Synapse Solutions owns a company registered in one of those countries (for example a UK or EU subsidiary with 3 years of history) can it use route A. Tell us if so; it would save about $870 a year. Otherwise skip route A.
- Check: Microsoft says it is working on more countries but gives no date. We will re-check at each yearly renewal.

### OV or EV?

**OV is enough.** Microsoft now states that EV certificates no longer bypass SmartScreen, and that paying extra for EV only to avoid SmartScreen warnings is no longer justified ([Microsoft Learn: SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)). With either type, the first releases show "Windows protected your PC" until enough people have installed them without trouble; reputation builds over weeks and carries over to new versions signed with the same certificate (same page). So: sign every release with the same certificate and do not switch vendors without need.

### Options compared

| Option                                                         | Price (checked 7 Oct 2026)                                                                                                                                                                                                                                               | How it signs in CI                                                                                                                                                                                                                                                                                                                                       | Notes                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DigiCert OV + KeyLocker (recommended)**                      | $996 a year (KWD 309), includes 1,000 signatures a year ([DigiCert compare page](https://www.digicert.com/cn/signing/compare-code-signing-certificates), [KeyLocker licensing](https://docs.digicert.com/en/digicert-keylocker/overview/licensing.html))                 | KeyLocker tools on the GitHub runner, then Microsoft `signtool` with DigiCert's key provider. Logs in with an API key and a client certificate; no phone code ([DigiCert GitHub guide](https://docs.digicert.com/en/digicert-keylocker/ci-cd-integrations-and-deployment-pipelines/scripts/github/scripts-for-signing-using-ksp-library-on-github.html)) | Official GitHub scripts; fits our route C directly (`tools/release/win-sign.mjs` already names KeyLocker). Hard limit of 1,000 signatures a year; more are sold in blocks of 1,000                                                                                         |
| **SSL.com OV + eSigner (fallback)**                            | Certificate $129 a year (KWD 40) plus eSigner: $180 a year for 20 signings a month, $765 a year for 100 a month ([SSL.com OV](https://ssl.com/products/software-integrity/code-signing/ov/), [eSigner pricing](https://ssl.com/guide/esigner-pricing-for-code-signing/)) | SSL.com's GitHub Action or CodeSignTool; logs in with username, password, credential ID and a one-time-code (TOTP) secret ([SSL.com action](https://github.com/SSLcom/esigner-codesign))                                                                                                                                                                 | Cheaper to start. We would need the 100-a-month tier ($894 a year in total, KWD 277). Unattended signing stores your TOTP secret in GitHub                                                                                                                                 |
| OV certificate on Azure Key Vault Premium (your own cloud HSM) | Certificate from GlobalSign or DigiCert (DigiCert OV "own HSM" $696 a year, KWD 216) plus a few dollars a month for the HSM key ([Azure Key Vault pricing](https://azure.microsoft.com/en-us/pricing/details/key-vault/))                                                | AzureSignTool or jsign with an Azure app registration                                                                                                                                                                                                                                                                                                    | No signature limit. More Azure setup for you; GlobalSign documents it ([GlobalSign guide](https://support.globalsign.com/code-signing/code-signing/code-signing-certificate-setup-azure-key-vault)). Check: whether the chosen authority demands Key Vault key attestation |
| Certum code signing in the cloud (SimplySign)                  | From about EUR 209 ([Certum shop](https://shop.certum.eu/standard-code-signing-in-the-cloud.html))                                                                                                                                                                       | Needs the SimplySign phone app; CI use only through an unofficial workaround                                                                                                                                                                                                                                                                             | Not recommended for CI                                                                                                                                                                                                                                                     |
| Sectigo cloud signing                                          | Not checked                                                                                                                                                                                                                                                              | Not checked                                                                                                                                                                                                                                                                                                                                              | Check: not researched; skip unless a reseller offers a documented GitHub Actions route                                                                                                                                                                                     |

### Recommendation

**Primary: DigiCert OV code signing with KeyLocker.** It is built for unattended signing on GitHub's Windows runners (API key plus client certificate, no phone codes), DigiCert publishes the GitHub workflow we need, and our build already has the hook for it (route C). DigiCert is also the timestamp server we use.

**Fallback: SSL.com OV with eSigner** if DigiCert's validation stalls or the price is a problem. Same route C; only the command and credentials differ.

**About signature counts.** Every file inside the installer that we sign counts as one signature (the app exe, helper exes, the uninstaller, the installer and the portable exe). Check: we estimate 10 to 20 signatures per Windows build and will measure the real number on the first signed run. Our nightly workflow currently signs too whenever the secrets exist, which would use several hundred signatures a month. **We will limit signing to release builds** before adding the secrets, so 1,000 a year covers about one release a week.

### You need

- The document pack from section 0 (commercial registration, translation, Chamber certificate, D-U-N-S number if you have it).
- A company credit card for $996 (or $129 plus the eSigner plan for SSL.com).
- Someone at the company phone number for the verification call.
- About 1 hour of your time, spread over 1 to 3 weeks.

### Steps (DigiCert KeyLocker)

**Order (30 minutes)**

- [ ] Go to [digicert.com/signing/code-signing-certificates](https://www.digicert.com/signing/code-signing-certificates) and choose **OV Code Signing**.
- [ ] When asked how to store the key, choose **KeyLocker** (cloud). Do not choose the USB token or "install on my own HSM".
- [ ] Choose **1 year** (or the multi-year prepaid option if you prefer; it is reissued every year anyway).
- [ ] Create the DigiCert account with your `@synapse-solutions.ai` email.
- [ ] Organisation details: type the exact English legal name and address from section 0. Enter the D-U-N-S number if the form has a field for it.
- [ ] Organisation contact: you (name, job title, company email, company phone).
- [ ] Pay with the company card. Save the order number.

**Validation (1 to 3 weeks of waiting, 30 minutes of your time)**

- [ ] Watch for DigiCert's emails. Upload the commercial registration, its translation and any other document they ask for, in the order portal.
- [ ] Answer the verification phone call on the company number. DigiCert checks that the number is listed in a public source (D&B, a government registry or a directory). If it is not listed, ask DigiCert whether a **legal or professional opinion letter** from a Kuwaiti lawyer or accountant will do ([summary of what CAs accept](https://codesigningstore.com/documents-required-for-code-signing-certificate-validation)).
- [ ] Approve the final email that confirms you requested the certificate.
- [ ] When DigiCert emails that the certificate is issued, note the **certificate subject (CN)**. It will be your legal name, for example `Synapse Solutions Company W.L.L.`.

Check: whether DigiCert needs a certified translation and whether it accepts the Kuwait Chamber of Commerce record or the MOCI registry as the official source. Ask in your first reply to the validation team.

**Access for GitHub (30 minutes; after issuance)**

DigiCert's names for these screens are in its guide ([DigiCert GitHub guide](https://docs.digicert.com/en/digicert-keylocker/ci-cd-integrations-and-deployment-pipelines/scripts/github/scripts-for-signing-using-ksp-library-on-github.html)); labels may differ slightly.

- [ ] Sign in to **DigiCert ONE**, open **KeyLocker** (also called Software Trust Manager).
- [ ] Under your profile, **API tokens**, create a token named `github-stratlas`. Copy it into the password manager now; it is shown once.
- [ ] Under **Client authentication certificates**, create one named `github-stratlas`. Download the `.p12` file and copy its password into the password manager; the password is shown once.
- [ ] Open **Certificates**, click the code-signing certificate, and note its **SHA-1 thumbprint** and the **keypair alias**.
- [ ] On your Windows PC, turn the client-certificate file into text for GitHub. Open PowerShell in the folder with the file and run (replace the file name):

  ```powershell
  [Convert]::ToBase64String([IO.File]::ReadAllBytes("Certificate_pkcs12.p12")) | Set-Clipboard
  ```

  The text is now on your clipboard; paste it straight into GitHub (next step), not into chat.

- [ ] Add these in GitHub, **Settings, Secrets and variables, Actions** (section 8). These names are the ones DigiCert's GitHub guide uses; we will add the matching install step to `release.yml` and list them in `SECRETS.md`:

  | Name                             | Kind     | Value                                                                                                  |
  | -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
  | `SM_HOST`                        | secret   | The DigiCert ONE host URL shown with the API token (for example `https://clientauth.one.digicert.com`) |
  | `SM_API_KEY`                     | secret   | The API token                                                                                          |
  | `SM_CLIENT_CERT_FILE_B64`        | secret   | The base64 text from the step above                                                                    |
  | `SM_CLIENT_CERT_PASSWORD`        | secret   | The client certificate's password                                                                      |
  | `SM_CODE_SIGNING_CERT_SHA1_HASH` | secret   | The SHA-1 thumbprint                                                                                   |
  | `WIN_PUBLISHER_NAME`             | variable | The certificate subject CN, exactly, for example `Synapse Solutions Company W.L.L.`                    |

- [ ] Leave `WIN_SIGN_COMMAND` to us. We set it once the install step is in, because route C only switches on when it exists.
- [ ] Delete the downloaded `.p12` from your Downloads folder once it is in GitHub and the password manager.

### Fallback steps (SSL.com eSigner), only if DigiCert fails

- [ ] At [ssl.com](https://ssl.com/products/software-integrity/code-signing/ov/), buy **OV Code Signing**, 1 year, and choose **eSigner cloud signing** as the key storage.
- [ ] Complete validation as above (same documents; SSL.com quotes 3 to 5 days and also needs the requester's photo ID when a company is under 3 years old, [SSL.com validation guide](https://www.ssl.com/guide/d-u-n-s-numbers-and-business-listings-for-code-signing-certificate-validation/)).
- [ ] Enrol the certificate in eSigner. When it shows the QR code, also copy the **secret code** (the TOTP secret) into the password manager. Without it, unattended signing is impossible.
- [ ] Subscribe to the **100 signings a month** eSigner plan (check our real usage after the first release; downgrade if lower).
- [ ] Add as secrets: `ES_USERNAME`, `ES_PASSWORD`, `ES_CREDENTIAL_ID`, `ES_TOTP_SECRET`; and the variable `WIN_PUBLISHER_NAME`. Check: we will confirm these four names with you when we write the step; they follow SSL.com's action inputs.

### What to send back

- In chat or email (public): the vendor chosen, the **certificate subject CN**, the certificate's **expiry date**, and "secrets added" once done.
- In GitHub only: everything in the tables above.

### Common problems

- **Phone number not listed anywhere.** The commonest delay. Add the number to the D-U-N-S record and to a Google Business Profile, or get an opinion letter.
- **Legal name differs** between the order and the commercial registration (for example missing "W.L.L."). Correct the order; do not argue with the validator.
- **Publisher mismatch after signing.** If `WIN_PUBLISHER_NAME` does not equal the certificate CN letter for letter, our update check and the build's signature step fail. Copy the CN, do not retype it.
- **Quota used up.** KeyLocker stops signing at 1,000 a year. We will report usage after each release.
- **SmartScreen still warns** on the first releases. That is expected with OV and EV alike; it fades as people install.

---

## 2. Microsoft Partner Center and the Store name (B3)

Our repository already holds a Store identity: `brand.json` has `identityName` `SynapseSolutions.Stratlas`, `publisher` `CN=93BC08FE-8EF9-44E5-AC18-4B57E9E7759A` and `publisherDisplayName` `Synapse Solutions`, and [STORE-SUBMISSION.md](STORE-SUBMISSION.md) says the name is reserved. So someone has already signed in to Partner Center. **Start by confirming that account,** then do only what is missing.

Costs: company accounts have been **free** since 7 May 2026, as long as you start at [storedeveloper.microsoft.com](https://storedeveloper.microsoft.com) ([Windows Developer blog](https://blogs.windows.com/windowsdeveloper/2026/05/07/publish-to-microsoft-store-as-a-company-now-with-free-registration-and-faster-onboarding/), [Microsoft Learn](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account)). Before that, Kuwait paid a one-time KWD 28.

### Part A: confirm the existing account (about 1 hour)

- [ ] Find out whose login reserved "Stratlas" (ask the team member who added the Store identity on 4 October 2026 if it was not you). Write down the sign-in email, never the password.
- [ ] Sign in at [partner.microsoft.com/dashboard](https://partner.microsoft.com/dashboard) with that login.
- [ ] Click the gear icon, **Account settings**, then **Legal info** (or **Organization profile**). Check the **account type**: it must say **Company**, with the legal name of Synapse Solutions.
- [ ] On the same pages, check that every verification shows **Verified** or **Complete** (email, employment, business). Note any that say pending or failed.
- [ ] Open **Apps and games**, click **Stratlas**, then **Product management**, **Product identity** ([Microsoft Learn: view app identity](https://learn.microsoft.com/en-us/windows/apps/publish/view-app-identity-details)).
- [ ] Compare the three values with `packages/brand/brand.json`:

  | Partner Center field                    | `brand.json` field           | Value now in `brand.json`                 |
  | --------------------------------------- | ---------------------------- | ----------------------------------------- |
  | Package/Identity/Name                   | `store.identityName`         | `SynapseSolutions.Stratlas`               |
  | Package/Identity/Publisher              | `store.publisher`            | `CN=93BC08FE-8EF9-44E5-AC18-4B57E9E7759A` |
  | Package/Properties/PublisherDisplayName | `store.publisherDisplayName` | `Synapse Solutions`                       |

- [ ] Note the date the name was reserved. Microsoft removes a reserved name that is not used in a submission within **3 months** ([Microsoft Learn: reserve your app's name](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/reserve-your-apps-name)). Check: if the reservation was made around 4 October 2026, a first submission (it can be private or hidden) is due by early January 2027.
- [ ] Under **Account settings, User management**, add a second owner or manager (a trusted colleague) so the account does not depend on one person. Use company email addresses only.

**If all of this matches and the account type is Company:** B3 is done apart from the submission itself. Send us the "What to send back" items and skip part B.

**If the account is an Individual account,** or it belongs to someone who is leaving: do part B. Check: whether Microsoft can transfer the reserved product to the new company account; ask Partner Center support (the **?** icon, **Get support**) before reserving a second time.

### Part B: create the company account (only if needed; 1 hour of work, 2 to 5 business days of checks)

- [ ] Go to [storedeveloper.microsoft.com](https://storedeveloper.microsoft.com) and choose to register as a **company**. Microsoft says this is the only supported way in for companies, and the only way to get it free.
- [ ] Sign in with a Microsoft account on your company email, or with a Microsoft Entra work account (if you use Entra, the person who finishes onboarding becomes the owner).
- [ ] Enter the company's legal name, address and phone exactly as in section 0.
- [ ] Business verification: enter the **D-U-N-S number** (fast, automatic). Without one, upload the commercial registration and its translation; that goes to manual review ([Microsoft Learn: company accounts](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account?tabs=company)).
- [ ] Verify your company email (click the link in Microsoft's email).
- [ ] If asked, prove you own `synapse-solutions.ai` with the domain registrar's record or invoice showing purchase and expiry dates.
- [ ] Watch **Verification summary** until all checks show complete (manual reviews take 2 to 5 business days).
- [ ] **Apps and games**, **New product**, **MSIX or PWA app**. Type the product name (from section 6), click **Check availability**, then **Reserve product name**.
- [ ] Open the new product, **Product management**, **Product identity**, and send us the three values.

### Store rules that affect us

These are already handled in [STORE-SUBMISSION.md](STORE-SUBMISSION.md); listed here so you know why.

- **MSIX, not EXE.** We submit the MSIX, which Microsoft signs and hosts. An EXE or MSI submission would need our own certificate and a versioned download link on our site ([Store Policies 10.2.9](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies)).
- **runFullTrust.** Electron apps declare this restricted capability; the justification text is ready in `store-listing/listing.md` ([Microsoft Learn: capability declarations](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations)).
- **Age rating.** A short IARC questionnaire at submission; our answers are in STORE-SUBMISSION.md.
- **Privacy policy URL.** Required; Microsoft names Win32 and Desktop Bridge apps explicitly ([Store Policies 10.5.1](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies)). Publish `store-listing/privacy-policy.md` on `synapse-solutions.ai` before the first submission.
- **Our own commerce (M10).** Non-game PC apps may use their own payment system instead of Microsoft's (Store Policies 10.8.1). Purchases through our own system carry **no Store fee**; Microsoft's commerce would take 15% for apps ([App Developer Agreement v8.11, sections 5e and 6b](https://go.microsoft.com/fwlink/?linkid=528905)). When M10 adds licensing, the submission must declare third-party commerce, and apps that take financial details must use a company account (policy 10.8.3).

### You need

- The Partner Center login (part A), or the document pack and D-U-N-S number (part B).
- No payment.

### What to send back

- In chat or email (public): the account type (Company or Individual), the owner's name, the date the name was reserved, and the three identity values from **Product identity**, copied exactly. If they match `brand.json`, just say "matches".
- Nothing goes into GitHub. The identity values are public and live in `brand.json`; we update the file.

### Common problems

- **Account is Individual.** Its publisher would show a person, and M10 commerce needs a company account. Fix now, before the first submission.
- **Reservation expired.** The name becomes free for anyone after 3 months without a submission. Submit privately or hidden in time.
- **Email domain not accepted.** Use your `@synapse-solutions.ai` address.
- **Name taken.** Reserve the final name from section 6; you can reserve more than one name.

---

## 3. Apple Developer Program as an organisation (B4)

### Do I need a Mac?

- **Enrolment:** no. Do it in a web browser on Windows. (Apple's Developer app on an iPhone or iPad also works for organisations and verifies your passport there; [Apple: enrolling in the app](https://developer.apple.com/help/account/membership/enrolling-in-the-app/).)
- **Developer ID certificate:** no. Apple documents the Mac Keychain route, but you can make the request file and the `.p12` with OpenSSL on Windows (steps below). OpenSSL comes with Git for Windows.
- **Notarisation:** no. Our GitHub build runs on a Mac in the cloud.
- **Testing the result:** yes, someone should open the notarised DMG on a real Mac once per release (the team does this).

### Costs and timing

- **$99 a year** (about KWD 31) ([Apple: enrol](https://developer.apple.com/programs/enroll/)). Apple charges in local currency where it has an online store, otherwise in USD by card. Check: the price and currency shown at checkout for Kuwait (we expect USD).
- **Timing:** D-U-N-S first (section 0), then Apple reviews the organisation. Apple confirms membership within about 24 hours of payment once the review passes ([Apple: enrolment support](https://developer.apple.com/support/enrollment/)). Apple may call to check your authority to sign for the company. Check: no current Apple page promises or rules out a call; keep the company phone answered.

### You need

- The D-U-N-S number and the exact legal name (section 0).
- Authority to bind the company (as founder you have it).
- Your `@synapse-solutions.ai` email and the live website.
- An Apple Account with two-factor authentication.
- A credit card for $99.
- On your Windows PC: Git for Windows (for OpenSSL), from [git-scm.com](https://git-scm.com/download/win) if not installed.

### Steps: enrol (30 minutes, then 1 to 14 days of review)

- [ ] Go to [developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll/) and click **Start your enrollment**.
- [ ] Sign in with the Apple Account you used for the D-U-N-S lookup (company email, two-factor on).
- [ ] Choose **Organization** as the entity type (not Individual).
- [ ] Enter the legal entity name exactly as in the D-U-N-S record, the D-U-N-S number, the website `https://synapse-solutions.ai`, and your work email and phone.
- [ ] Confirm you have legal authority to bind the company.
- [ ] Wait for Apple's email. If Apple asks for documents (some regions need notarised business documents), upload them in the enrolment page.
- [ ] Pay the $99 when Apple asks.
- [ ] When the welcome email arrives, sign in at [developer.apple.com/account](https://developer.apple.com/account), click **Membership details** and note the **Team ID** (10 characters) ([Apple: Team ID](https://developer.apple.com/help/glossary/team-id)).

### Steps: Developer ID Application certificate (45 minutes, Windows)

Only the **Account Holder** (you) can create Developer ID certificates ([Apple: create Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)). We need **Developer ID Application** only. **Developer ID Installer** is for `.pkg` installers, which we do not ship (we ship DMG and ZIP).

- [ ] Make a private folder, for example `C:\Users\<you>\Documents\apple-signing`, outside any synced or shared drive.
- [ ] Open **Git Bash** (Start menu) and go to the folder:

  ```bash
  cd ~/Documents/apple-signing
  ```

- [ ] Create the private key and the certificate request (replace the email and name; keep the quotes):

  ```bash
  openssl genrsa -out developerid.key 2048
  openssl req -new -key developerid.key -out developerid.csr -subj "/emailAddress=founder@synapse-solutions.ai/CN=Synapse Solutions/C=KW"
  ```

  `developerid.key` is the private key. Never send it to anyone; it stays in this folder and the password manager.

- [ ] In the browser: [developer.apple.com/account](https://developer.apple.com/account), **Certificates, IDs & Profiles**, **Certificates**, the **+** button.
- [ ] Choose **Developer ID Application**, click **Continue**.
- [ ] For profile type choose **G2 Sub-CA (Xcode 11.4.1 or later)**.
- [ ] Upload `developerid.csr`, click **Continue**, then **Download**. You get `developerID_application.cer`; move it into the same folder.
- [ ] Back in Git Bash, combine the certificate and key into a `.p12` (it asks for an export password twice; make a long one and save it in the password manager):

  ```bash
  openssl x509 -inform DER -in developerID_application.cer -out developerid.pem
  openssl pkcs12 -export -inkey developerid.key -in developerid.pem -out developerid.p12 -name "Developer ID Application" -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
  ```

  The last three options make a `.p12` that the Mac keychain on GitHub's runners can read.

- [ ] Turn the `.p12` into text for GitHub, in **PowerShell** (not Git Bash):

  ```powershell
  [Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Documents\apple-signing\developerid.p12")) | Set-Clipboard
  ```

- [ ] In GitHub add secret `MAC_CSC_LINK` and paste. Add secret `MAC_CSC_KEY_PASSWORD` with the export password (section 8).
- [ ] Note the certificate's expiry date shown on Apple's certificate page and add a calendar reminder 1 month before it.

Check: Apple documents only the Keychain route; the OpenSSL route above is common practice (for example [this write-up](https://dev.to/byk/nightmare-on-apple-street-2apc)). The first signed build will prove it. If the build says the identity is not found, we will ask you to redo the `.p12` export with us on a call, without sharing the file.

### Steps: notarisation key (20 minutes, plus Apple's approval of API access)

Our build supports two ways; set **only one**. If both are set, electron-builder uses the Apple ID route first.

**Preferred: App Store Connect API key** ([Apple: App Store Connect API](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/))

- [ ] Sign in at [appstoreconnect.apple.com](https://appstoreconnect.apple.com) as the Account Holder.
- [ ] **Users and Access**, tab **Integrations**, **App Store Connect API**. If you see **Request Access**, click it and accept the terms. Apple reviews this; it can take a few days.
- [ ] When access is granted, open **Team Keys**, click **+** (Generate API Key).
- [ ] Name: `github-notarise`. Access: **Developer**. Click **Generate**.
- [ ] Note the **Issuer ID** (shown above the key list) and the **Key ID** (in the key's row).
- [ ] Click **Download API Key**. You get `AuthKey_<KeyID>.p8`. **Apple lets you download it only once.** Store it in the password manager.
- [ ] In GitHub add secrets: `APPLE_API_KEY_P8` (open the `.p8` in Notepad, copy everything including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines, and paste), `APPLE_API_KEY_ID` (the Key ID) and `APPLE_API_ISSUER` (the Issuer ID).

Check: Apple's forums report that the Developer access level is enough for notarisation; Apple's own page does not say so. If the first notarisation fails with a permissions error, make a new key with **App Manager** access and replace the three secrets.

**Alternative: Apple ID with an app-specific password** (use only if API access is refused or slow)

- [ ] At [account.apple.com](https://account.apple.com), **Sign-In and Security**, **App-Specific Passwords**, create one named `github-notarise`.
- [ ] Add secrets `APPLE_ID` (the Apple Account email), `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` (from Membership details).
- [ ] Note: if that Apple Account's password changes, notarisation keeps working, but if the app-specific password is revoked it stops.

### What to send back

- In chat or email (public): the **Team ID**, the certificate's **expiry date**, which notarisation method you used, and "secrets added".
- In GitHub only: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, and either `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
- Nothing changes in `brand.json` for Apple. (`appId` `ai.synapse-solutions.stratlas` is our own bundle identifier; Developer ID apps do not register it with Apple.)

### Common problems

- **"Your organisation's D-U-N-S number could not be verified".** The legal name or address in the enrolment differs from D&B. Fix D&B, wait 2 business days, retry.
- **Website rejected.** The site must be public, on the company domain, and not a placeholder.
- **The `.p8` was lost.** It cannot be downloaded again. Revoke the key in App Store Connect and make a new one.
- **"Developer ID" option greyed out.** Only the Account Holder can create it; sign in as the Account Holder.
- **Five-certificate limit.** Apple allows 5 Developer ID Application certificates; do not make test ones.

---

## 4. Cosign signing for the Team Server image (B5)

### Where we are

No workflow builds or signs the Team Server Docker image yet. When we add that job, it will sign each image with **cosign** (Sigstore) so a customer can check that the image came from our GitHub repository and was not altered. Your only action is the decision below; the team writes the signing step.

### The choice, simply

|                        | Keyless (recommended)                                                                                                                                                                                                                      | Key pair                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| How it works           | GitHub proves to Sigstore which repository and workflow built the image; Sigstore issues a 10-minute certificate and records the signature in a public log ([Sigstore CI quickstart](https://docs.sigstore.dev/quickstart/quickstart-ci/)) | We make a private key once; it lives in a GitHub secret; customers check against our public key file |
| Secrets to guard       | None                                                                                                                                                                                                                                       | A private key and its password, forever                                                              |
| What a customer checks | "Signed by `github.com/Synapsekw/Stratlas_Ai`, release workflow"                                                                                                                                                                           | "Signed by the holder of `cosign.pub`"                                                               |
| Privacy                | The repository name and workflow go into a public log. Our repository is already public, so nothing new is revealed                                                                                                                        | Nothing public                                                                                       |
| If something leaks     | Nothing long-lived to leak                                                                                                                                                                                                                 | A leaked key lets anyone sign as us until we rotate it and tell customers                            |
| Cost                   | Free                                                                                                                                                                                                                                       | Free                                                                                                 |

**Recommendation: keyless.** There is no key for you to create, store or rotate. One point to know: the signature names the repository path. Our repository belongs to the personal GitHub account `Synapsekw`. If you plan to move it into a GitHub organisation (see section 6), do that **before** the first signed image, or customers' check commands will change.

### Steps (5 minutes)

- [ ] Decide: **keyless** or **key pair**. Tick one and tell us:
  - [ ] Keyless from GitHub Actions (recommended).
  - [ ] Key pair stored in GitHub secrets (then we will send you a short extra section to create it on your PC).
- [ ] Decide whether the repository stays under `Synapsekw` or moves to an organisation (section 6) before the first signed image.

### You need

- Nothing to buy.

### What to send back

- In chat: "keyless" or "key pair", and where the repository will live.

### Common problems

- **Repository moved after signing.** Old images still verify against the old path; new ones against the new. We will document both in `docs/server/README.md`.
- **Air-gapped customers.** Checking a keyless signature normally needs internet access once; we will document an offline check when we write the step. Check: offline verification with a saved Sigstore bundle, to be confirmed when we build it.

---

## 5. External penetration test of the Team Server (B6)

### What this is

An outside security firm attacks a test copy of the Team Server the way a hacker would and writes a report. The server stays labelled **preview** until this is done and its serious findings are fixed (decision 14). Procurement teams at large clients often ask for the report summary or an attestation letter.

### Scope to give the firms

Copy this into your request for quotes:

> We are Synapse Solutions (Kuwait). We need a grey-box penetration test of our self-hosted Team Server: a Docker image run with Docker Compose behind TLS, with a Postgres database. Clients talk to it over an HTTPS API where every request is signed by a device key (HTTP Message Signatures, RFC 9421, Ed25519); there are no passwords or bearer tokens. In scope: the API and enrolment (invite codes), role enforcement between owner, reviewer, viewer and client, storage of project files, the container and Compose configuration, TLS settings, the database permissions, rate limits and logging. We provide the Compose file, the admin guide, a test server on our infrastructure, test accounts for each role and a desktop client build. Source code access available on request. We need a report with an executive summary, findings rated with CVSS, reproduction steps and fixes, plus one retest of fixed findings and a short attestation letter we can share with clients. Please quote fixed price, tester-days, earliest start date and the testers' certifications.

### Costs and timing (indicative)

- A web application or API test of this size: about **$8,000 to $25,000** (KWD 2,500 to 7,750); small narrow tests start near $5,000 and broad ones reach $30,000 ([Blaze Information Security](https://www.blazeinfosec.com/post/how-much-does-penetration-testing-cost/), [DeepStrike](https://deepstrike.io/blogs/penetration-testing-cost)). Retesting is often priced separately; ask for it in the quote.
- Effort: about 5 to 10 tester-days. Calendar: 1 to 2 weeks for quotes, 2 to 6 weeks until a slot, 1 to 2 weeks of testing, about 1 week for the report, then the retest after we fix.

### How to choose (vendor-neutral)

- [ ] The company is **CREST accredited** for penetration testing (search [marketplace.crest.org](https://marketplace.crest.org/)), or its testers hold **OSCP** or **OSWE**, or CREST **CRT** or **CCT**.
- [ ] It sends a **sample report** (anonymised) before you sign. Look for clear severity ratings and fix advice a developer can follow.
- [ ] The quote includes **one retest** and an **attestation letter**.
- [ ] It signs an NDA and written **rules of engagement** (dates, test server address, no testing of client systems, how to stop the test).
- [ ] It carries professional liability insurance.
- [ ] It has tested APIs before (ask for one reference).
- [ ] Optional: GCC presence and Arabic-speaking staff if you want the summary in Arabic for clients.

Kuwait has no national accreditation scheme for penetration testers that we could find; Dubai (DESC) and Qatar (NCSA) do. Check: ask Kuwait's National Cyber Security Center whether one has started since its 2026 national controls ([RSM Kuwait note](https://www.rsm.global/kuwait/node/282)).

**Examples, not endorsements** (all CREST-listed, checked 7 Oct 2026):

- DTS Solution (UAE, part of Beyon Cyber; serves Kuwait) ([CREST listing](https://marketplace.crest.org/supplier/dts-solution/)).
- GBM, Gulf Business Machines (offices in Kuwait; CREST and Dubai DESC accredited) ([Zawya](https://www.zawya.com/en/press-release/companies-news/gbm-sets-new-industry-standards-with-dual-crest-and-desc-cybersecurity-accreditation-q935jbsm)).
- NCC Group (international; CREST member since 2008) ([CREST listing](https://www.crest-approved.org/member_companies/ncc-group)).

### Steps

- [ ] Ask the team for the current Compose file, `docs/server/README.md` and a date when the test server will be ready (we prepare it; 1 to 2 days of our work).
- [ ] Send the scope text above to two or three firms (1 hour).
- [ ] Compare quotes on price, tester-days, retest, certifications and earliest date.
- [ ] Sign the contract, the NDA and the rules of engagement.
- [ ] Give the firm the test server address, the test accounts (we create them) and a team contact for the test days.
- [ ] When the report arrives, share it with the team (it is confidential, but not a secret like a key; send it by email to the team only).
- [ ] After we fix the findings, book the retest and collect the attestation letter.

### You need

- A budget of about $8,000 to $25,000.
- A signed purchase order or contract.

### What to send back

- The chosen firm, the test dates, the report and the attestation letter (by email to the team).

### Common problems

- **Testing a live client server.** Never; only our own test server.
- **No retest in the quote.** Then the report shows open findings forever. Insist on one retest.
- **A scan sold as a test.** An automated scan alone is not a penetration test. Ask how many days a person spends testing by hand.

---

## 6. The final product name (B1)

"Stratlas" is a temporary name (`"temporary": true` in `brand.json`). File formats do not carry the name, so changing it later is cheap in code, but it is not cheap in the Store, on the website or with customers. Decide before RC1.

### Steps: checks before you commit (2 to 4 hours, free)

- [ ] **Trademarks, worldwide.** Search the name in [WIPO Global Brand Database](https://branddb.wipo.int). Filter to **Nice classes 9** (downloadable software) and **42** (software services). Note any identical or very similar names.
- [ ] **United States.** Search [USPTO Trademark Search](https://tmsearch.uspto.gov/search/search-information) (it replaced TESS in 2023).
- [ ] **European Union.** Search [EUIPO eSearch plus](https://euipo.europa.eu/eSearch/) and [TMview](https://www.tmdb.tmview.org) (TMview also covers many national offices).
- [ ] **Kuwait.** Use the Ministry of Commerce and Industry trademark e-services ([e.gov.kw: MOCI trademark services](https://e.gov.kw/sites/kgoenglish/Pages/eServices/MOCI/TrademarkRegistrationServices.aspx)) or ask a local trademark agent to run a search. Check: we found no free public search; an agent search costs a small fee.
- [ ] **Domains.** Check availability of the `.com`, `.ai` and `.com.kw` names at any registrar. A `.com.kw` needs a commercial licence that matches the name and costs KWD 15 a year through a CITRA-accredited registrar ([CITRA: .kw domains](https://citra.gov.kw/sites/en/Pages/KuwaitDomainKw.aspx)).
- [ ] **Microsoft Store.** In Partner Center, **Apps and games**, **New product**, type the name, click **Check availability** (do not reserve until you decide).
- [ ] **Apple.** Search the Mac App Store and App Store for apps with the same name. (Developer ID apps outside the Mac App Store need no name reservation; this check is about confusion, not rules.)
- [ ] **GitHub.** Check whether `github.com/<name>` is free for an organisation. Consider creating a free GitHub organisation for the company and moving the repository into it before the first signed release (this affects the cosign identity in section 4).
- [ ] **Search engines and social media.** Search the name with "software", "drone", "inspection" and "survey". Avoid a name a competitor or large company already uses in our field.
- [ ] Decide. Then reserve: the domain, the Store name (Partner Center, **Reserve product name**) and the GitHub organisation, on the same day.

### Kuwait trademark registration (recommended, slow)

- Kuwait has not joined the Madrid Protocol (the only GCC state outside it; Saudi Arabia joins on 8 October 2026), so a Kuwaiti mark needs a national filing ([Asia IP](https://asiaiplaw.com/sector/trademarks/saudi-arabias-madrid-protocol-accession-reshapes-middle-east-trademark-strategy)).
- The application is published in three issues of the Al-Kuwait Al-Youm gazette, followed by a 60-day opposition period. A legalised power of attorney and certificate of incorporation are due within 3 months of filing, so in practice you use a local agent ([Ladas & Parry](https://ladas.com/news/trademark-office-kuwait-ushers-new-procedural-changes/)). Expect about 5 to 7 months to registration.
- [ ] Ask a Kuwaiti trademark agent for a quote for classes 9 and 42. Check: official fees are small (a few tens of KWD per class); agent fees are the main cost.
- [ ] Optional, later: file abroad (for example the EU, the US, Saudi Arabia, UAE) through Madrid from another office, or nationally, depending on where you sell.

### What we change in `brand.json` once you decide

You send the name; we make the change. For reference:

| Field                                                                 | Now                             | Becomes                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `productName`                                                         | `Stratlas`                      | The final name, as shown to users                                                                        |
| `executableName`                                                      | `Stratlas`                      | The name without spaces                                                                                  |
| `appId`                                                               | `ai.synapse-solutions.stratlas` | `ai.synapse-solutions.<name>` (lower case). Change before 1.0; after 1.0 it would move settings on macOS |
| `urlScheme`                                                           | `stratlas`                      | The name in lower case (links like `<name>://`)                                                          |
| `company`                                                             | `Synapse Solutions`             | Unchanged, unless you want the full legal name shown                                                     |
| `temporary`                                                           | `true`                          | `false`                                                                                                  |
| `store.identityName`, `store.publisher`, `store.publisherDisplayName` | From Partner Center             | Unchanged if you reserve the new name under the existing product; new values if you create a new product |

Check: if you keep the existing Store product and add the new name to it (**Product management**, **Manage app names**), the package identity name stays `SynapseSolutions.Stratlas`. Users never see it, so that is fine. Confirm in Partner Center when you reserve.

### What to send back

- In chat: the final name, the domain you registered, the GitHub organisation (if any), and "Store name reserved".

### Common problems

- **Name free as a domain but taken as a trademark** in software. Choose another name; a later dispute costs far more.
- **Arabic transliteration.** Check that the name reads well and has no unwanted meaning in Arabic.
- **Reserving too late.** Someone else can reserve the Store name or domain the day after you search.

---

## 7. Summary of what goes where

| Value                                                      | Where it goes                                                   | How to send it                   |
| ---------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------- |
| D-U-N-S number, legal name                                 | Our records                                                     | Chat or email                    |
| Windows certificate subject CN                             | GitHub variable `WIN_PUBLISHER_NAME`, and tell us               | You add it; tell us in chat      |
| DigiCert `SM_*` values                                     | GitHub secrets                                                  | You add them; never in chat      |
| Store identity (three values)                              | `brand.json` (we edit)                                          | Chat or email                    |
| Apple Team ID                                              | Our records (and `APPLE_TEAM_ID` if you use the Apple ID route) | Chat; secret only for that route |
| `.p12` (base64) and password, notarisation key or password | GitHub secrets                                                  | You add them; never in chat      |
| Cosign decision                                            | Our workflow                                                    | Chat                             |
| Pen test report                                            | Team only                                                       | Email                            |
| Product name                                               | `brand.json` (we edit)                                          | Chat                             |

---

## 8. Adding secrets and variables to GitHub

You need to be an owner or admin of the repository `Synapsekw/Stratlas_Ai`. Secrets are encrypted; after saving, nobody (including you) can read them back, only replace them ([GitHub Docs: using secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)).

### Add a secret (2 minutes each)

- [ ] Open [github.com/Synapsekw/Stratlas_Ai](https://github.com/Synapsekw/Stratlas_Ai) and sign in.
- [ ] Click **Settings** (top bar of the repository).
- [ ] In the left menu, under **Security**, click **Secrets and variables**, then **Actions**.
- [ ] Stay on the **Secrets** tab and click **New repository secret**.
- [ ] **Name:** type the exact name from the table below (capital letters and underscores, no spaces).
- [ ] **Secret:** paste the value. No extra spaces or line breaks at the end.
- [ ] Click **Add secret**.

### Add a variable (2 minutes each)

Variables are for values that are not secret (account names, the publisher name, the signing command).

- [ ] Same page, click the **Variables** tab, then **New repository variable**.
- [ ] Type the name and value, click **Add variable**.

### The names our build reads

From [SECRETS.md](SECRETS.md) and `.github/workflows/release.yml`. Add only the ones for the routes you set up.

**Windows, our route (C, cloud HSM):**

| Name                                                                                                            | Kind     | From                                                                                        |
| --------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `WIN_PUBLISHER_NAME`                                                                                            | variable | Certificate subject CN (section 1)                                                          |
| `WIN_SIGN_COMMAND`                                                                                              | variable | **Leave to us**                                                                             |
| `SM_HOST`, `SM_API_KEY`, `SM_CLIENT_CERT_FILE_B64`, `SM_CLIENT_CERT_PASSWORD`, `SM_CODE_SIGNING_CERT_SHA1_HASH` | secrets  | DigiCert KeyLocker (section 1). We add the step that reads them and list them in SECRETS.md |

**Windows, route A (only if an eligible entity can use Azure Artifact Signing):** `AZURE_SIGN_ENDPOINT`, `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE` (variables), `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` (secrets), `WIN_PUBLISHER_NAME` (variable). The app registration needs the role **Artifact Signing Certificate Profile Signer** on the signing account ([Microsoft Learn: roles](https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles)).

**Windows, route B:** `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`. Not used: OV certificates cannot be exported as files any more.

**macOS:**

| Name                   | Kind   | From                                    |
| ---------------------- | ------ | --------------------------------------- |
| `MAC_CSC_LINK`         | secret | `developerid.p12` as base64 (section 3) |
| `MAC_CSC_KEY_PASSWORD` | secret | The `.p12` export password              |
| `APPLE_API_KEY_P8`     | secret | Full text of `AuthKey_<KeyID>.p8`       |
| `APPLE_API_KEY_ID`     | secret | Key ID                                  |
| `APPLE_API_ISSUER`     | secret | Issuer ID                               |

or, instead of the last three: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (all secrets). Set one group, not both.

**Microsoft Store:** nothing. `STORE_IDENTITY_NAME`, `STORE_PUBLISHER` and `STORE_PUBLISHER_DISPLAY_NAME` exist only to override `brand.json`; leave them unset.

### Check it worked (5 minutes)

- [ ] Tell us when the secrets are in. We run **Actions**, **release**, **Run workflow**.
- [ ] Its **Signing mode** step prints, for example, `{"win":"command","mac":"signed+notarised",...}`. If it says `unsigned` or `ad-hoc`, a name is misspelt or a value is missing.

### Common problems

- **Typo in a name.** `APPLE_API_ISSUER`, not `APPLE_ISSUER_ID`. Copy names from this page.
- **Trailing space or line break** in a pasted value. Re-add the secret.
- **Secret added to the wrong place** (an environment, or another repository). It must be a **repository** secret on `Synapsekw/Stratlas_Ai`.
- **Pasted into chat by mistake.** Treat it as leaked: revoke or regenerate the value at the vendor, then add the new one to GitHub.

---

## Sources

All checked on 7 October 2026.

**Exchange rate**

- currencyconvert.online, USD to KWD: https://currencyconvert.online/usd/kwd

**Windows signing**

- Microsoft Learn, Artifact Signing quickstart (eligible countries, identity validation): https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
- Microsoft Learn, Artifact Signing overview: https://learn.microsoft.com/en-us/azure/artifact-signing/overview
- Microsoft Learn, Artifact Signing FAQ: https://learn.microsoft.com/en-us/azure/artifact-signing/faq
- Microsoft Learn, Artifact Signing roles: https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles
- Microsoft Q&A, Trusted Signing for other countries (3-year history): https://learn.microsoft.com/en-us/answers/questions/2243504/trusted-signing-for-other-countries
- Azure pricing, Artifact Signing: https://azure.microsoft.com/pricing/details/artifact-signing/
- Azure retail prices API (Trusted Signing SKUs): https://prices.azure.com/api/retail/prices?$filter=contains(productName,'Signing')
- Microsoft Tech Community, Artifact Signing GA: https://techcommunity.microsoft.com/blog/microsoft-security-blog/-/4482789
- Microsoft Learn, SmartScreen reputation (EV no longer bypasses SmartScreen): https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- CA/Browser Forum, ballot CSC-31 (460-day maximum validity): https://cabforum.org/2025/11/17/ballot-csc-31-maximum-validity-reduction
- Entrust, hardware key requirement from June 2023: https://www.entrust.com/blog/2022/09/ca-browser-forum-updates-requirements-for-code-signing-certificate-private-keys/
- DigiCert, compare code signing certificates: https://www.digicert.com/cn/signing/compare-code-signing-certificates
- DigiCert, code signing certificates: https://www.digicert.com/signing/code-signing-certificates
- DigiCert KeyLocker licensing: https://docs.digicert.com/en/digicert-keylocker/overview/licensing.html
- DigiCert KeyLocker GitHub signing scripts: https://docs.digicert.com/en/digicert-keylocker/ci-cd-integrations-and-deployment-pipelines/scripts/github/scripts-for-signing-using-ksp-library-on-github.html
- SSL.com OV code signing: https://ssl.com/products/software-integrity/code-signing/ov/
- SSL.com eSigner pricing: https://ssl.com/guide/esigner-pricing-for-code-signing/
- SSL.com eSigner GitHub Action: https://github.com/SSLcom/esigner-codesign
- SSL.com, D-U-N-S and business listings for validation: https://www.ssl.com/guide/d-u-n-s-numbers-and-business-listings-for-code-signing-certificate-validation/
- Certum, code signing in the cloud: https://shop.certum.eu/standard-code-signing-in-the-cloud.html
- GlobalSign, code signing with Azure Key Vault: https://support.globalsign.com/code-signing/code-signing/code-signing-certificate-setup-azure-key-vault
- Azure Key Vault pricing: https://azure.microsoft.com/en-us/pricing/details/key-vault/
- CodeSigningStore, documents for validation: https://codesigningstore.com/documents-required-for-code-signing-certificate-validation
- electron-builder, Windows code signing: https://www.electron.build/docs/features/code-signing/code-signing-win

**Microsoft Partner Center and Store**

- Windows Developer blog, free company registration (7 May 2026): https://blogs.windows.com/windowsdeveloper/2026/05/07/publish-to-microsoft-store-as-a-company-now-with-free-registration-and-faster-onboarding/
- Windows Developer blog, free individual registration (10 Sep 2025): https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/
- Microsoft Learn, open a developer account (company tab): https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account?tabs=company
- Microsoft Learn, reserve your app's name (MSIX): https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/reserve-your-apps-name
- Microsoft Learn, view app identity details: https://learn.microsoft.com/en-us/windows/apps/publish/view-app-identity-details
- Microsoft Learn, Microsoft Store Policies: https://learn.microsoft.com/en-us/windows/apps/publish/store-policies
- Microsoft Learn, MSI/EXE app package requirements: https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements
- Microsoft Learn, app capability declarations: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations
- Microsoft Store App Developer Agreement v8.11: https://go.microsoft.com/fwlink/?linkid=528905
- Former fees page (Kuwait KWD 28), in the docs repository history: https://github.com/MicrosoftDocs/windows-dev-docs

**Apple**

- Apple, enrol: https://developer.apple.com/programs/enroll/
- Apple, enrolment support: https://developer.apple.com/support/enrollment/
- Apple, program enrolment help: https://developer.apple.com/help/account/membership/program-enrollment/
- Apple, enrolling in the Developer app: https://developer.apple.com/help/account/membership/enrolling-in-the-app/
- Apple, D-U-N-S support: https://developer.apple.com/support/D-U-N-S/
- Apple, D-U-N-S help: https://developer.apple.com/help/account/membership/D-U-N-S/
- D&B support for Apple developers: https://support.dnb.com/?CUST=APPLEDEV
- Dun & Bradstreet South Asia Middle East: https://dnbsame.com/db-d-u-n-s-number
- Apple, create Developer ID certificates: https://developer.apple.com/help/account/certificates/create-developer-id-certificates/
- Apple, create a certificate signing request: https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request/
- Apple PKI (Developer ID G2): https://www.apple.com/certificateauthority/
- Apple, notarising macOS software: https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
- Apple, customising the notarisation workflow: https://developer.apple.com/documentation/security/customizing-the-notarization-workflow
- Apple, App Store Connect API keys: https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/
- Apple, Team ID: https://developer.apple.com/help/glossary/team-id
- Community write-up, Developer ID without a Mac: https://dev.to/byk/nightmare-on-apple-street-2apc

**Cosign**

- Sigstore, CI quickstart: https://docs.sigstore.dev/quickstart/quickstart-ci/
- Sigstore, verifying signatures: https://docs.sigstore.dev/cosign/verifying/verify/
- Sigstore, signing containers: https://docs.sigstore.dev/cosign/signing/signing_with_containers/
- cosign releases: https://github.com/sigstore/cosign/releases
- cosign-installer action: https://github.com/sigstore/cosign-installer
- GitHub blog, container signing in Actions: https://github.blog/2021-12-06-safeguard-container-signing-capability-actions
- GitHub Docs, artifact attestations: https://docs.github.com/en/actions/concepts/security/artifact-attestations

**Penetration test**

- CREST Marketplace: https://marketplace.crest.org/
- CREST listing, DTS Solution: https://marketplace.crest.org/supplier/dts-solution/
- CREST listing, NCC Group: https://www.crest-approved.org/member_companies/ncc-group
- Zawya, GBM CREST and DESC accreditation: https://www.zawya.com/en/press-release/companies-news/gbm-sets-new-industry-standards-with-dual-crest-and-desc-cybersecurity-accreditation-q935jbsm
- Blaze Information Security, penetration testing cost: https://www.blazeinfosec.com/post/how-much-does-penetration-testing-cost/
- DeepStrike, penetration testing cost: https://deepstrike.io/blogs/penetration-testing-cost
- RSM Kuwait, NCSC national controls 2026: https://www.rsm.global/kuwait/node/282

**Name and trademarks**

- WIPO Global Brand Database: https://branddb.wipo.int
- USPTO Trademark Search: https://tmsearch.uspto.gov/search/search-information
- EUIPO eSearch plus: https://euipo.europa.eu/eSearch/
- TMview: https://www.tmdb.tmview.org
- Kuwait government portal, MOCI trademark services: https://e.gov.kw/sites/kgoenglish/Pages/eServices/MOCI/TrademarkRegistrationServices.aspx
- Asia IP, Saudi Arabia joins Madrid (Kuwait outside): https://asiaiplaw.com/sector/trademarks/saudi-arabias-madrid-protocol-accession-reshapes-middle-east-trademark-strategy
- Ladas & Parry, Kuwait trademark procedure: https://ladas.com/news/trademark-office-kuwait-ushers-new-procedural-changes/
- CITRA, Kuwait .kw domains: https://citra.gov.kw/sites/en/Pages/KuwaitDomainKw.aspx

**GitHub**

- GitHub Docs, using secrets in Actions: https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets
