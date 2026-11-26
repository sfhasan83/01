Unicode true
SetCompressor /SOLID lzma
!include "MUI2.nsh"
!define APPNAME "BAATS ERP"
!define VERSION "0.5.0"
Name "BAATS Enterprise ERP ${VERSION} (Phase 1 and 2 trial)"
OutFile "/home/claude/build/out/BAATS-ERP-Setup-0.5.0.exe"
InstallDir "$LOCALAPPDATA\Programs\BAATS ERP"
RequestExecutionLevel user
BrandingText "BAATS Enterprise ERP"
VIProductVersion "0.5.0.0"
VIAddVersionKey "ProductName" "BAATS Enterprise ERP"
VIAddVersionKey "FileDescription" "BAATS Enterprise ERP Setup"
VIAddVersionKey "FileVersion" "0.5.0"
VIAddVersionKey "ProductVersion" "0.5.0"
VIAddVersionKey "LegalCopyright" "BAATS"
!define MUI_ICON "/home/claude/build/win/baats.ico"
!define MUI_UNICON "/home/claude/build/win/baats.ico"
!define MUI_WELCOMEPAGE_TITLE "Install BAATS Enterprise ERP"
!define MUI_WELCOMEPAGE_TEXT "This installs a trial of BAATS Enterprise ERP: Phase 1 (core platform) and Phase 2 (finance and UAE VAT) on this computer.$\r$\n$\r$\nEverything it needs is included: its own database and runtime. Nothing is shared on your network, and no administrator rights are needed.$\r$\n$\r$\nAbout 200 MB of disk space is used."
!define MUI_FINISHPAGE_RUN "$INSTDIR\BAATS ERP.cmd"
!define MUI_FINISHPAGE_RUN_TEXT "Start BAATS ERP now"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  ; stop a running copy before replacing files (upgrade)
  IfFileExists "$INSTDIR\node\node.exe" 0 +2
    nsExec::Exec '"$INSTDIR\node\node.exe" "$INSTDIR\launcher\launcher.mjs" --stop'
  SetOutPath "$INSTDIR"
  RMDir /r "$INSTDIR\app"
  File /r "/home/claude/build/win/*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\BAATS ERP"
  CreateShortcut "$SMPROGRAMS\BAATS ERP\BAATS ERP.lnk" "$INSTDIR\BAATS ERP.cmd" "" "$INSTDIR\baats.ico"
  CreateShortcut "$SMPROGRAMS\BAATS ERP\Stop BAATS ERP.lnk" "$INSTDIR\Stop BAATS ERP.cmd" "" "$INSTDIR\baats.ico" 0 SW_SHOWMINIMIZED
  CreateShortcut "$SMPROGRAMS\BAATS ERP\Uninstall BAATS ERP.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\BAATS ERP.lnk" "$INSTDIR\BAATS ERP.cmd" "" "$INSTDIR\baats.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BAATSERP" "DisplayName" "BAATS Enterprise ERP (trial)"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BAATSERP" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BAATSERP" "Publisher" "BAATS"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BAATSERP" "DisplayIcon" "$INSTDIR\baats.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BAATSERP" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BAATSERP" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BAATSERP" "NoRepair" 1
SectionEnd

Section "Uninstall"
  nsExec::Exec '"$INSTDIR\node\node.exe" "$INSTDIR\launcher\launcher.mjs" --stop'
  Delete "$DESKTOP\BAATS ERP.lnk"
  RMDir /r "$SMPROGRAMS\BAATS ERP"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BAATSERP"
  MessageBox MB_YESNO|MB_ICONQUESTION "Also delete your BAATS data (companies, users and records you created)?$\r$\n$\r$\nChoose No to keep it for a later install." /SD IDNO IDNO keep
    RMDir /r "$LOCALAPPDATA\BAATS-ERP"
  keep:
SectionEnd
