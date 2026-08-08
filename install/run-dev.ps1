<#
  Runs BoothAgent directly in the current console (no service, no build step)
  for development and for testing acceptance criteria interactively.
  Ctrl+C to stop.
#>

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

$ConfigPath = Join-Path $RepoRoot "booth.config.json"
if (-not (Test-Path $ConfigPath)) {
    Write-Error "booth.config.json not found at $ConfigPath. Copy booth.config.example.json to booth.config.json and fill it in first."
    exit 1
}

Push-Location $RepoRoot
$env:BOOTH_CONFIG_PATH = $ConfigPath
npm run dev
Pop-Location
