<#
  Builds installer\BoothAgent Setup <version>.exe from the committed HEAD
  (uncommitted changes in this checkout are never packaged). Needs Node and
  Inno Setup 6. Does not touch this checkout's dist\ or node_modules\, so it
  is safe to run while the service is running from here.
#>

$ErrorActionPreference = "Stop"
$Repo = Split-Path -Parent $PSScriptRoot
$Stage = Join-Path $Repo "build\booth-agent"
$Out = Join-Path $Repo "installer"
$Iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
$Node = (Get-Command node).Source

function Invoke-Step([string]$What, [scriptblock]$Cmd) {
    & $Cmd
    if ($LASTEXITCODE) { throw "$What failed (exit $LASTEXITCODE)" }
}

if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Force $Stage | Out-Null
Invoke-Step "git archive" { git -C $Repo archive -o "$Stage.zip" HEAD }
Expand-Archive "$Stage.zip" $Stage
Remove-Item "$Stage.zip"

Push-Location $Stage
try {
    Invoke-Step "npm ci" { npm ci }
    Invoke-Step "npm run build" { npm run build }
    Invoke-Step "npm prune" { npm prune --omit=dev }
    Invoke-Step "native module check" { node -e "require('sharp'); require('koffi'); require('node-windows')" }
} finally {
    Pop-Location
}

$Version = (Get-Content "$Stage\package.json" -Raw | ConvertFrom-Json).version
Invoke-Step "ISCC" { & $Iscc "/DAppVersion=$Version" "/DStage=$Stage" "/DNodeExe=$Node" "/DOutDir=$Out" (Join-Path $PSScriptRoot "booth-agent.iss") }
Remove-Item $Stage -Recurse -Force
Write-Host "Installer: $Out\BoothAgent Setup $Version.exe"
