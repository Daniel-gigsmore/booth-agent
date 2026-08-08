<#
  Installs BoothAgent as a Windows service (via node-windows / sc.exe).
  Must be run from an elevated (Administrator) PowerShell prompt.

  Usage:
    cd booth-agent
    npm install
    npm run build
    .\install\install-service.ps1
#>

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator. Right-click PowerShell and 'Run as administrator', then re-run this script."
    exit 1
}

$ConfigPath = Join-Path $RepoRoot "booth.config.json"
if (-not (Test-Path $ConfigPath)) {
    Write-Error "booth.config.json not found at $ConfigPath. Copy booth.config.example.json to booth.config.json and fill it in first."
    exit 1
}

$DistEntry = Join-Path $RepoRoot "dist\index.js"
if (-not (Test-Path $DistEntry)) {
    Write-Host "dist\ not found - building first..."
    Push-Location $RepoRoot
    npm run build
    Pop-Location
}

Push-Location $RepoRoot
node dist\service\install.js
Pop-Location

Write-Host ""
Write-Host "Done. Check services.msc for 'BoothAgent', or run: Get-Service BoothAgent"
