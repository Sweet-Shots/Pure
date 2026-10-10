; Pure Browser NSIS hooks (electron-builder "nsis.include").
; Registers Pure as a Windows browser so it appears in Settings > Apps > Default apps.
; Per-user install: everything lives under HKCU, so no admin rights are needed.
; NSIS backtick strings are used for values with quotes: `...` allows " and expands $INSTDIR.

!macro customInstall
  ; Protocol handler ProgID for http:/https: links
  WriteRegStr HKCU "Software\Classes\PureBrowserURL" "" "Pure Browser URL"
  WriteRegStr HKCU "Software\Classes\PureBrowserURL" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\PureBrowserURL\DefaultIcon" "" `$INSTDIR\Pure Browser.exe,0`
  WriteRegStr HKCU "Software\Classes\PureBrowserURL\shell\open\command" "" `"$INSTDIR\Pure Browser.exe" "%1"`

  ; File handler ProgID for .htm / .html / .pdf
  WriteRegStr HKCU "Software\Classes\PureBrowserHTML" "" "Pure Browser Document"
  WriteRegStr HKCU "Software\Classes\PureBrowserHTML\DefaultIcon" "" `$INSTDIR\Pure Browser.exe,0`
  WriteRegStr HKCU "Software\Classes\PureBrowserHTML\shell\open\command" "" `"$INSTDIR\Pure Browser.exe" "%1"`

  ; StartMenuInternet client: what Default apps lists
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Pure Browser" "" "Pure Browser"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Pure Browser\DefaultIcon" "" `$INSTDIR\Pure Browser.exe,0`
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Pure Browser\shell\open\command" "" `"$INSTDIR\Pure Browser.exe"`

  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Pure Browser\Capabilities" "ApplicationName" "Pure Browser"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Pure Browser\Capabilities" "ApplicationDescription" "A minimal, fast browser."
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Pure Browser\Capabilities" "ApplicationIcon" `$INSTDIR\Pure Browser.exe,0`

  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Pure Browser\Capabilities\URLAssociations" "http" "PureBrowserURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Pure Browser\Capabilities\URLAssociations" "https" "PureBrowserURL"

  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Pure Browser\Capabilities\FileAssociations" ".htm" "PureBrowserHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Pure Browser\Capabilities\FileAssociations" ".html" "PureBrowserHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Pure Browser\Capabilities\FileAssociations" ".pdf" "PureBrowserHTML"

  WriteRegStr HKCU "Software\RegisteredApplications" "Pure Browser" "Software\Clients\StartMenuInternet\Pure Browser\Capabilities"
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\RegisteredApplications" "Pure Browser"
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\Pure Browser"
  DeleteRegKey HKCU "Software\Classes\PureBrowserURL"
  DeleteRegKey HKCU "Software\Classes\PureBrowserHTML"
!macroend
