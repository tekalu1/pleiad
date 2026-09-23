; 更新時は既存のショートカットを残し（KeepShortcuts=true）、AUMID を付け直さない。
; AUMID の無いショートカットはタスクバーと通知で Pleiad として解決されないため、毎回付け直す
!macro customInstall
  ${if} ${FileExists} "$newStartMenuLink"
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${endIf}
  ${if} ${FileExists} "$newDesktopLink"
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${endIf}
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

; 更新はインストーラーの画面を出して進捗バーだけを見せる（desktop/main.cjs の quitAndInstall）。
; 「すべてのユーザー／自分のみ」の選択は前回のインストールを引き継いで飛ばす。
; 前回が全ユーザー向けだけのときは全ユーザー向け（必要なら UAC で昇格）、それ以外は自分のみ
!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    ${if} ${isUpdated}
      ${if} $hasPerMachineInstallation == "1"
      ${andIf} $hasPerUserInstallation == "0"
        StrCpy $isForceMachineInstall "1"
      ${else}
        StrCpy $isForceCurrentInstall "1"
      ${endIf}
    ${endIf}
  !endif
!macroend

; 完了ページは初回インストールでは既定どおり出す。更新時は飛ばして閉じ、Pleiad を起動し直す。
; 画面ありの assisted インストーラーは --force-run でも自分では起動しないため、ここで起動する
!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function skipFinishPageIfUpdated
    ${if} ${isUpdated}
      ${if} ${isForceRun}
        HideWindow
        Call StartApp
      ${endIf}
      Abort
    ${endIf}
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE skipFinishPageIfUpdated
  !insertmacro MUI_PAGE_FINISH
!macroend
