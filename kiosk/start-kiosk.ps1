<#
  Serves the built kiosk (dist/) on http://127.0.0.1:4173 and opens it
  full-screen in Chrome. Run `npm run build` first.

  Starts at login via the "Kachak Kiosk" shortcut in shell:startup. Exit
  the kiosk with Alt+F4; the server keeps running in the background.
#>

$ErrorActionPreference = "Stop"
$KioskDir = $PSScriptRoot
$Url = "http://127.0.0.1:4173"
$Chrome = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"

function Test-Kiosk {
    try { (Invoke-WebRequest -UseBasicParsing $Url -TimeoutSec 2).StatusCode -eq 200 } catch { $false }
}

if (-not (Test-Kiosk)) {
    Start-Process node -WorkingDirectory $KioskDir -WindowStyle Hidden -ArgumentList @(
        "node_modules\vite\bin\vite.js", "preview", "--host", "127.0.0.1", "--port", "4173", "--strictPort"
    )
    # At login OneDrive and the disk are still busy, so give the server time to come up.
    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Test-Kiosk)) {
        if ((Get-Date) -gt $deadline) { throw "Kiosk server did not start on $Url" }
        Start-Sleep -Seconds 1
    }
}

# Its own profile, so --kiosk works even if normal Chrome is already open.
Start-Process $Chrome -ArgumentList @(
    "--kiosk", "--user-data-dir=$env:LOCALAPPDATA\KachakKiosk", "--no-first-run",
    "--disable-pinch", "--overscroll-history-navigation=0", $Url
)
