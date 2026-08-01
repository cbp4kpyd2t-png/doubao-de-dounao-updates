param(
  [Parameter(Mandatory=$true)][int]$ParentPid,
  [Parameter(Mandatory=$true)][string]$SourceDir,
  [Parameter(Mandatory=$true)][string]$InstallDir,
  [Parameter(Mandatory=$true)][string]$ExecutableName,
  [string]$LogFile = '',
  [string]$LaunchMarker = ''
)
$ErrorActionPreference = 'Stop'
if (-not $LogFile) { $LogFile = Join-Path (Split-Path -Parent $SourceDir) 'install.log' }

function Write-UpdateLog([string]$Message) {
  try { Add-Content -LiteralPath $LogFile -Value "$(Get-Date -Format o) $Message" -Encoding UTF8 } catch {}
}

function Copy-DirectoryContents([string]$From, [string]$To, [int]$Attempts = 6) {
  for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
    try {
      New-Item -ItemType Directory -Path $To -Force | Out-Null
      Get-ChildItem -LiteralPath $From -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $To -Recurse -Force }
      return
    } catch {
      Write-UpdateLog "copy attempt $attempt failed: $($_.Exception.Message)"
      if ($attempt -eq $Attempts) { throw }
      Start-Sleep -Milliseconds (500 * $attempt)
    }
  }
}

function Remove-DirectoryBestEffort([string]$Target) {
  for ($attempt = 1; $attempt -le 4; $attempt += 1) {
    try { if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }; return } catch { Start-Sleep -Milliseconds (400 * $attempt) }
  }
}

Write-UpdateLog "installer started; parent=$ParentPid source=$SourceDir install=$InstallDir"
if ($LaunchMarker) {
  try { Set-Content -LiteralPath $LaunchMarker -Value "started $(Get-Date -Format o) pid=$PID" -Encoding ASCII }
  catch { Write-UpdateLog "failed to create launch marker: $($_.Exception.Message)"; throw }
}
$installPrefix = ([System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\') + '\')
$deadline = (Get-Date).AddSeconds(15)
do {
  $remaining = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $PID -and $_.ExecutablePath -and
    ([System.IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($installPrefix, [System.StringComparison]::OrdinalIgnoreCase))
  })
  if ($remaining.Count -eq 0) { break }
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)
if ($remaining.Count -gt 0) {
  Write-UpdateLog "forcing remaining app processes to exit: $($remaining.ProcessId -join ',')"
  foreach ($process in $remaining) {
    try { Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop }
    catch { Write-UpdateLog "failed to stop process $($process.ProcessId): $($_.Exception.Message)" }
  }
  Start-Sleep -Milliseconds 1000
  $stillRunning = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $PID -and $_.ExecutablePath -and
    ([System.IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($installPrefix, [System.StringComparison]::OrdinalIgnoreCase))
  })
  if ($stillRunning.Count -gt 0) { throw "Unable to stop old application processes: $($stillRunning.ProcessId -join ',')" }
}

$backupDir = "$InstallDir.update-backup"
try {
  Remove-DirectoryBestEffort $backupDir
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  if (Test-Path -LiteralPath $InstallDir) { Copy-DirectoryContents $InstallDir $backupDir }
  Copy-DirectoryContents $SourceDir $InstallDir
  $exe = Join-Path $InstallDir $ExecutableName
  if (-not (Test-Path -LiteralPath $exe)) { throw "Updated executable was not found: $exe" }
  Write-UpdateLog 'installation completed successfully'
  Remove-DirectoryBestEffort $backupDir
  Start-Process -FilePath $exe -WorkingDirectory $InstallDir
} catch {
  Write-UpdateLog "installation failed: $($_.Exception.ToString())"
  if (Test-Path -LiteralPath $backupDir) {
    try { Copy-DirectoryContents $backupDir $InstallDir } catch { Write-UpdateLog "rollback failed: $($_.Exception.ToString())" }
    $oldExe = Join-Path $InstallDir $ExecutableName
    if (Test-Path -LiteralPath $oldExe) { Start-Process -FilePath $oldExe -WorkingDirectory $InstallDir }
  }
  throw
}
