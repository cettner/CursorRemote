<#
.SYNOPSIS
  Registers the Cursor Remote daemon to start automatically on this machine.

.DESCRIPTION
  Creates a Scheduled Task that launches the daemon at logon and restarts it if
  it stops. A Scheduled Task rather than a Windows service on purpose: the
  agents it runs need your user session, your PATH, your git credentials, and
  your Cursor login. A LocalSystem service has none of those.

  Run from the repo root:
    pwsh -File apps/daemon/scripts/install-service.ps1

.PARAMETER Remove
  Unregister the task instead of creating it.

.PARAMETER KeepAwake
  Also stop the machine sleeping while plugged in, so tool calls can still run
  when you are away from it. This is a machine-wide power setting.
#>
[CmdletBinding()]
param(
    [switch]$Remove,
    [switch]$KeepAwake
)

$ErrorActionPreference = "Stop"
$taskName = "CursorRemoteDaemon"

if ($Remove) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "Removed the $taskName task."
    }
    else {
        Write-Host "No $taskName task was registered."
    }
    return
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$entryPoint = Join-Path $repoRoot "apps\daemon\dist\index.js"

if (-not (Test-Path $entryPoint)) {
    throw "$entryPoint is missing. Run 'npm run build' in $repoRoot first."
}

$node = (Get-Command node -ErrorAction SilentlyContinue)?.Source
if (-not $node) {
    throw "node is not on PATH. Install Node 22.13 or later."
}

$config = Join-Path $env:USERPROFILE ".cursorremote\config.json"
if (-not (Test-Path $config)) {
    Write-Warning "$config does not exist yet. The daemon writes a starter one on first run; edit its projects list afterwards."
}

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$entryPoint`"" -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Defaults that matter: no battery-based throttling, no time limit, and a
# restart if the daemon ever falls over while you are away from the machine.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Runs the Cursor Remote daemon so other devices can reach this machine's agents." `
    -RunLevel Limited | Out-Null

Write-Host "Registered $taskName. It starts at your next logon."
Write-Host "Start it now with:  Start-ScheduledTask -TaskName $taskName"

if ($KeepAwake) {
    # Only the plugged-in profile: letting a laptop on battery stay awake in a
    # bag is a worse outcome than a missed agent run.
    powercfg /change standby-timeout-ac 0
    powercfg /change hibernate-timeout-ac 0
    Write-Host "This machine will no longer sleep while plugged in."
}
