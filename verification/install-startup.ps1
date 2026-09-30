$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$nodePath = (Get-Command node -ErrorAction Stop).Source
$userName = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$workerPath = Join-Path $PSScriptRoot 'worker.cjs'
$configPath = Join-Path $projectRoot '.verification-runtime/config.json'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'Local worker config is missing.' }
$nodePath | Set-Content -LiteralPath (Join-Path $projectRoot '.verification-runtime/node-path.txt') -Encoding UTF8
$hostPath = Join-Path $PSScriptRoot 'host-worker.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$hostPath`"" -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userName
$principal = New-ScheduledTaskPrincipal -UserId $userName -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'JUN Independent Verification Events' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Process new or changed posting events using isolated Codex contexts; no periodic company re-verification.' -Force | Select-Object TaskName,State
