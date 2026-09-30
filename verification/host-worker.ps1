# Keep Task Scheduler attached to the worker lifetime, with no visible console.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$runtimePath = Join-Path $projectRoot '.verification-runtime'
$nodePath = (Get-Content -LiteralPath (Join-Path $runtimePath 'node-path.txt') -Raw).Trim()
if (-not (Test-Path -LiteralPath $nodePath)) { throw 'Configured Node runtime was moved. Run install-startup.ps1 again.' }
$workerPath = Join-Path $PSScriptRoot 'worker.cjs'
$configPath = Join-Path $runtimePath 'config.json'
$pidPath = Join-Path $runtimePath 'worker.pid'
if (Test-Path -LiteralPath $pidPath) {
    $workerPid = [int](Get-Content -LiteralPath $pidPath)
    $existingWorker = Get-CimInstance Win32_Process -Filter "ProcessId=$workerPid" -ErrorAction SilentlyContinue
    if ($existingWorker -and $existingWorker.CommandLine.Contains($workerPath) -and $existingWorker.CommandLine.Contains($configPath)) {
        # Adopt the already-running worker instead of launching a duplicate.
        Wait-Process -Id $workerPid -ErrorAction SilentlyContinue
    }
}
$workerProcess = Start-Process -FilePath $nodePath -ArgumentList @("`"$workerPath`"", "`"$configPath`"") -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'stdout.log') -RedirectStandardError (Join-Path $runtimePath 'stderr.log') -Wait -PassThru
exit $workerProcess.ExitCode
