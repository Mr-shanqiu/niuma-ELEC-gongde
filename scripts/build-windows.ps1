param(
  [string]$BuildDir = 'build-windows',
  [string]$Config = 'Release',
  [switch]$ClientOnly,
  [string]$SignedFixtureDir = 'ci/windows-perpetual-fixtures',
  [string]$ExpectedVersion = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent
$buildRoot = if ([IO.Path]::IsPathRooted($BuildDir)) { $BuildDir } else { Join-Path $repoRoot $BuildDir }
$distDir = Join-Path $repoRoot 'dist'
$version = (Get-Content (Join-Path $repoRoot 'VERSION') -Raw).Trim()
if ($ExpectedVersion -and $version -ne $ExpectedVersion) { throw 'Source version does not match the release version' }
if ($env:GITHUB_ENV) { Add-Content -LiteralPath $env:GITHUB_ENV -Value 'WINDOWS_PERPETUAL_STATUS=NOT_RUN' -Encoding utf8 }

# Compile the production GUI only, without injecting test trust anchors.
& cmake -S $repoRoot -B $buildRoot -G 'Visual Studio 17 2022' -A x64
if ($LASTEXITCODE -ne 0) { throw 'CMake configuration failed' }
& cmake --build $buildRoot --config $Config --target niuma-merit
if ($LASTEXITCODE -ne 0) { throw 'Windows client compilation failed' }
$srcExe = @(
  (Join-Path $buildRoot "$Config/niuma-merit.exe"),
  (Join-Path $buildRoot "src/windows/$Config/niuma-merit.exe"),
  (Join-Path $buildRoot 'src/niuma-merit.exe')
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $srcExe) { throw 'Could not locate built client' }
New-Item -ItemType Directory -Force -Path $distDir | Out-Null
$distExe = Join-Path $distDir 'niuma-merit.exe'
Copy-Item -LiteralPath $srcExe -Destination $distExe -Force

$releaseEvidenceDir = Join-Path $buildRoot ('release-evidence-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $releaseEvidenceDir | Out-Null
$artifactArguments = @{
  ExecutablePath = $distExe; ExpectedVersion = $version; ArtifactKind = 'client'; Configuration = $Config;
  ReceiptPath = Join-Path $releaseEvidenceDir 'client-artifact.json'
}
& (Join-Path $repoRoot 'scripts/verify-windows-artifact.ps1') @artifactArguments
if ($env:GITHUB_ENV) { Add-Content -LiteralPath $env:GITHUB_ENV -Value "WINDOWS_RELEASE_EVIDENCE=$releaseEvidenceDir" -Encoding utf8 }
$zipPath = Join-Path $distDir "niuma-merit-windows-$version-$Config.zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -LiteralPath $distExe -DestinationPath $zipPath
$maximumBaseBytes = 10 * 1024 * 1024
if ((Get-Item $distExe).Length -ge $maximumBaseBytes -or (Get-Item $zipPath).Length -ge $maximumBaseBytes) {
  throw 'Windows base package exceeds the 10MB product limit'
}
"EXE=$distExe"
"ZIP=$zipPath"
"WINDOWS_RELEASE_EVIDENCE=$releaseEvidenceDir"
if ($ClientOnly) {
  'NORMAL_GUI_CLIENT_BUILD=PASS scope=compile-and-artifact-metadata-only'
  'IMPORTER_FIXTURES=NOT_RUN'
} else {
  & (Join-Path $repoRoot 'scripts/test-windows-perpetual.ps1') `
    -BuildDir $buildRoot -Config $Config -SignedFixtureDir $SignedFixtureDir `
    -ClientPath $distExe -ExpectedVersion $version -EvidenceDir $releaseEvidenceDir
}
'INSTALLED_NORMAL_GUI_ACCEPTANCE=NOT_RUN'
