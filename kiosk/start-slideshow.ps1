<#
  Opens the event album as a full-screen slideshow on a second screen (TV,
  projector), straight from booth-agent: no internet needed, and each print
  appears as soon as it is made. See download/README.md.

  Run it on the booth PC with the second screen connected. Exit with Alt+F4.
    -Screen      index into the connected screens; default: the first one that
                 isn't the primary screen
    -ConfigPath  booth-agent's booth.config.json
#>
param(
    [string]$ConfigPath = "$env:USERPROFILE\Documents\booth-agent\booth.config.json",
    [int]$Screen = -1
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms

$Config = Get-Content -Raw $ConfigPath | ConvertFrom-Json
$Port = if ($Config.agent.port) { $Config.agent.port } else { 7070 }
$Name = if ($Config.event.name) { $Config.event.name } else { $Config.event.id }
$Url = "http://127.0.0.1:$Port/album/album.html?local=1&play=1" +
    "&token=$([uri]::EscapeDataString($Config.agent.sharedSecret))" +
    "&name=$([uri]::EscapeDataString($Name))"

$Screens = [System.Windows.Forms.Screen]::AllScreens
if ($Screen -lt 0) {
    $Target = $Screens | Where-Object { -not $_.Primary } | Select-Object -First 1
    if (-not $Target) { throw "Only one screen is connected - plug in the second screen first." }
} elseif ($Screen -lt $Screens.Count) {
    $Target = $Screens[$Screen]
} else {
    throw "Screen $Screen not found - $($Screens.Count) screen(s) connected."
}

$Chrome = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
# Its own profile, so it opens a separate kiosk window beside the booth's kiosk.
Start-Process $Chrome -ArgumentList @(
    "--kiosk", "--user-data-dir=$env:LOCALAPPDATA\KachakSlideshow", "--no-first-run",
    "--window-position=$($Target.Bounds.X),$($Target.Bounds.Y)", $Url
)
