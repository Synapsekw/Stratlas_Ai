; Included by electron-builder's NSIS template (electron-builder.yml nsis.include).
; Always install for the current user only: no elevation, no install-mode page.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; Exit code 0 in _RESULT when the app's executable runs for this user, from any folder.
; tasklist and findstr ship with every Windows; nsExec runs them without a console window.
!macro _appRunning _RESULT
  nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
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
