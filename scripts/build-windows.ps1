param(
  [string]$BuildDir = "build-windows",
  [string]$Config = "Release"
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent
$distDir = Join-Path $repoRoot "dist"
$exeName = "niuma-merit.exe"
$version = (Get-Content (Join-Path $repoRoot "VERSION") -Raw).Trim()
$zipName = "niuma-merit-windows-$version-$Config.zip"
$gen = "Visual Studio 17 2022"

cmake -S $repoRoot -B $BuildDir -G $gen -A x64
cmake --build $BuildDir --config $Config

$srcExe = Join-Path $repoRoot "$BuildDir\$Config\niuma-merit.exe"
if (-not (Test-Path $srcExe)) {
  $srcExe = Join-Path $repoRoot "$BuildDir\src\windows\$Config\niuma-merit.exe"
}
if (-not (Test-Path $srcExe)) {
  $srcExe = Join-Path $repoRoot "$BuildDir\src\niuma-merit.exe"
}
if (-not (Test-Path $srcExe)) {
  throw "Could not locate built exe: $srcExe"
}

New-Item -ItemType Directory -Force -Path $distDir | Out-Null
$distExe = Join-Path $distDir $exeName
Copy-Item $srcExe $distExe -Force

$zipPath = Join-Path $distDir $zipName
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path $distExe -DestinationPath $zipPath -Force

"EXE=$distExe"
"ZIP=$zipPath"
"EXE_BYTES=$( (Get-Item $distExe).Length )"
"ZIP_BYTES=$( (Get-Item $zipPath).Length )"
