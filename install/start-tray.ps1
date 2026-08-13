<#
  Starts the optional tray status icon. This does NOT run the agent itself -
  it polls the already-running agent's /health endpoint. Safe to start,
  stop, or skip entirely; the booth works the same either way.

  This is a plain PowerShell/.NET NotifyIcon, not a Node process. It used to
  be `node dist\tray\trayApp.js` driving the `systray2` npm package, which
  wraps a prebuilt Go binary (tray_windows_release.exe) and talks to it over
  a stdin/stdout JSON protocol. That binary was confirmed (see git history /
  old README "Known limitations") to silently drop menu click events on
  Windows in every configuration tried, and since it ships prebuilt with no
  source in the npm package, it couldn't be patched - only worked around.
  NotifyIcon's clicks go through the normal WinForms message loop instead of
  a third-party stdio bridge, which is what actually fixes it.

  For it to start automatically at login, place a shortcut to this script
  (or `powershell.exe -File install\start-tray.ps1`) in:
    shell:startup
#>

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Icon.Dispose() does NOT release a handle obtained via Bitmap.GetHicon() -
# per the .NET docs, that handle must be freed explicitly with DestroyIcon
# or every 3s poll leaks a GDI handle for the life of the process.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BoothTrayNative {
    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr handle);
}
"@

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = $env:BOOTH_CONFIG_PATH
if (-not $ConfigPath) { $ConfigPath = Join-Path $RepoRoot "booth.config.json" }

function Get-BoothConfig {
    Get-Content -Raw -Path $ConfigPath | ConvertFrom-Json
}

$colorMap = @{
    green = [System.Drawing.Color]::FromArgb(255, 34, 176, 90)
    amber = [System.Drawing.Color]::FromArgb(255, 224, 158, 30)
    red   = [System.Drawing.Color]::FromArgb(255, 210, 60, 60)
    gray  = [System.Drawing.Color]::FromArgb(255, 140, 140, 140)
}

function New-StatusIcon([string]$Color) {
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.SolidBrush ($colorMap[$Color])
    $g.FillEllipse($brush, 1, 1, 30, 30)
    $brush.Dispose()
    $g.Dispose()
    $hIcon = $bmp.GetHicon()
    $bmp.Dispose()
    [PSCustomObject]@{ Icon = [System.Drawing.Icon]::FromHandle($hIcon); Handle = $hIcon }
}

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Text = "Booth Agent - starting..."
$notifyIcon.Visible = $true
$script:currentIconHandle = [IntPtr]::Zero

function Set-TrayIcon([string]$Color) {
    $result = New-StatusIcon $Color
    $notifyIcon.Icon = $result.Icon
    if ($script:currentIconHandle -ne [IntPtr]::Zero) {
        [void][BoothTrayNative]::DestroyIcon($script:currentIconHandle)
    }
    $script:currentIconHandle = $result.Handle
}
Set-TrayIcon "gray"

$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip
$titleItem = New-Object System.Windows.Forms.ToolStripMenuItem "Booth Agent"
$titleItem.Enabled = $false
$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem "Checking status..."
$statusItem.Enabled = $false
$openFolderItem = New-Object System.Windows.Forms.ToolStripMenuItem "Open Data Folder"
$quitItem = New-Object System.Windows.Forms.ToolStripMenuItem "Quit tray (agent keeps running)"
[void]$contextMenu.Items.Add($titleItem)
[void]$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$contextMenu.Items.Add($statusItem)
[void]$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$contextMenu.Items.Add($openFolderItem)
[void]$contextMenu.Items.Add($quitItem)
$notifyIcon.ContextMenuStrip = $contextMenu

$openFolderItem.Add_Click({
    $cfg = Get-BoothConfig
    Start-Process -FilePath "explorer.exe" -ArgumentList ('"' + $cfg.storage.dataDir + '"')
})

$quitItem.Add_Click({
    $timer.Stop()
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

function Set-TrayStatusText([string]$Text) {
    $maxLen = 63
    if ($Text.Length -gt $maxLen) {
        $notifyIcon.Text = $Text.Substring(0, $maxLen)
    } else {
        $notifyIcon.Text = $Text
    }
}

function Poll-BoothHealth {
    $cfg = Get-BoothConfig
    $port = $cfg.agent.port
    $secret = $cfg.agent.sharedSecret
    $statusLine = "Agent unreachable"
    $color = "red"

    try {
        $headers = @{ Authorization = "Bearer $secret" }
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -Headers $headers -TimeoutSec 2 -ErrorAction Stop
        $cameraOk = $health.camera.activeSource -ne "none"
        $onPreferred = $health.camera.activeSource -eq $health.camera.preference
        $hotFolderOk = $health.hotFolder.writable

        if (-not $cameraOk -or -not $hotFolderOk) {
            $color = "red"
        } elseif ((-not $onPreferred) -or $health.outbox.lastError) {
            $color = "amber"
        } else {
            $color = "green"
        }
        $hotFolderText = if ($hotFolderOk) { "ok" } else { "UNWRITABLE" }
        $statusLine = "Camera: $($health.camera.activeSource) | Hot folder: $hotFolderText | Outbox: $($health.outbox.queueDepth) pending"
    } catch {
        $color = "red"
    }

    $statusItem.Text = $statusLine
    Set-TrayStatusText $statusLine
    Set-TrayIcon $color
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({ Poll-BoothHealth })
$timer.Start()
Poll-BoothHealth

[System.Windows.Forms.Application]::Run()
