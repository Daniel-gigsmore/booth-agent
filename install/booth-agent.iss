; Built by install\build-installer.ps1, which passes AppVersion, Stage, NodeExe and OutDir.
; One installer for the booth: booth-agent (the Windows service) in {app}, the kiosk app in {app}\kiosk.
; The kiosk reads the port, shared secret and download link from {app}\booth.config.json at runtime.

[Setup]
; Same AppId as the agent-only installer, so this upgrades a booth that has it.
AppId={{8B6F3C2E-5D41-4C7A-9E2B-1F0A6D3C7B95}
AppName=Kachak Booth
AppVersion={#AppVersion}
AppPublisher=Kachak Productions
DefaultDirName=C:\BoothAgent\agent
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutDir}
OutputBaseFilename=Kachak Booth Setup {#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Kachak Booth (agent + kiosk)
UninstallDisplayIcon={app}\kiosk\Kachak Kiosk.exe
CloseApplications=no

[Files]
Source: "{#Stage}\dist\*"; DestDir: "{app}\dist"; Flags: recursesubdirs ignoreversion
Source: "{#Stage}\node_modules\*"; DestDir: "{app}\node_modules"; Flags: recursesubdirs ignoreversion
Source: "{#Stage}\assets\*"; DestDir: "{app}\assets"; Flags: recursesubdirs ignoreversion
Source: "{#Stage}\download\*"; DestDir: "{app}\download"; Flags: recursesubdirs ignoreversion
Source: "{#Stage}\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Stage}\install\start-tray.ps1"; DestDir: "{app}\install"; Flags: ignoreversion
Source: "{#Stage}\booth.config.example.json"; DestDir: "{app}"; Flags: ignoreversion
; The booth's real config: written once (with a fresh random shared secret), kept on upgrade and uninstall.
Source: "{#Stage}\booth.config.example.json"; DestDir: "{app}"; DestName: "booth.config.json"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "{#NodeExe}"; DestDir: "{app}\node"; Flags: ignoreversion
; Canon EDSDK (capture.canon.driver "edsdk"), when the build PC had it. Not in git: Canon's licence.
Source: "{#Stage}\edsdk\*"; DestDir: "C:\BoothAgent\edsdk"; Flags: ignoreversion skipifsourcedoesntexist uninsneveruninstall
; The kiosk app (electron-builder --dir).
Source: "{#Stage}\kiosk\installer\win-unpacked\*"; DestDir: "{app}\kiosk"; Flags: recursesubdirs ignoreversion

[InstallDelete]
; Old kiosk files from an earlier version of this installer.
Type: filesandordirs; Name: "{app}\kiosk"
; The Chrome kiosk's start-kiosk.ps1 shortcut: replaced by the app's All Users startup shortcut.
Type: files; Name: "{userstartup}\Kachak Kiosk.lnk"

[Icons]
Name: "{commonstartup}\Kachak Kiosk"; Filename: "{app}\kiosk\Kachak Kiosk.exe"; WorkingDir: "{app}\kiosk"
Name: "{commondesktop}\Kachak Kiosk"; Filename: "{app}\kiosk\Kachak Kiosk.exe"; WorkingDir: "{app}\kiosk"

[Registry]
; The standalone kiosk app registered itself to start at login; this installer's startup shortcut does that now.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "com.kachak.kiosk"; Flags: deletevalue
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "electron.app.Kachak Kiosk"; Flags: deletevalue

[Run]
; A new booth gets its own random shared secret. Nobody needs to copy it anywhere: booth-agent and the kiosk both read it here.
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""$p = '{app}\booth.config.json'; $s = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'); (Get-Content -Raw $p).Replace('change-me-to-a-long-random-string', $s) | Set-Content -NoNewline -Encoding ASCII $p"""; StatusMsg: "Generating the shared secret..."; Check: IsConfigNew; Flags: runhidden waituntilterminated
Filename: "{win}\notepad.exe"; Parameters: """{app}\booth.config.json"""; StatusMsg: "Fill in booth.config.json, save it and close Notepad to continue..."; Check: IsConfigNew; Flags: waituntilterminated
; node-windows registers the service against the node.exe that runs this, i.e. the bundled one.
Filename: "{app}\node\node.exe"; Parameters: """{app}\dist\service\install.js"""; WorkingDir: "{app}"; StatusMsg: "Installing the BoothAgent service..."; BeforeInstall: WaitForConfigSaved; Flags: runhidden waituntilterminated
; On upgrade install.js only reports "already installed", so start the service stopped in PrepareToInstall.
Filename: "{sys}\sc.exe"; Parameters: "start boothagent.exe"; Flags: runhidden waituntilterminated
Filename: "{app}\kiosk\Kachak Kiosk.exe"; Description: "Open the kiosk now"; WorkingDir: "{app}\kiosk"; Flags: postinstall nowait skipifsilent runasoriginaluser

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM ""Kachak Kiosk.exe"""; Flags: runhidden waituntilterminated; RunOnceId: "StopKiosk"
Filename: "{app}\node\node.exe"; Parameters: """{app}\dist\service\uninstall.js"""; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveService"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\dist\daemon"
Type: filesandordirs; Name: "{app}\kiosk"

[Code]
const
  KioskOrigin = 'http://127.0.0.1:4173';
  UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall';

var
  ConfigIsNew: Boolean;

function IsConfigNew: Boolean;
begin
  Result := ConfigIsNew;
end;

function ConfigPath: String;
begin
  Result := ExpandConstant('{app}\booth.config.json');
end;

{ Runs an uninstall command line such as '"C:\...\Uninstall Kachak Kiosk.exe" /allusers /S'. }
procedure RunUninstallString(const Cmd: String);
var
  Exe, Params: String;
  P, Code: Integer;
begin
  if Copy(Cmd, 1, 1) = '"' then
  begin
    P := Pos('"', Copy(Cmd, 2, Length(Cmd)));
    Exe := Copy(Cmd, 2, P - 1);
    Params := Trim(Copy(Cmd, P + 2, Length(Cmd)));
  end
  else
  begin
    Exe := Cmd;
    Params := '';
  end;
  if Pos('/S', Params) = 0 then Params := Params + ' /S';
  Exec(Exe, Params, '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

{ Removes the standalone "Kachak Kiosk" app (the kiosk's own NSIS installer), which would
  otherwise hold port 4173 and start a second kiosk at login. Returns True if it found one. }
function RemoveStandaloneKioskFrom(const Root: Integer): Boolean;
var
  Names: TArrayOfString;
  I, Waited: Integer;
  Name, Cmd: String;
begin
  Result := False;
  if not RegGetSubkeyNames(Root, UninstallKey, Names) then Exit;
  for I := 0 to GetArrayLength(Names) - 1 do
    if RegQueryStringValue(Root, UninstallKey + '\' + Names[I], 'DisplayName', Name) and
       (Pos('Kachak Kiosk', Name) = 1) then
    begin
      if not RegQueryStringValue(Root, UninstallKey + '\' + Names[I], 'QuietUninstallString', Cmd) then
        RegQueryStringValue(Root, UninstallKey + '\' + Names[I], 'UninstallString', Cmd);
      if Cmd <> '' then
      begin
        Log('Removing the standalone kiosk app: ' + Cmd);
        RunUninstallString(Cmd);
        { NSIS uninstallers hand over to a copy of themselves, so wait for the entry to go. }
        Waited := 0;
        while RegKeyExists(Root, UninstallKey + '\' + Names[I]) and (Waited < 60) do
        begin
          Sleep(500);
          Waited := Waited + 1;
        end;
        Result := True;
      end;
    end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ImagePath: String;
  Code: Integer;
begin
  Result := '';
  ConfigIsNew := not FileExists(ConfigPath);
  { A running kiosk would lock its files. }
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM "Kachak Kiosk.exe"', '', SW_HIDE, ewWaitUntilTerminated, Code);
  RemoveStandaloneKioskFrom(HKLM64);
  RemoveStandaloneKioskFrom(HKLM32);
  RemoveStandaloneKioskFrom(HKCU);
  if RegQueryStringValue(HKLM, 'SYSTEM\CurrentControlSet\Services\boothagent.exe', 'ImagePath', ImagePath) then
  begin
    if Pos(Lowercase(ExpandConstant('{app}\')), Lowercase(ImagePath)) = 0 then
      Result := 'A BoothAgent service is already installed from another folder:' + #13#10 + ImagePath + #13#10#13#10 +
        'Uninstall that one first (install\uninstall-service.ps1 in that copy), then run this installer again.'
    else
      Exec(ExpandConstant('{sys}\net.exe'), 'stop boothagent.exe', '', SW_HIDE, ewWaitUntilTerminated, Code);
  end;
end;

{ Windows 11's Notepad can hand the file to an already-open window and return at once,
  so don't trust waituntilterminated alone: hold the service install until the operator says the config is saved. }
procedure WaitForConfigSaved;
begin
  if ConfigIsNew then
    SuppressibleMsgBox('Finish filling in booth.config.json in Notepad and save it (Ctrl+S).' + #13#10#13#10 +
      'Press OK once it is saved to install and start the BoothAgent service.', mbInformation, MB_OK, IDOK);
end;

{ After install: an older booth.config.json may not allow the kiosk's origin yet (every kiosk call
  would fail CORS), or may still use digiCamControl although the EDSDK the camera needs was just installed. }
procedure CurStepChanged(CurStep: TSetupStep);
var
  Text: AnsiString;
begin
  if (CurStep <> ssPostInstall) or not LoadStringFromFile(ConfigPath, Text) then Exit;
  if Pos(KioskOrigin, Text) = 0 then
    SuppressibleMsgBox('booth.config.json does not list the kiosk in agent.allowedOrigins yet, so the kiosk cannot talk to booth-agent.' + #13#10#13#10 +
      'Add "' + KioskOrigin + '" to agent.allowedOrigins in' + #13#10 + ConfigPath + #13#10 +
      'and restart the BoothAgent service.', mbInformation, MB_OK, IDOK);
  if FileExists('C:\BoothAgent\edsdk\EDSDK.dll') and (Pos('"edsdk"', Text) = 0) then
    SuppressibleMsgBox('The Canon camera driver (EDSDK) is installed, but booth.config.json still uses digiCamControl.' + #13#10#13#10 +
      'To use it, add "driver": "edsdk", under capture.canon in' + #13#10 + ConfigPath + #13#10 +
      'and restart the BoothAgent service.', mbInformation, MB_OK, IDOK);
end;
