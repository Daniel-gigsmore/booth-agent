<#
  Starts the optional tray status icon. This does NOT run the agent itself -
  it polls the already-running agent's /health endpoint. Safe to start,
  stop, or skip entirely; the booth works the same either way.

  For it to start automatically at login, place a shortcut to this script
  (or to `node dist\tray\trayApp.js`) in:
    shell:startup
#>

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

$DistEntry = Join-Path $RepoRoot "dist\tray\trayApp.js"
if (-not (Test-Path $DistEntry)) {
    Write-Host "dist\ not found - building first..."
    Push-Location $RepoRoot
    npm run build
    Pop-Location
}

Push-Location $RepoRoot
$env:BOOTH_CONFIG_PATH = Join-Path $RepoRoot "booth.config.json"
node dist\tray\trayApp.js
Pop-Location
