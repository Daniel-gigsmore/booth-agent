<#
  Builds installer\Kachak Booth Setup <version>.exe - booth-agent (the Windows
  service) and the kiosk app in one installer - from the committed HEAD
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

    # The kiosk app. It reads the port, the shared secret and the download link from booth.config.json
    # at runtime, so nothing secret is built in. The git archive has no .env files; the only value taken
    # from this checkout's kiosk\.env.local is VITE_DOWNLOAD_URL, as the fallback for booths whose
    # booth.config.json has no kiosk.downloadUrl yet.
    $env:VITE_AGENT_TOKEN = ""
    $env:VITE_AGENT_URL = ""
    $env:VITE_DOWNLOAD_URL = ""
    $EnvLocal = Join-Path $Repo "kiosk\.env.local"
    if (Test-Path $EnvLocal) {
        $Line = Get-Content $EnvLocal | Where-Object { $_ -match '^\s*VITE_DOWNLOAD_URL\s*=' } | Select-Object -Last 1
        if ($Line) { $env:VITE_DOWNLOAD_URL = ($Line -split '=', 2)[1].Trim().Trim('"') }
    }
    Push-Location kiosk
    try {
        Invoke-Step "kiosk npm ci" { npm ci }
        Invoke-Step "kiosk build" { npm run build }
        Invoke-Step "kiosk electron-builder" { npx electron-builder --win --dir }
        if (-not (Test-Path "installer\win-unpacked\Kachak Kiosk.exe")) { throw "electron-builder did not produce Kachak Kiosk.exe" }
    } finally {
        Pop-Location
        Remove-Item Env:VITE_AGENT_TOKEN, Env:VITE_AGENT_URL, Env:VITE_DOWNLOAD_URL -ErrorAction SilentlyContinue
    }
} finally {
    Pop-Location
}

$Version = (Get-Content "$Stage\package.json" -Raw | ConvertFrom-Json).version
Invoke-Step "ISCC" { & $Iscc "/DAppVersion=$Version" "/DStage=$Stage" "/DNodeExe=$Node" "/DOutDir=$Out" (Join-Path $PSScriptRoot "booth-agent.iss") }
Remove-Item $Stage -Recurse -Force
Write-Host "Installer: $Out\Kachak Booth Setup $Version.exe"
