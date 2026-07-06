!include MUI2.nsh
!include nsDialogs.nsh

!macro CodexioDeleteUserData
  RMDir /r "$APPDATA\${APP_FILENAME}"
  !ifdef APP_PRODUCT_FILENAME
    RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
  !endif
  !ifdef APP_PACKAGE_NAME
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
  Var CodexioClearUserDataCheckbox
  Var CodexioClearUserData

  !macro customPageAfterChangeDir
    Page custom CodexioInstallDataPageCreate CodexioInstallDataPageLeave
  !macroend

  Function CodexioInstallDataPageCreate
    !insertmacro MUI_HEADER_TEXT "Codexio 用户数据" "选择是否清空这台电脑上已有的 Codexio 用户数据。"
    nsDialogs::Create 1018
    Pop $0
    StrCmp $0 error 0 +2
    Abort
    ${NSD_CreateLabel} 0 0 100% 28u "默认保留已有配置、运行状态、日志、文件缓存和默认工作区。"
    Pop $0
    ${NSD_CreateCheckbox} 0 38u 100% 12u "清空已有 Codexio 用户数据"
    Pop $CodexioClearUserDataCheckbox
    ${NSD_SetState} $CodexioClearUserDataCheckbox ${BST_UNCHECKED}
    nsDialogs::Show
  FunctionEnd

  Function CodexioInstallDataPageLeave
    ${NSD_GetState} $CodexioClearUserDataCheckbox $CodexioClearUserData
  FunctionEnd

  !macro customInstall
    StrCmp $CodexioClearUserData ${BST_CHECKED} 0 +2
    !insertmacro CodexioDeleteUserData
  !macroend
!endif

!macro customUnInstallSection
  Section /o "删除 Codexio 用户数据" un.CodexioUserData
    !insertmacro CodexioDeleteUserData
  SectionEnd
!macroend
