; Built by install\build-installer.ps1, which passes AppVersion, Stage, NodeExe and OutDir.

[Setup]
AppId={{8B6F3C2E-5D41-4C7A-9E2B-1F0A6D3C7B95}
AppName=Kachak Booth Agent
AppVersion={#AppVersion}
DefaultDirName=C:\BoothAgent\agent
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutDir}
OutputBaseFilename=BoothAgent Setup {#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Kachak Booth Agent

[Files]
Source: "{#Stage}\dist\*"; DestDir: "{app}\dist"; Flags: recursesubdirs ignoreversion
Source: "{#Stage}\node_modules\*"; DestDir: "{app}\node_modules"; Flags: recursesubdirs ignoreversion
Source: "{#Stage}\assets\*"; DestDir: "{app}\assets"; Flags: recursesubdirs ignoreversion
Source: "{#Stage}\download\*"; DestDir: "{app}\download"; Flags: recursesubdirs ignoreversion
Source: "{#Stage}\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Stage}\install\start-tray.ps1"; DestDir: "{app}\install"; Flags: ignoreversion
Source: "{#Stage}\booth.config.example.json"; DestDir: "{app}"; Flags: ignoreversion
; The booth's real config: written once, kept on upgrade and uninstall.
Source: "{#Stage}\booth.config.example.json"; DestDir: "{app}"; DestName: "booth.config.json"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "{#NodeExe}"; DestDir: "{app}\node"; Flags: ignoreversion

[Run]
Filename: "{win}\notepad.exe"; Parameters: """{app}\booth.config.json"""; StatusMsg: "Fill in booth.config.json, save it and close Notepad to continue..."; Check: IsConfigNew; Flags: waituntilterminated
; node-windows registers the service against the node.exe that runs this, i.e. the bundled one.
Filename: "{app}\node\node.exe"; Parameters: """{app}\dist\service\install.js"""; WorkingDir: "{app}"; StatusMsg: "Installing the BoothAgent service..."; Flags: runhidden waituntilterminated
; On upgrade install.js only reports "already installed", so start the service stopped in PrepareToInstall.
Filename: "{sys}\sc.exe"; Parameters: "start boothagent.exe"; Flags: runhidden waituntilterminated

[UninstallRun]
Filename: "{app}\node\node.exe"; Parameters: """{app}\dist\service\uninstall.js"""; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveService"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\dist\daemon"

[Code]
var
  ConfigIsNew: Boolean;

function IsConfigNew: Boolean;
begin
  Result := ConfigIsNew;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ImagePath: String;
  Code: Integer;
begin
  Result := '';
  ConfigIsNew := not FileExists(ExpandConstant('{app}\booth.config.json'));
  if RegQueryStringValue(HKLM, 'SYSTEM\CurrentControlSet\Services\boothagent.exe', 'ImagePath', ImagePath) then
  begin
    if Pos(Lowercase(ExpandConstant('{app}\')), Lowercase(ImagePath)) = 0 then
      Result := 'A BoothAgent service is already installed from another folder:' + #13#10 + ImagePath + #13#10#13#10 +
        'Uninstall that one first (install\uninstall-service.ps1 in that copy), then run this installer again.'
    else
      Exec(ExpandConstant('{sys}\net.exe'), 'stop boothagent.exe', '', SW_HIDE, ewWaitUntilTerminated, Code);
  end;
end;
