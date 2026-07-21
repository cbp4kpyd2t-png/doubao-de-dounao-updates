$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$packageJson = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$source = Join-Path $root 'dist\win-unpacked'
$mainExe = Join-Path $source "$($packageJson.build.productName).exe"
if (-not (Test-Path -LiteralPath $mainExe)) { throw 'Run npm run pack first.' }
$output = Join-Path $root 'dist\update'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$zipName = "doubao-de-dounao-$($packageJson.version)-win-x64.zip"
$zip = Join-Path $output $zipName
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $source '*') -DestinationPath $zip -CompressionLevel Optimal
$stream = [System.IO.File]::OpenRead($zip)
try {
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try { $hash = ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $sha256.Dispose() }
} finally { $stream.Dispose() }
$releaseBaseUrl = $packageJson.update.releaseBaseUrl.TrimEnd('/')
$manifest = [ordered]@{
  version = $packageJson.version
  package = "$releaseBaseUrl/v$($packageJson.version)/$zipName"
  sha256 = $hash
  notes = 'Adaptive scheduling, workflow recovery, image quality checks and safe updates.'
  publishedAt = (Get-Date).ToUniversalTime().ToString('o')
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'update-manifest.json') -Encoding UTF8
Write-Host "Update package: $zip"
Write-Host "SHA256: $hash"
