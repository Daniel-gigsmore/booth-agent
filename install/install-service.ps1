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
    # $ErrorActionPreference = "Stop" only governs PowerShell cmdlets/exceptions -
    # it does NOT stop the script when a native command like npm exits non-zero,
    # so a failed build would otherwise fall straight through to installing
    # whatever (possibly stale, possibly absent) dist\ already exists.
    $buildExitCode = $LASTEXITCODE
    Pop-Location
    if ($buildExitCode -ne 0) {
        Write-Error "npm run build failed (exit $buildExitCode) - fix the build before installing the service."
        exit 1
    }
}

Push-Location $RepoRoot
node dist\service\install.js
$installExitCode = $LASTEXITCODE
Pop-Location
if ($installExitCode -ne 0) {
    Write-Error "Service install failed (node dist\service\install.js exited $installExitCode) - see output above. Not printing 'Done'."
    exit 1
}

Write-Host ""
Write-Host "Done. Check services.msc for 'BoothAgent', or run: Get-Service boothagent.exe"
Write-Host "(BoothAgent is the service's DisplayName - Get-Service/Restart-Service/Stop-Service need the actual Name, boothagent.exe.)"
