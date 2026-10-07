; Included by electron-builder's NSIS template (electron-builder.yml nsis.include).
; Always install for the current user only: no elevation, no install-mode page.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; The product was called Stratlas until 7 Oct 2026 (Stratlas.exe in ...\Programs\Stratlas). The
; app id did not change, so this installer finds such an install and runs its uninstaller first
; (user data stays); the new version then goes to a "${APP_FILENAME}" folder beside it instead of
; the old folder, or the template would nest it as ...\Stratlas\${APP_FILENAME}.
!macro _renamedInstallDir
  Push $R9
  ${GetFileName} "$INSTDIR" $R9
  ${if} $R9 == "Stratlas"
    ${GetParent} "$INSTDIR" $R9
    StrCpy $INSTDIR "$R9\${APP_FILENAME}"
  ${endIf}
  Pop $R9
!macroend

; Silent installs (updates run with --updated /S) show no pages: fix the folder in .onInit.
!macro customInit
  !insertmacro _renamedInstallDir
!macroend

; Interactive installs read the old folder again on the install-mode page: fix it after the
; directory page, before the files are copied (a page that never shows).
!macro customPageAfterChangeDir
  Page custom renamedInstallDirPage
  Function renamedInstallDirPage
    !insertmacro _renamedInstallDir
    Abort
  FunctionEnd
!macroend

; Exit code 0 in _RESULT when the app's executable runs for this user, from any folder: this
; version's, or Stratlas.exe of a version from before the rename.
; tasklist and findstr ship with every Windows; nsExec runs them without a console window.
!macro _appRunning _RESULT
  nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "USERNAME eq %USERNAME%" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\"" /C:"\"Stratlas.exe\""`
  Pop ${_RESULT}
!macroend

; Replaces electron-builder's CHECK_APP_RUNNING in the installer and the uninstaller. The
; default only looks for processes under $INSTDIR and then kills them; this one finds the
; executable wherever it runs (an older install folder, win-unpacked, the portable build),
; never kills it (a running app may be saving work), and waits for the person to close it.
!macro customCheckAppRunning
  !insertmacro _appRunning $R0
  ${if} $R0 == 0
  ${andIf} ${isUpdated}
    ; The app quit to install this update and may still be closing: give it a few seconds.
    ${for} $R1 1 10
      Sleep 1000
      !insertmacro _appRunning $R0
      ${if} $R0 != 0
        ${exitFor}
      ${endIf}
    ${next}
  ${endIf}
  ${doWhile} $R0 == 0
    ${if} ${Cmd} `MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${PRODUCT_NAME} is running. Close it and click Retry." /SD IDCANCEL IDCANCEL`
      Quit
    ${endIf}
    !insertmacro _appRunning $R0
  ${loop}
!macroend
