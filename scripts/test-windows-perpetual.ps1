param(
  [string]$BuildDir = 'build-windows',
  [string]$Config = 'Release',
  [string]$SignedFixtureDir = 'ci/windows-perpetual-fixtures',
  [Parameter(Mandatory = $true)][string]$ClientPath,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [Parameter(Mandatory = $true)][string]$EvidenceDir
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent
$buildRoot = if ([IO.Path]::IsPathRooted($BuildDir)) { $BuildDir } else { Join-Path $repoRoot $BuildDir }
$runDir = Join-Path $buildRoot ('pack-fixtures/perpetual-runtime-' + [Guid]::NewGuid().ToString('N'))
$encoding = New-Object System.Text.UTF8Encoding($false)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $runDir) | Out-Null
foreach ($dependency in @('python', 'node', 'cmake')) {
  if (-not (Get-Command $dependency -ErrorAction SilentlyContinue)) { throw "Missing runtime test dependency: $dependency" }
}
if ((Get-Content (Join-Path $repoRoot 'VERSION') -Raw).Trim() -ne $ExpectedVersion) { throw 'Runtime test version differs from source version' }
$artifactArguments = @{
  ExecutablePath = $ClientPath; ExpectedVersion = $ExpectedVersion; ArtifactKind = 'client'; Configuration = $Config;
  ReceiptPath = Join-Path $EvidenceDir 'perpetual-client-artifact.json'
}
& (Join-Path $repoRoot 'scripts/verify-windows-artifact.ps1') @artifactArguments
$results = New-Object System.Collections.Generic.List[object]
$reportPath = Join-Path $EvidenceDir 'perpetual-runtime.json'
$report = @{
  schema = 'gongde-windows-perpetual-runtime.v1'; version = $ExpectedVersion; status = 'FAIL';
  clientSha256 = (Get-FileHash -LiteralPath $ClientPath -Algorithm SHA256).Hash.ToLowerInvariant();
  clientBinding = 'perpetual-client-artifact.json'; fixtureReceipt = (Join-Path $runDir 'fixture-receipt.json');
  scope = 'Actual production Windows importer: signed import/reimport/reload/render and initial tamper rejection; not installed GUI acceptance';
  productionTestKeyInjected = $false; expectedCases = 0; cases = @()
}
try {
  & python (Join-Path $repoRoot 'scripts/generate-windows-perpetual-fixtures.py') `
    --repo-root $repoRoot --signed-fixture-dir $SignedFixtureDir --output-dir $runDir --expected-version $ExpectedVersion
  if ($LASTEXITCODE -ne 0) { throw 'Frozen signed fixture preparation failed' }
  $fixture = Get-Content (Join-Path $runDir 'fixture-receipt.json') -Raw | ConvertFrom-Json
  if ($fixture.status -ne 'READY') {
    $report.status = 'BLOCKED_SIGNED_FIXTURES'
    $report.missing = @($fixture.missing)
    Write-Warning ('Only the normal client was built. Parent must supply frozen signed fixtures: ' + ($fixture.missing -join ', '))
    if ($env:GITHUB_ENV) { Add-Content -LiteralPath $env:GITHUB_ENV -Value 'WINDOWS_PERPETUAL_STATUS=BLOCKED_SIGNED_FIXTURES' -Encoding utf8 }
    return
  }
  $sourceFiles = @('src/windows/appearance_pack.cpp', 'src/windows/appearance_pack.h',
    'third_party/miniz/miniz.c', 'third_party/miniz/miniz.h', 'CMakeLists.txt')
  $bindings = @{}
  foreach ($file in $sourceFiles) { $bindings[$file] = (Get-FileHash (Join-Path $repoRoot $file) -Algorithm SHA256).Hash.ToLowerInvariant() }
  $report.productionSourceSha256 = $bindings
  $nativeBuild = Join-Path $runDir 'native-build'
  & cmake -S $runDir -B $nativeBuild -G 'Visual Studio 17 2022' -A x64 "-DNIUMA_REPO_ROOT=$($repoRoot.Replace('\', '/'))"
  if ($LASTEXITCODE -ne 0) { throw 'Production importer sidecar configuration failed' }
  & cmake --build $nativeBuild --config $Config --target niuma-perpetual-import-test
  if ($LASTEXITCODE -ne 0) { throw 'Production importer sidecar compilation failed' }
  $testExe = Join-Path $nativeBuild "$Config/niuma-perpetual-import-test.exe"
  $report.testExecutableSha256 = (Get-FileHash $testExe -Algorithm SHA256).Hash.ToLowerInvariant()
  $report.expectedCases = @($fixture.cases).Count
  foreach ($case in $fixture.cases) {
    $inputPath = Join-Path $runDir $case.file
    if ((Get-FileHash $inputPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $case.sha256) { throw 'Fixture bytes changed after freezing' }
    $installDir = Join-Path $runDir ('installed-' + $case.name)
    New-Item -ItemType Directory -Path $installDir | Out-Null
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $testExe
    $info.Arguments = (@($case.expect, $installDir, $inputPath) | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $child = New-Object System.Diagnostics.Process
    $child.StartInfo = $info
    $record = @{ name = $case.name; expected = $case.expect; inputSha256 = $case.sha256; status = 'FAIL' }
    $results.Add($record)
    try {
      if (-not $child.Start()) { throw 'Could not start production importer sidecar' }
      $outRead = $child.StandardOutput.ReadToEndAsync()
      $errRead = $child.StandardError.ReadToEndAsync()
      if (-not $child.WaitForExit(30000)) {
        $record.status = 'TIMEOUT'; $child.Kill(); $child.WaitForExit(5000) | Out-Null
        throw 'Production importer case exceeded 30 seconds'
      }
      $child.WaitForExit()
      $stdout = $outRead.GetAwaiter().GetResult(); $stderr = $errRead.GetAwaiter().GetResult()
      [IO.File]::WriteAllText((Join-Path $runDir ($case.name + '.stdout.log')), $stdout, $encoding)
      [IO.File]::WriteAllText((Join-Path $runDir ($case.name + '.stderr.log')), $stderr, $encoding)
      $record.exitCode = $child.ExitCode
      $marker = if ($case.expect -eq 'reject') { 'IMPORT_REJECT_PASS' } else { 'IMPORT_ACCEPT_PASS' }
      if ($child.ExitCode -ne 0 -or $stdout -notmatch $marker) { throw "Production importer case failed: $($case.name)" }
      if ($case.expect -eq 'reject' -and @(Get-ChildItem -LiteralPath $installDir -Recurse -File).Count -ne 0) { throw 'Rejected package left persistent files' }
      $record.status = 'PASS'
    } finally { $child.Dispose() }
  }
  foreach ($file in $sourceFiles) {
    if ((Get-FileHash (Join-Path $repoRoot $file) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $bindings[$file]) { throw 'Production source changed during runtime audit' }
  }
  if ((Get-FileHash -LiteralPath $ClientPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $report.clientSha256) { throw 'Client bytes changed during runtime audit' }
  $report.status = 'PASS'
  if ($env:GITHUB_ENV) { Add-Content -LiteralPath $env:GITHUB_ENV -Value 'WINDOWS_PERPETUAL_STATUS=PASS' -Encoding utf8 }
  "WINDOWS_PERPETUAL_RUNTIME=PASS cases=$($results.Count) version=$ExpectedVersion"
} finally {
  $report.cases = @($results.ToArray())
  [IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 10), $encoding)
  if (Test-Path -LiteralPath $runDir) { [IO.File]::WriteAllText((Join-Path $runDir 'runtime-results.json'), ($report | ConvertTo-Json -Depth 10), $encoding) }
}
