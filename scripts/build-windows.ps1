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
$luckyCatPack = Join-Path $fixtureDir "lucky-cat-schema3.nmgpack"
python (Join-Path $repoRoot "scripts\appearance-pack.py") build `
  (Join-Path $repoRoot "assets\appearance-packs\lucky-cat") $luckyCatPack
if ($LASTEXITCODE -ne 0) { throw "Could not build schema-3 lucky cat fixture" }
$batchSource = Join-Path $fixtureDir "batch-source"
New-Item -ItemType Directory -Force -Path $batchSource | Out-Null
Copy-Item $fixturePack (Join-Path $batchSource "woodfish-sample.nmgpack") -Force
Copy-Item $luckyCatPack (Join-Path $batchSource "lucky-cat.nmgpack") -Force
$batchZip = Join-Path $fixtureDir "two-packs.zip"
$batchArchive = Join-Path $fixtureDir "two-packs.nmgpacks"
if (Test-Path $batchArchive) { Remove-Item $batchArchive -Force }
Compress-Archive -Path (Join-Path $batchSource "*.nmgpack") -DestinationPath $batchZip -Force
Move-Item $batchZip $batchArchive -Force
python -c "import zipfile,sys; print('BATCH_ENTRIES=' + ','.join(zipfile.ZipFile(sys.argv[1]).namelist()))" $batchArchive

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
Write-Host "SINGLE_PACK_EXIT=$LASTEXITCODE"
if ($LASTEXITCODE -ne 0) { throw "Single appearance pack runtime test failed" }
$batchInstallDir = Join-Path $fixtureDir "installed-batch"
New-Item -ItemType Directory -Force -Path $batchInstallDir | Out-Null
& $packTest $batchInstallDir $fixturePack $batchArchive
Write-Host "BATCH_PACK_EXIT=$LASTEXITCODE"
if ($LASTEXITCODE -ne 0) { throw "Batch appearance pack runtime test failed" }
$catInstallDir = Join-Path $fixtureDir "installed-lucky-cat"
New-Item -ItemType Directory -Force -Path $catInstallDir | Out-Null
& $packTest $catInstallDir $luckyCatPack
if ($LASTEXITCODE -ne 0) { throw "Schema-3 lucky cat runtime test failed" }

# Exercise the same production importer with free-community formats on Windows.
# These are explicitly synthetic fixtures, not a production moderation receipt.
$communityRun = "windows-" + [Guid]::NewGuid().ToString("N")
$communityDir = Join-Path $fixtureDir ("community-runtime-" + $communityRun)
python (Join-Path $repoRoot "scripts\generate-free-community-runtime-fixtures.py") `
  --output-dir $communityDir --run-id $communityRun
