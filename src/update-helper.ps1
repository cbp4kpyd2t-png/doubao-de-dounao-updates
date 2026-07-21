param(
  [Parameter(Mandatory=$true)][int]$ParentPid,
  [Parameter(Mandatory=$true)][string]$SourceDir,
  [Parameter(Mandatory=$true)][string]$InstallDir,
  [Parameter(Mandatory=$true)][string]$ExecutableName
)
$ErrorActionPreference = 'Stop'
try { Wait-Process -Id $ParentPid -Timeout 120 -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Milliseconds 600
$backupDir = "$InstallDir.update-backup"
try {
  if (Test-Path -LiteralPath $backupDir) { Remove-Item -LiteralPath $backupDir -Recurse -Force }
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  if (Test-Path -LiteralPath $InstallDir) { Get-ChildItem -LiteralPath $InstallDir -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $backupDir -Recurse -Force } }
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  Get-ChildItem -LiteralPath $SourceDir -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $InstallDir -Recurse -Force }
  $exe = Join-Path $InstallDir $ExecutableName
  if (-not (Test-Path -LiteralPath $exe)) { throw "更新后未找到程序：$exe" }
  Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath $exe -WorkingDirectory $InstallDir
} catch {
  if (Test-Path -LiteralPath $backupDir) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Get-ChildItem -LiteralPath $backupDir -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $InstallDir -Recurse -Force }
    $oldExe = Join-Path $InstallDir $ExecutableName
    if (Test-Path -LiteralPath $oldExe) { Start-Process -FilePath $oldExe -WorkingDirectory $InstallDir }
  }
  throw
}
