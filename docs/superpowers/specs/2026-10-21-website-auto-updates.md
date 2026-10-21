# Website app and processing kit updates

Approved behavior: automatically check the Quadrion website and download published app and processing kit updates in the background. The user chooses **Restart and update**. No automatic restart, no interruption of processing, and offline use and manual package installation remain available.

## Product behavior

- Settings, About contains website account sign-in, an automatic updates switch, current app/kit versions, check/retry, download progress and the restart action. A quiet global notice links to update details when ready; it survives navigation. Use established components, tokens, keyboard semantics and theme.
- Use the existing private website account. Passwords are used only for sign-in; refresh credentials live in the OS vault. Access and refresh tokens and signed URLs never appear in renderer state, settings, logs, or persistent update manifests. A password exists only transiently in the sign-in form and request, is cleared after submission, and is never persisted or logged.
- Automatic website updates are enabled by default but require a signed-in account. Offline-only disables all updater networking, including auth/config requests. An explicit disable or sign-out aborts current requests and prevents stale asynchronous results from changing state. Existing legacy feed settings/manual workflows remain compatible.
- Check at startup after settings/account initialization and every six hours, also after successful sign-in or re-enabling. Bounded retries on failure, no retry loops; a user can retry. Staging resumes after app relaunch.
- Initial installation support is Windows x64 installed NSIS builds. Store, portable, development and other platforms show their limitation clearly and must never launch this installer automatically. Tests use injected support/dependencies.
- Background downloads do not quit or change active processing tools. Only fully verified, complete app/kit sets become ready. Locally ready updates can be applied offline.
- Restart acquires a main-process work gate, refuses while processing/tool installation/import work is active, then applies the verified stage. A job racing with restart cannot start after the gate is acquired. Failure releases the gate. No deferred automatic restart.
- Keep the existing installer signature/version verification, previous runnable app and startup rollback. Managed kits live outside legacy runtime/pipeline-pack-* discovery, with app-version-aware selection in a separate versioned file. Old executables must continue finding their previous legacy kit. Keep previous managed kit selection for kit-only recovery.

## Website contract

Origin is https://quadrion.ai. Configuration is existing GET /api/portal?action=config. Main signs in against the configured Supabase public auth API; only HTTPS expected Supabase origin is accepted. Use the existing member bearer authentication and live account checks.

GET /api/portal?action=updates&platform=win-x64&appVersion=0.24.0&pipelineVersion=0.19.0 returns:

```json
{
  "schema": "quadrion.updates/1",
  "targetAppVersion": "0.25.0",
  "app": {
    "releaseId": "uuid",
    "artifactId": "uuid",
    "version": "0.25.0",
    "platform": "win-x64",
    "filename": "Quadrion-Setup.exe",
    "bytes": 123,
    "sha256": "64 lowercase hex",
    "notes": "Release notes"
  },
  "pipeline": {
    "releaseId": "uuid",
    "artifactId": "uuid",
    "version": "0.20.0",
    "platform": "win-x64",
    "filename": "pipeline-pack-0.20.0-win-x64.tar.gz",
    "bytes": 456,
    "sha256": "64 lowercase hex",
    "notes": "Kit notes",
    "appRange": ">=0.25.0 <2.0.0"
  }
}
```

Each component can be null when no change is needed; targetAppVersion always identifies the version for compatibility validation. Query versions are strict stable SemVer; pipelineVersion may be omitted if absent. No signed URLs, buckets, storage paths or reservation side effects in checks. Return only update-eligible, published, verified Windows x64 NSIS/app or tar.gz/pipeline artifacts. Existing unannotated releases remain manual-only.

New release metadata: autoUpdateEnabled (default false), architecture (x64 for initial updater), packageFormat (nsis or tar.gz), appRange (pipeline only), pipelineReleaseId (app only, a published update-eligible compatible baseline kit). Website admin can set these on draft creation/edit with optimistic revision checks. Use stable SemVer and canonical bounded range `>=X.Y.Z <X.Y.Z`. App publication requires the referenced baseline kit to be published, verified and compatible. Pipeline publication requires a nonempty bounded app range, proper archive extension and verified artifact. Database must independently enforce basic metadata/publication invariants, ACLs and current membership.

Select highest eligible app version greater than current for this platform for which a valid kit exists. Choose highest compatible pipeline at least the app's linked baseline version; otherwise withhold that app. With no app upgrade, choose highest compatible kit newer than installed (or install if absent). An app update may retain an already installed identical selected kit. Compare numeric SemVer, never publication order or lexical strings. Preserve manual catalog/release behavior.

Download URLs use existing POST /api/portal?action=download {artifactId}, bearer plus explicit Origin https://quadrion.ai; grant {url, filename, bytes, sha256, expiresIn}. Fetch binary separately without bearer. Validate grant against immutable check metadata and allow only expected Supabase HTTPS storage origin/path. Reacquire grant for bounded retries/resume; existing 30/hour limit remains. Persist only digest-addressed local artifacts and nonsecret metadata. Check size/hash on download and reverify before apply; verify installer publisher/version and archive manifest/files/paths/target-app compatibility. No auth/service secrets in shipped configuration.

## Validation and delivery

Test member/publication/compatibility boundaries on website, cancellation/resume/auth boundaries in desktop, full staged-update transaction and job race, kit selection/rollback, renderer state and CI-style Electron flow with synthetic artifacts. Full website tests/build/public scan and desktop pnpm check must pass. No customer data or live publishing needed. Provide migration/deploy instructions and draft PRs; no installer build, production release or main push in this task.
