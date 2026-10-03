# ADR 0001: Electron as the desktop shell

- Status: Accepted, 2026-10-03
- Deciders: founder, lead engineer

## Context

Stratlas must render identically on Windows and macOS, play H.265 drone footage on locked-down machines, use WebCodecs and `requestVideoFrameCallback` for frame-accurate video projection, and run AI provider SDKs where API keys never reach the UI. The team already ships Kestrel on Tauri 2.

## Decision

Use Electron (current major, N-1 policy) with electron-vite and electron-builder.

## Reasons

- One pinned Chromium on both platforms. Tauri uses WebView2 on Windows and WKWebView on macOS, where WebCodecs is complete only from macOS 26 and frame rate is capped on macOS 13 to 15.
- H.265 decodes in Chromium without the Microsoft Store HEVC extension that WebView2 needs.
- Node in the main process runs the Vercel AI SDK, better-sqlite3 and file streaming in-process; keys stay out of the renderer.
- Kestrel's Tauri dependency is thin (469 lines of Rust, about 20 call sites); its React, Python sidecar and installer lessons transfer.
- The founder's condition: Electron is acceptable as long as everything Kestrel does (maps, AI SDK, Python sidecar, installers) works. Each was checked and works.

## Consequences

- Larger installer (about 150 MB), irrelevant next to map packs and project data.
- We track Electron majors for security fixes.
- Windows ships through the Microsoft Store (MSIX) and as a signed offline NSIS installer; macOS through Developer ID and notarisation.
