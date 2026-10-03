; Included by electron-builder's NSIS template (electron-builder.yml nsis.include).
; Always install for the current user only: no elevation, no install-mode page.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
