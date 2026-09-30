$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$runtimePath = Join-Path $projectRoot '.verification-runtime'
$configPath = Join-Path $runtimePath 'config.json'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'Local worker config is missing.' }
$workerPath = Join-Path $PSScriptRoot 'worker.cjs'
$pidPath = Join-Path $runtimePath 'worker.pid'
if (Test-Path -LiteralPath $pidPath) {
    $workerPid = [int](Get-Content -LiteralPath $pidPath)
    $existingWorker = Get-CimInstance Win32_Process -Filter "ProcessId=$workerPid" -ErrorAction SilentlyContinue
    if ($existingWorker -and $existingWorker.CommandLine.Contains($workerPath)) {
        Write-Output "Worker already running: $workerPid"
        exit 0
    }
}
$nodePath = (Get-Command node -ErrorAction Stop).Source
$workerProcess = Start-Process -FilePath $nodePath -ArgumentList @("`"$workerPath`"", "`"$configPath`"") -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'stdout.log') -RedirectStandardError (Join-Path $runtimePath 'stderr.log') -PassThru
Write-Output "Worker started: $($workerProcess.Id)"
