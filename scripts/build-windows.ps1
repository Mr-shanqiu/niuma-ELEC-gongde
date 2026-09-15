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

$fixtureDir = Join-Path $repoRoot "$BuildDir\pack-fixtures"
New-Item -ItemType Directory -Force -Path $fixtureDir | Out-Null
$fixturePack = Join-Path $fixtureDir "woodfish-sample.nmgpack"
python (Join-Path $repoRoot "scripts\appearance-pack.py") build `
  (Join-Path $repoRoot "assets\appearance-packs\woodfish-sample") $fixturePack
if ($LASTEXITCODE -ne 0) { throw "Could not build appearance pack fixture" }

cmake -S $repoRoot -B $BuildDir -G $gen -A x64
if ($LASTEXITCODE -ne 0) { throw "CMake configuration failed" }
cmake --build $BuildDir --config $Config
if ($LASTEXITCODE -ne 0) { throw "Windows compilation failed" }

$packTest = Join-Path $repoRoot "$BuildDir\$Config\niuma-pack-test.exe"
if (-not (Test-Path $packTest)) {
  $packTest = Join-Path $repoRoot "$BuildDir\src\windows\$Config\niuma-pack-test.exe"
}
if (-not (Test-Path $packTest)) { throw "Could not locate appearance pack test" }
$testInstallDir = Join-Path $fixtureDir "installed"
New-Item -ItemType Directory -Force -Path $testInstallDir | Out-Null
& $packTest $testInstallDir $fixturePack
if ($LASTEXITCODE -ne 0) { throw "Appearance pack runtime test failed" }

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

$maximumBaseBytes = 10 * 1024 * 1024
if ((Get-Item $distExe).Length -ge $maximumBaseBytes -or
    (Get-Item $zipPath).Length -ge $maximumBaseBytes) {
  throw "Windows base package exceeds the 10MB product limit"
}

"EXE=$distExe"
"ZIP=$zipPath"
"EXE_BYTES=$( (Get-Item $distExe).Length )"
"ZIP_BYTES=$( (Get-Item $zipPath).Length )"
"APPEARANCE_PACK_TEST=PASS"