if ($LASTEXITCODE -ne 0) { throw "Could not prepare community runtime fixtures" }
$communityResults = New-Object System.Collections.Generic.List[object]
$communityReport = Join-Path $communityDir "runtime-results.json"
$communityCases = @(
  @{ Name = "schema1"; Single = "community-schema1.nmgpack"; Batch = $null; Reject = $false },
  @{ Name = "schema3"; Single = "community-schema3.nmgpack"; Batch = $null; Reject = $false },
  @{ Name = "two-works"; Single = "community-schema1.nmgpack"; Batch = "community-two-works.nmgpacks"; Reject = $false },
  @{ Name = "reserved-identity"; Single = "negative-reserved-identity.nmgpack"; Batch = $null; Reject = $true },
  @{ Name = "pending-review"; Single = "negative-pending-review.nmgpack"; Batch = $null; Reject = $true },
  @{ Name = "invalid-png"; Single = "negative-invalid-png.nmgpack"; Batch = $null; Reject = $true }
)
try {
  foreach ($case in $communityCases) {
    $installDir = Join-Path $communityDir ("installed-" + $case.Name)
    New-Item -ItemType Directory -Path $installDir | Out-Null
    $stdout = Join-Path $communityDir ($case.Name + ".stdout.log")
    $stderr = Join-Path $communityDir ($case.Name + ".stderr.log")
    $testArguments = @($installDir, (Join-Path $communityDir $case.Single))
    if ($case.Batch) { $testArguments += Join-Path $communityDir $case.Batch }
    $quotedArguments = $testArguments | ForEach-Object { '"' + $_ + '"' }
    # Own the process handle from Start(), including fast-exiting native tests.
    # Drain both redirected streams asynchronously so neither pipe can block.
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $packTest
    $startInfo.Arguments = $quotedArguments -join " "
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $child = New-Object System.Diagnostics.Process
    $child.StartInfo = $startInfo
    try {
      if (-not $child.Start()) { throw "Could not start community native test" }
      $stdoutRead = $child.StandardOutput.ReadToEndAsync()
      $stderrRead = $child.StandardError.ReadToEndAsync()
      $completed = $child.WaitForExit(30000)
      if (-not $completed) {
        $child.Kill()
        $child.WaitForExit(5000) | Out-Null
        $communityResults.Add(@{ case = $case.Name; result = "TIMEOUT" })
        throw "Community native test exceeded its 30-second bound"
      }
      $child.WaitForExit()
      $exit = $child.ExitCode
      $stdoutText = $stdoutRead.GetAwaiter().GetResult()
      $stderrText = $stderrRead.GetAwaiter().GetResult()
      $encoding = New-Object System.Text.UTF8Encoding($false)
      [System.IO.File]::WriteAllText($stdout, $stdoutText, $encoding)
      [System.IO.File]::WriteAllText($stderr, $stderrText, $encoding)
      $output = $stdoutText + $stderrText
    } finally { $child.Dispose() }
    Write-Host $output
    # A later render failure is not proof that the importer rejected the input.
    $passed = if ($case.Reject) {
      $exit -eq 1 -and $output -match "SINGLE_FIRST result=0 installed=0 id_empty=1"
    } else {
      $exit -eq 0 -and $output -match "PASS "
    }
    $communityResults.Add(@{ case = $case.Name; result = $(if ($passed) { "PASS" } else { "FAIL" });
      exitCode = $exit; expectedInitialRejection = $case.Reject;
      inputSha256 = (Get-FileHash (Join-Path $communityDir $case.Single) -Algorithm SHA256).Hash.ToLowerInvariant();
      stdout = $stdout; stderr = $stderr })
    if (-not $passed) { throw "Community native runtime case failed: $($case.Name)" }
  }
} finally {
  $report = @{ schema = "gongde-free-community-windows-runtime.v1"; version = $version;
    importer = "Actual Windows AppearanceCatalog/GDI+ production sources";
    scope = "Synthetic community native import/reimport/render/rejection; not production submission or GUI/installer acceptance";
    expectedCases = $communityCases.Count; executedCases = $communityResults.Count; cases = @($communityResults.ToArray()) }
  [System.IO.File]::WriteAllText($communityReport, ($report | ConvertTo-Json -Depth 8),
    (New-Object System.Text.UTF8Encoding($false)))
}
"COMMUNITY_NATIVE_TEST=PASS cases=$($communityResults.Count)"
"COMMUNITY_NATIVE_REPORT=$communityReport"

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

$releaseEvidenceDir = Join-Path $repoRoot ("$BuildDir\release-evidence-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $releaseEvidenceDir | Out-Null
$artifactArguments = @{
  ExecutablePath = $distExe
  ExpectedVersion = $version
  ArtifactKind = 'client'
  Configuration = $Config
  ReceiptPath = Join-Path $releaseEvidenceDir 'client-artifact.json'
}
& (Join-Path $repoRoot 'scripts\verify-windows-artifact.ps1') @artifactArguments
if ($env:GITHUB_ENV) {
  Add-Content -LiteralPath $env:GITHUB_ENV -Value "WINDOWS_RELEASE_EVIDENCE=$releaseEvidenceDir" -Encoding utf8
}
"WINDOWS_RELEASE_EVIDENCE=$releaseEvidenceDir"

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
"APPEARANCE_BATCH_TEST=PASS"
"LUCKY_CAT_SCHEMA3_TEST=PASS"
