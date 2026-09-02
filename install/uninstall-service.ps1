<#
  Uninstalls the BoothAgent Windows service.
  Must be run from an elevated (Administrator) PowerShell prompt.
#>

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator."
    exit 1
}

Push-Location $RepoRoot
node dist\service\uninstall.js
# $ErrorActionPreference = "Stop" doesn't apply to a native command's exit
# code - a failed uninstall would otherwise fall through silently.
$uninstallExitCode = $LASTEXITCODE
Pop-Location
if ($uninstallExitCode -ne 0) {
    Write-Error "Service uninstall failed (node dist\service\uninstall.js exited $uninstallExitCode) - see output above."
    exit 1
}
