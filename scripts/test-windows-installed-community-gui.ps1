#Requires -Version 5.1
<#
Frozen 0.8.4 installer / original SDK / normal installed GUI acceptance.
Run only on a fresh, isolated GitHub-hosted Windows runner with an observable
interactive desktop. This script does not build, download, sign, unblock,
change security policy, or call the native importer test executable.

SdkManifestPath is ordinary JSON, not executable PowerShell. Required format:
{
  "schema": "gongde-original-sdk-inputs.v2",
  "cases": [
    {"name":"amber","path":"frozen/amber.nmgpack","bytes":1116,
     "sha256":"72357f2b68b0807edb68aad817fa3df4d0bf0f97fa7816a52526d65df8c026c2",
     "schema":1,"expectedImportedCount":1,"sourceRecords":[{
       "id":"creator.25e87fe4266be12e737f029367ea9b41.accept-amber",
       "version":"1.0.0","reviewId":"8a0b766886e89707c1b1ff69e80fe285","schema":1,
       "sdkArchiveSha256":"72357f2b68b0807edb68aad817fa3df4d0bf0f97fa7816a52526d65df8c026c2",
       "sdkArchiveBytes":1116,"producerVersionId":"51f65e718216d11f38d2a7fb705f8ce2",
       "sourceRevision":"7faf42908436fde2545cf418f1763929d2bef53a096773ae13ff324ec79e41e4",
       "sourceArchiveSha256":"5c9ec2bf97c61dbe6e3e88aeb878c8a56ed7959832ac810714ef0ee3b6cfa14f",
       "sourceArchiveBytes":820}]},
    {"name":"green","path":"frozen/green.nmgpack","bytes":1187,
     "sha256":"552157a2793b85622b08744271d8041796d26b73ae14e8911f06ebf8d2ca37fb",
     "schema":3,"expectedImportedCount":1,"sourceRecords":[{
       "id":"creator.7672096b44ca35887c061df50eeb0649.community-qa-green",
       "version":"1.0.0","reviewId":"74225811126af6bcabb619658772a46f","schema":3,
       "sdkArchiveSha256":"552157a2793b85622b08744271d8041796d26b73ae14e8911f06ebf8d2ca37fb",
       "sdkArchiveBytes":1187,"producerVersionId":"cfd82375bb8af46efddc621f5321c69e",
       "sourceRevision":"8ca7f474f9223c6cd67ccaf91bc8abb6a0862947b913f18989b7de3c98b25a9d",
       "sourceArchiveSha256":"5fb48dee28c2f83400d00ba798c163d899cd70ed9609f373b6f7eeca28f43276",
       "sourceArchiveBytes":934}]},
    {"name":"pair","path":"frozen/pair.nmgpacks","bytes":2557,
     "sha256":"857681c49a5dc2e43a94c89ce26eddfd2f5a5bcab1d1b4371dc835bc1db25e7b",
     "schema":[1,3],"expectedImportedCount":2,"sourceRecords":[
       {"id":"creator.25e87fe4266be12e737f029367ea9b41.accept-amber",
        "version":"1.0.0","reviewId":"8a0b766886e89707c1b1ff69e80fe285","schema":1,
        "sdkArchiveSha256":"72357f2b68b0807edb68aad817fa3df4d0bf0f97fa7816a52526d65df8c026c2",
        "sdkArchiveBytes":1116,"producerVersionId":"51f65e718216d11f38d2a7fb705f8ce2",
        "sourceRevision":"7faf42908436fde2545cf418f1763929d2bef53a096773ae13ff324ec79e41e4",
        "sourceArchiveSha256":"5c9ec2bf97c61dbe6e3e88aeb878c8a56ed7959832ac810714ef0ee3b6cfa14f",
        "sourceArchiveBytes":820},
       {"id":"creator.7672096b44ca35887c061df50eeb0649.community-qa-green",
        "version":"1.0.0","reviewId":"74225811126af6bcabb619658772a46f","schema":3,
        "sdkArchiveSha256":"552157a2793b85622b08744271d8041796d26b73ae14e8911f06ebf8d2ca37fb",
        "sdkArchiveBytes":1187,"producerVersionId":"cfd82375bb8af46efddc621f5321c69e",
        "sourceRevision":"8ca7f474f9223c6cd67ccaf91bc8abb6a0862947b913f18989b7de3c98b25a9d",
        "sourceArchiveSha256":"5fb48dee28c2f83400d00ba798c163d899cd70ed9609f373b6f7eeca28f43276",
        "sourceArchiveBytes":934}]}
  ]
}
Paths are relative to the manifest, or absolute local file paths. sourceRecords
are caller-supplied records of previously observed external SDK producer
metadata, not locator/packaging receipts. Every record is aligned with the
actual SDK manifest id/version/review_id/schema_version and SDK bytes/digest.
The directly observed publisher must be community. producerVersionId,
sourceRevision and sourceArchiveSha256/sourceArchiveBytes are external-only:
the SDK manifest does not contain them, and this runner does NOT read or verify
the producer's original submission ZIP. Their formats are checked and pair's
records must exactly equal the corresponding single records, not an invented
single source. No archive provenance is independently authenticated here.
Pair must contain only community-01.nmgpack (amber) and community-02.nmgpack
(green), with distinct IDs/review IDs and unchanged original package digests.
The three frozen case sizes/digests remain pinned. No locator "passed" field
is consulted. All inputs are checked before installation. No input is rebuilt,
re-signed, extracted to a replacement package, or regenerated.

OutputDirectory must be new and below RUNNER_TEMP. Failure receipts, real
installer/uninstaller logs, process exit codes, native dialog text, catalog
digests and unmodified desktop screenshots remain there after cleanup.

Production entry evidence (no production test hooks):
src/windows/app.cpp: AppearancePackArgument(), wWinMain(),
ImportAppearancePack(), ShowPrivacyNoticeIfNeeded(). A file argument causes
the installed normal app to import and show its actual success/error dialog.
The single-pack success dialog is singular, without a numeric "1": count 1
is supported by its exact production text AND one digest-bound installed pack.
The batch success dialog explicitly reports the numeric imported count.
src/windows/appearance_pack.cpp: Install() copies original package bytes into
LocalAppData/NiuMaMerit/Appearances/<id>.nmgpack; InstallBatch() uses that catalog.
installer/windows/niuma-merit.iss: per-user Inno install; skipifsilent prevents
the postinstall auto-launch. /NOICONS avoids shared shortcuts.

This evidence is NOT anonymous website download, original production delivery,
public publication, F1/F2 acceptance, or goal completion.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$ExpectedInstallerSha256,
  [Parameter(Mandatory = $true)][string]$ExpectedClientSha256,
  [Parameter(Mandatory = $true)][string]$SdkManifestPath,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
    $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP) -or
    [string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ID)) {
  throw 'Refusing execution outside an isolated GitHub-hosted Windows runner.'
}

$frozenClientSha = 'b4c1c8e3b9e3130402446b88f9455cfe780c86e0dfb9135b0008e1af7ec14761'
$frozenSdk = @{
  amber = @{ sizeBytes = 1116; sha = '72357f2b68b0807edb68aad817fa3df4d0bf0f97fa7816a52526d65df8c026c2'
    schema = 1; expectedImportedCount = 1 }
  green = @{ sizeBytes = 1187; sha = '552157a2793b85622b08744271d8041796d26b73ae14e8911f06ebf8d2ca37fb'
    schema = 3; expectedImportedCount = 1 }
  pair = @{ sizeBytes = 2557; sha = '857681c49a5dc2e43a94c89ce26eddfd2f5a5bcab1d1b4371dc835bc1db25e7b'
    schema = @(1, 3); expectedImportedCount = 2 }
}
$sourceRecordFields = @('id', 'version', 'reviewId', 'schema', 'sdkArchiveSha256',
  'sdkArchiveBytes', 'producerVersionId', 'sourceRevision', 'sourceArchiveSha256', 'sourceArchiveBytes')
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$locks = [Collections.Generic.List[IO.FileStream]]::new()
$ownedProcesses = [Collections.Generic.List[object]]::new()
$inputs = [Collections.Generic.List[object]]::new()
$cleanupErrors = [Collections.Generic.List[string]]::new()
$runId = [Guid]::NewGuid().ToString('N')
$outputRoot = $null
$outputDirectoryOwned = $false
$receiptSequence = 0
$installDir = $null
$clientPath = $null
$dataRoot = $null
$catalogDir = $null
$clientStarted = $false
$isolationEstablished = $false
$installAttempted = $false
$uninstallerBinding = $null
$failure = $null
$phase = 'preflight'
$report = [ordered]@{
  schema = 'gongde-windows-installed-original-sdk-gui.v2'
  classification = 'ISOLATED_FROZEN_INSTALLER_AND_NORMAL_GUI_ONLY'
  runId = $runId
  startedAt = [DateTime]::UtcNow.ToString('o')
  workflowRunId = $env:GITHUB_RUN_ID
  workflowRunAttempt = $env:GITHUB_RUN_ATTEMPT
  result = 'FAIL'
  silentInstaller = $true
  interactiveInstallerUiObserved = $false
  actualGuiObserved = $false
  normalGuiImportObserved = $false
  guiAcceptancePassed = $false
  installer = $null
  installedClient = $null
  sdkManifest = $null
  inputs = @()
  desktop = $null
  cases = [Collections.Generic.List[object]]::new()
  processes = [Collections.Generic.List[object]]::new()
  cleanup = [ordered]@{ attempted = $false; complete = $false; errors = @() }
  failure = $null
  boundaries = [ordered]@{
    originalSdkArchiveProvenanceIndependentlyVerified = $false
    externalProducerMetadataIndependentlyAuthenticated = $false
    producerOriginalSubmissionArchivesRead = $false
    anonymousWebsiteDownloadVerified = $false
    originalProductionDeliveryVerified = $false
    publicReleaseVerified = $false
    f1Accepted = $false
    f2Accepted = $false
    goalComplete = $false
    securityPolicyChanged = $false
    signatureTrustBypassed = $false
    syntheticRuntimeHarnessUsed = $false
  }
}

function Assert-Condition([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Get-SafePath([string]$Path, [string]$Base = '') {
  Assert-Condition (-not [string]::IsNullOrWhiteSpace($Path)) 'A required path is empty.'
  Assert-Condition ($Path -notmatch '["\r\n\x00]' -and $Path -notmatch '^[\\/]{2}') `
    'Only ordinary local paths without quotes or control characters are allowed.'
  if ($Base -and -not [IO.Path]::IsPathRooted($Path)) { $Path = Join-Path $Base $Path }
  $full = [IO.Path]::GetFullPath($Path)
  Assert-Condition ($full -match '^[A-Za-z]:\\' -and $full.Substring(2) -notmatch ':') `
    'UNC, device and alternate-data-stream paths are not accepted.'
  $cursor = $full
  while ($cursor) {
    if ([IO.File]::Exists($cursor) -or [IO.Directory]::Exists($cursor)) {
      Assert-Condition (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -eq 0) `
        "Reparse-point path is not accepted: $cursor"
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
  return $full
}

function Get-Sha([byte[]]$Bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

function Open-BoundFile([string]$Path, [string]$Sha = '', [long]$Bytes = -1) {
  $path = Get-SafePath $Path
  $item = Get-Item -LiteralPath $path
  Assert-Condition ($item -is [IO.FileInfo]) "Missing regular input file: $path"
  $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $locks.Add($stream)
  Assert-Condition ($stream.Length -gt 0 -and $stream.Length -le 80MB) "Input size is invalid: $path"
  if ($Bytes -ge 0) { Assert-Condition ($stream.Length -eq $Bytes) "Input byte count mismatch: $path" }
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { $actual = ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $hasher.Dispose(); $stream.Position = 0 }
  if ($Sha) { Assert-Condition ($actual -ceq $Sha.ToLowerInvariant()) "Input SHA256 mismatch: $path" }
  return [pscustomobject]@{ path = $path; bytes = $stream.Length; sha256 = $actual; stream = $stream }
}

function Read-BoundBytes($Binding) {
  $Binding.stream.Position = 0
  $reader = [IO.BinaryReader]::new($Binding.stream, $utf8, $true)
  try { $bytes = $reader.ReadBytes([int]$Binding.bytes); return ,$bytes }
  finally { $reader.Dispose(); $Binding.stream.Position = 0 }
}

function Get-RequiredField($Object, [string]$Name) {
  Assert-Condition ($Object -is [pscustomobject] -and $null -ne $Object.PSObject.Properties[$Name]) `
    "Manifest is missing field: $Name"
  return $Object.PSObject.Properties[$Name].Value
}

function Get-Integer($Value, [string]$Field, [long]$Min, [long]$Max) {
  Assert-Condition ($null -ne $Value -and $Value -isnot [string] -and $Value -isnot [bool] -and
    $Value -is [ValueType]) "Expected a JSON number: $Field"
  $number = [double]$Value
  Assert-Condition (-not [double]::IsNaN($number) -and -not [double]::IsInfinity($number) -and
    [Math]::Floor($number) -eq $number -and $number -ge $Min -and $number -le $Max) `
    "Expected a bounded JSON integer: $Field"
  return [long]$number
}

function Read-ZipBytes($Entry, [long]$Maximum) {
  Assert-Condition ($Entry.Length -gt 0 -and $Entry.Length -le $Maximum) 'ZIP entry size is outside its bound.'
  $source = $Entry.Open()
  $destination = [IO.MemoryStream]::new()
  $timer = [Diagnostics.Stopwatch]::StartNew()
  try {
    $buffer = [byte[]]::new(8192)
    while (($read = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
      Assert-Condition ($destination.Length + $read -le $Maximum -and $timer.ElapsedMilliseconds -lt 25000) `
        'ZIP entry exceeded its decompression byte/time bound.'
      $destination.Write($buffer, 0, $read)
    }
    Assert-Condition ($destination.Length -eq $Entry.Length) 'ZIP entry has inconsistent decompressed length.'
    return ,$destination.ToArray()
  } finally { $source.Dispose(); $destination.Dispose() }
}

function Open-ReadOnlyZip([byte[]]$Bytes) {
  $memory = [IO.MemoryStream]::new($Bytes, $false)
  try { return [IO.Compression.ZipArchive]::new($memory, [IO.Compression.ZipArchiveMode]::Read, $false) }
  catch { $memory.Dispose(); throw }
}

function Inspect-Pack([byte[]]$Bytes) {
  $zip = Open-ReadOnlyZip $Bytes
  try {
    Assert-Condition ($zip.Entries.Count -ge 2 -and $zip.Entries.Count -le 64) 'Invalid single-pack ZIP entry count.'
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    [long]$total = 0
    foreach ($entry in $zip.Entries) {
      Assert-Condition ($entry.FullName -notmatch '(^[\\/]|\\|(^|/)\.\.(/|$)|:)' -and
        -not $entry.FullName.EndsWith('/') -and $names.Add($entry.FullName)) 'Unsafe or duplicate package ZIP entry.'
      $total += $entry.Length
      Assert-Condition ($entry.Length -ge 0 -and $total -le 50MB) 'Package decompressed size exceeds 50 MiB.'
    }
    $manifestEntry = $zip.GetEntry('manifest.json')
    Assert-Condition ($null -ne $manifestEntry) 'Original package has no root manifest.json.'
    $manifest = $utf8.GetString((Read-ZipBytes $manifestEntry 256KB)) | ConvertFrom-Json
    $schema = Get-Integer (Get-RequiredField $manifest 'schema_version') 'schema_version' 1 3
    Assert-Condition ($schema -eq 1 -or $schema -eq 3) 'Original SDK package must use schema 1 or 3.'
    $id = Get-RequiredField $manifest 'id'
    Assert-Condition ($id -is [string] -and $id.Length -le 96 -and
      $id -cmatch '\A[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)*\z') 'Unsafe package identity.'
    $version = Get-RequiredField $manifest 'version'
    $reviewId = Get-RequiredField $manifest 'review_id'
    $publisher = Get-RequiredField $manifest 'publisher'
    Assert-Condition ($version -is [string] -and $version -ceq '1.0.0') 'Original SDK embedded version must be 1.0.0.'
    Assert-Condition ($reviewId -is [string] -and $reviewId -cmatch '\A[a-f0-9]{32}\z') 'Invalid embedded SDK review identity.'
    Assert-Condition ($publisher -is [string] -and $publisher -ceq 'community') 'Original SDK embedded publisher must be community.'
    return [pscustomobject]@{
      id = $id; version = $version; reviewId = $reviewId; publisher = $publisher
      schema = $schema; bytes = $Bytes.Length; sha256 = Get-Sha $Bytes
    }
  } finally { $zip.Dispose() }
}

function Get-ValidatedSourceRecords($Declared, $Packs) {
  $declaredRecords = @(Get-RequiredField $Declared 'sourceRecords')
  Assert-Condition ($Declared.PSObject.Properties['sourceRecords'].Value -is [array] -and
    $declaredRecords.Count -eq $Packs.Count) 'sourceRecords must be an array with one record per actual SDK package.'
  $records = [Collections.Generic.List[object]]::new()
  $ids = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $reviewIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  for ($index = 0; $index -lt $declaredRecords.Count; $index++) {
    $record = $declaredRecords[$index]
    Assert-Condition ($record -is [pscustomobject]) 'Each sourceRecord must be a plain JSON object.'
    $fields = @($record.PSObject.Properties.Name)
    Assert-Condition ($fields.Count -eq $sourceRecordFields.Count -and
      @($fields | Where-Object { $_ -cnotin $sourceRecordFields }).Count -eq 0) 'Unknown or missing sourceRecord field.'
    $id = Get-RequiredField $record 'id'
    $version = Get-RequiredField $record 'version'
    $reviewId = Get-RequiredField $record 'reviewId'
    $schema = Get-Integer (Get-RequiredField $record 'schema') 'sourceRecord.schema' 1 3
    $sdkSha = Get-RequiredField $record 'sdkArchiveSha256'
    $sdkBytes = Get-Integer (Get-RequiredField $record 'sdkArchiveBytes') 'sourceRecord.sdkArchiveBytes' 1 83886080
    $producerVersionId = Get-RequiredField $record 'producerVersionId'
    $revision = Get-RequiredField $record 'sourceRevision'
    $sourceSha = Get-RequiredField $record 'sourceArchiveSha256'
    $sourceBytes = Get-Integer (Get-RequiredField $record 'sourceArchiveBytes') 'sourceRecord.sourceArchiveBytes' 1 83886080
    Assert-Condition ($id -is [string] -and $id.Length -le 96 -and
      $id -cmatch '\A[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)*\z' -and
      $version -is [string] -and $version -ceq '1.0.0' -and
      $reviewId -is [string] -and $reviewId -cmatch '\A[a-f0-9]{32}\z' -and
      $schema -in @(1, 3) -and $sdkSha -is [string] -and $sdkSha -cmatch '\A[a-f0-9]{64}\z' -and
      $producerVersionId -is [string] -and $producerVersionId -cmatch '\A[a-f0-9]{32}\z' -and
      $revision -is [string] -and $revision -cmatch '\A[a-f0-9]{64}\z' -and
      $sourceSha -is [string] -and $sourceSha -cmatch '\A[a-f0-9]{64}\z') 'Invalid SDK/source producer metadata field format.'
    $pack = $Packs[$index]
    Assert-Condition ($id -ceq $pack.id -and $version -ceq $pack.version -and
      $reviewId -ceq $pack.reviewId -and $schema -eq $pack.schema -and
      $sdkSha -ceq $pack.sha256 -and $sdkBytes -eq $pack.bytes -and $pack.publisher -ceq 'community') `
      'sourceRecord does not match the directly observed SDK manifest and original SDK digest/byte count.'
    Assert-Condition ($ids.Add($id) -and $reviewIds.Add($reviewId)) 'SDK sourceRecords must have distinct package IDs and review IDs.'
    $records.Add([ordered]@{
      id = $id; version = $version; reviewId = $reviewId; schema = $schema
      sdkArchiveSha256 = $sdkSha; sdkArchiveBytes = $sdkBytes; producerVersionId = $producerVersionId
      sourceRevision = $revision; sourceArchiveSha256 = $sourceSha; sourceArchiveBytes = $sourceBytes
    })
  }
  return ,$records.ToArray()
}

function Assert-SameSourceRecord($Actual, $Expected) {
  foreach ($field in $sourceRecordFields) {
    Assert-Condition ([string]$Actual[$field] -ceq [string]$Expected[$field]) `
      "Pair sourceRecord differs from the corresponding single record: $field"
  }
}

function Get-PeEvidence($Binding, [string]$Kind) {
  Assert-Condition ([IO.Path]::GetExtension($Binding.path) -ieq '.exe') 'Frozen artifact must be an EXE.'
  $stream = $Binding.stream
  $reader = [IO.BinaryReader]::new($stream, $utf8, $true)
  try {
    Assert-Condition ($stream.Length -ge 64 -and $reader.ReadUInt16() -eq 0x5a4d) 'Invalid DOS header.'
    $stream.Position = 60
    $offset = [long]$reader.ReadUInt32()
    Assert-Condition ($offset -ge 64 -and $offset -le $stream.Length - 26) 'Invalid PE header offset.'
    $stream.Position = $offset
    Assert-Condition ($reader.ReadUInt32() -eq 0x00004550) 'Invalid PE signature.'
    $machine = $reader.ReadUInt16()
    $sections = $reader.ReadUInt16()
    $stream.Position = $offset + 20
    $optionalBytes = $reader.ReadUInt16()
    Assert-Condition ($sections -gt 0 -and $optionalBytes -ge 2 -and
      $offset + 24 + $optionalBytes + 40 * $sections -le $stream.Length) 'Truncated PE header.'
    $stream.Position = $offset + 24
    $magic = $reader.ReadUInt16()
    $x64 = $machine -eq 0x8664 -and $magic -eq 0x20b
    $x86 = $machine -eq 0x014c -and $magic -eq 0x10b
    Assert-Condition (($Kind -eq 'client' -and $x64) -or ($Kind -eq 'installer' -and ($x64 -or $x86))) `
      'Frozen artifact architecture is not appropriate for its role.'
  } finally { $reader.Dispose(); $stream.Position = 0 }
  $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($Binding.path)
  $fileVersion = ([string]$version.FileVersion).Trim()
  $productVersion = ([string]$version.ProductVersion).Trim()
  $actualProductName = ([string]$version.ProductName).Trim()
  $fileNumeric = @($version.FileMajorPart, $version.FileMinorPart, $version.FileBuildPart, $version.FilePrivatePart) -join '.'
  $productNumeric = @($version.ProductMajorPart, $version.ProductMinorPart, $version.ProductBuildPart, $version.ProductPrivatePart) -join '.'
  Assert-Condition ($fileNumeric -eq '0.8.4.0' -and $productNumeric -eq '0.8.4.0' -and
    $fileVersion -match '^0\.8\.4(?:\.0)?$' -and $productVersion -match '^0\.8\.4(?:\.0)?$') `
    'Frozen file/product version must be 0.8.4, numeric 0.8.4.0.'
  $productName = if ($Kind -eq 'client') { 'NiuMa Merit' } else {
    [regex]::Unescape('\u725b\u9a6c\u7535\u5b50\u529f\u5fb7')
  }
  Assert-Condition ($actualProductName -ceq $productName) 'Frozen artifact product identity does not match.'
  $signature = Get-AuthenticodeSignature -LiteralPath $Binding.path
  Assert-Condition ($signature.Status.ToString() -in @('Valid', 'NotSigned')) `
    "Artifact signature/trust check failed: $($signature.Status)"
  return [ordered]@{
    path = $Binding.path; bytes = $Binding.bytes; sha256 = $Binding.sha256
    fileVersion = $fileVersion; productVersion = $productVersion
    fileNumericVersion = $fileNumeric; productNumericVersion = $productNumeric
    productName = $actualProductName; peMachine = ('0x{0:x4}' -f $machine)
    signatureStatus = $signature.Status.ToString()
    signatureTrustVerified = ($signature.Status.ToString() -eq 'Valid')
    unsignedArtifactPolicy = 'Native shell launch under existing runner policy; no bypass or unblocking'
  }
}

function Write-Receipt {
  if (-not $outputDirectoryOwned) { return }
  Get-SafePath $outputRoot | Out-Null
  $report.inputs = @($inputs.ToArray() | ForEach-Object { $_.evidence })
  $report.cleanup.errors = $cleanupErrors.ToArray()
  $script:receiptSequence++
  $receiptPath = Join-Path $outputRoot ('receipt-{0:D6}.json' -f $script:receiptSequence)
  $bytes = $utf8.GetBytes(($report | ConvertTo-Json -Depth 16) + [char]10)
  $destination = [IO.File]::Open($receiptPath, [IO.FileMode]::CreateNew,
    [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $destination.Write($bytes, 0, $bytes.Length) }
  finally { $destination.Dispose() }
  Write-Output ('WINDOWS_INSTALLED_GUI_CHECKPOINT=' + $receiptPath)
}

function Get-RunValue([string]$Hive) {
  $key = Get-Item -LiteralPath ($Hive + '\Software\Microsoft\Windows\CurrentVersion\Run') -ErrorAction SilentlyContinue
  if ($key -and $key.GetValueNames() -contains 'NiuMaMerit') { return [string]$key.GetValue('NiuMaMerit') }
  return $null
}

function Assert-NoForeignClient {
  foreach ($process in @(Get-Process -Name 'niuma-merit' -ErrorAction SilentlyContinue)) {
    $ours = @($ownedProcesses.ToArray() | Where-Object { $_.handle.Id -eq $process.Id -and -not $_.handle.HasExited })
    Assert-Condition ($ours.Count -eq 1) 'Another NiuMa Merit process exists; it will not be closed.'
  }
}

function Start-OwnedProcess([string]$Path, [string]$Arguments, [string]$Role) {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = Get-SafePath $Path
  $start.Arguments = $Arguments
  $start.WorkingDirectory = [IO.Path]::GetDirectoryName($start.FileName)
  # Shell execution retains normal Windows trust/attachment handling.
  $start.UseShellExecute = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  try { Assert-Condition ($process.Start()) "Could not start owned process: $Role" }
  catch { $process.Dispose(); throw }
  $evidence = [ordered]@{
    role = $Role; pid = $process.Id; path = $start.FileName; arguments = $Arguments
    startedAt = [DateTime]::UtcNow.ToString('o'); waitCompleted = $false
    exitCode = $null; forcedTermination = $false; parentPid = $null
  }
  $owned = [pscustomobject]@{ handle = $process; evidence = $evidence; rootPid = $process.Id }
  $ownedProcesses.Add($owned)
  $report.processes.Add($evidence)
  return $owned
}

function Observe-OwnedChildren {
  # Keep handles for observed installer descendants. Never use name-based kills.
  foreach ($parent in $ownedProcesses.ToArray()) {
    if ($parent.handle.HasExited) { continue }
    foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($parent.handle.Id)")) {
      if (@($ownedProcesses.ToArray() | Where-Object { $_.handle.Id -eq $child.ProcessId }).Count) { continue }
      try { $handle = [Diagnostics.Process]::GetProcessById([int]$child.ProcessId) }
      catch [ArgumentException] { continue }
      try {
        if ($handle.HasExited -or $handle.StartTime.ToUniversalTime() -lt $parent.handle.StartTime.ToUniversalTime()) {
          $handle.Dispose(); continue
        }
        $image = $handle.MainModule.FileName
      } catch { $handle.Dispose(); throw }
      $evidence = [ordered]@{
        role = $parent.evidence.role + '-child'; pid = $handle.Id; path = $image
        arguments = $null; startedAt = $handle.StartTime.ToUniversalTime().ToString('o')
        waitCompleted = $false; exitCode = $null; forcedTermination = $false
        parentPid = $parent.handle.Id
      }
      $ownedProcesses.Add([pscustomobject]@{ handle = $handle; evidence = $evidence; rootPid = $parent.rootPid })
      $report.processes.Add($evidence)
    }
  }
}

function Record-Exit($Owned) {
  if ($Owned.evidence.waitCompleted) { return }
  if ($Owned.handle.WaitForExit(0)) {
    $Owned.evidence.waitCompleted = $true
    $Owned.evidence.exitCode = $Owned.handle.ExitCode
    $Owned.evidence['exitedAt'] = [DateTime]::UtcNow.ToString('o')
  }
}

function Wait-OwnedProcess($Owned, [int]$TimeoutMs = 25000) {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $nextObserve = 0L
  while ($timer.ElapsedMilliseconds -lt $TimeoutMs) {
    if ($timer.ElapsedMilliseconds -ge $nextObserve) {
      Observe-OwnedChildren
      $nextObserve = $timer.ElapsedMilliseconds + 500
    }
    $members = @($ownedProcesses.ToArray() | Where-Object { $_.rootPid -eq $Owned.rootPid })
    foreach ($member in $members) { Record-Exit $member }
    if (@($members | Where-Object { -not $_.evidence.waitCompleted }).Count -eq 0) {
      foreach ($member in $members) {
        Assert-Condition ($member.evidence.exitCode -eq 0) `
          "Owned process exited unsuccessfully: $($member.evidence.role), code $($member.evidence.exitCode)"
      }
      return
    }
    Start-Sleep -Milliseconds 100
  }
  throw "Owned process exceeded its bounded wait: $($Owned.evidence.role)"
}

function Stop-OwnedProcesses {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $members = @($ownedProcesses.ToArray())
  [array]::Reverse($members)
  foreach ($owned in $members) {
    try {
      if (-not $owned.handle.HasExited) {
        foreach ($window in [NmgGuiObserver]::Windows($owned.handle.Id)) {
          [NmgGuiObserver]::PostMessage($window.Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        }
      }
    } catch { $cleanupErrors.Add("Owned close request failed: $($_.Exception.Message)") }
  }
  foreach ($owned in $members) {
    try {
      $remaining = [Math]::Max(0, 3000 - [int]$timer.ElapsedMilliseconds)
      if (-not $owned.handle.WaitForExit($remaining)) {
        $owned.evidence.forcedTermination = $true
        $owned.handle.Kill()
        $remaining = [Math]::Max(0, 6000 - [int]$timer.ElapsedMilliseconds)
        Assert-Condition ($owned.handle.WaitForExit($remaining)) 'Owned process did not exit after bounded termination.'
      }
      Record-Exit $owned
    } catch { $cleanupErrors.Add("Owned process cleanup failed: $($_.Exception.Message)") }
  }
}

function Capture-Observation($Case, $Main, $Dialog, [string]$Name) {
  [NmgGuiObserver]::CheckDesktop()
  Assert-Condition ([NmgGuiObserver]::Observable($Main.Handle)) 'Normal app window is not visibly observable.'
  if ($Dialog) {
    Assert-Condition ([NmgGuiObserver]::Observable($Dialog.Handle)) 'Owned dialog is hidden, occluded or not on the input desktop.'
  }
  $imagePath = Join-Path $outputRoot ($Case.name + '-' + $Name + '.png')
  [NmgGuiObserver]::Capture($imagePath)
  $observation = [ordered]@{
    observedAt = [DateTime]::UtcNow.ToString('o'); screenshot = $imagePath
    screenshotSha256 = (Get-FileHash -LiteralPath $imagePath -Algorithm SHA256).Hash.ToLowerInvariant()
    mainWindow = $Main; dialog = $Dialog
    source = 'Live Win32 windows/control text and CopyFromScreen; not rendered mock evidence'
  }
  $Case.observations.Add($observation)
  $report.actualGuiObserved = $true
  Write-Receipt
}

function Get-CatalogSnapshot {
  $items = [Collections.Generic.List[object]]::new()
  if ([IO.Directory]::Exists($catalogDir)) {
    foreach ($file in @(Get-ChildItem -LiteralPath $catalogDir -File)) {
      $safe = Get-SafePath $file.FullName
      $items.Add([ordered]@{ path = $safe; bytes = $file.Length
        sha256 = (Get-FileHash -LiteralPath $safe -Algorithm SHA256).Hash.ToLowerInvariant() })
    }
  }
  return ,$items.ToArray()
}

function Invoke-GuiCase($InputCase) {
  Assert-NoForeignClient
  $case = [ordered]@{
    name = $InputCase.name; result = 'FAIL'; input = $InputCase.evidence
    entry = 'Installed normal app, native file argument'
    actualGuiObserved = $false; normalGuiImportObserved = $false
    successDialogObserved = $false; dialogImportedCount = $null
    actualImportedCount = 0; countEvidence = $null; selectedPackId = $null
    catalogBefore = Get-CatalogSnapshot; catalogAfter = @()
    observations = [Collections.Generic.List[object]]::new(); failure = $null
  }
  $report.cases.Add($case)
  Write-Receipt
  try {
    # No existing instance is allowed: a launcher forwarding to somebody else's
    # window must never be confused with the installed app under test.
    $app = Start-OwnedProcess $clientPath ('"' + $InputCase.binding.path + '"') ('app-' + $InputCase.name)
    $script:clientStarted = $true
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $privacySeen = $false
    $success = $false
    $privacyTitle = [regex]::Unescape('\u9690\u79c1\u8bf4\u660e')
    $singleZh = [regex]::Unescape('\u5f62\u8c61\u5305\u5df2\u5b89\u5168\u5bfc\u5165\u5e76\u542f\u7528\u3002')
    $batchZh = [regex]::Unescape(' \u4e2a\u5f62\u8c61\u5df2\u5bfc\u5165\u3002\u53ef\u5728\u201c\u66f4\u6362\u5f62\u8c61\u201d\u4e2d\u5207\u6362\u3002')
    while ($timer.ElapsedMilliseconds -lt 25000) {
      Assert-Condition (-not $app.handle.HasExited) 'Installed normal app exited before a success dialog was observed.'
      $windows = @([NmgGuiObserver]::Windows($app.handle.Id))
      $main = @($windows | Where-Object { $_.ClassName -eq 'NiuMaMeritWindow' })
      $dialogs = @($windows | Where-Object { $_.ClassName -eq '#32770' })
      if ($main.Count -ne 1 -or $dialogs.Count -eq 0) { Start-Sleep -Milliseconds 100; continue }
      Assert-Condition ($dialogs.Count -eq 1) 'Multiple unexpected app dialogs are present.'
      $dialog = $dialogs[0]
      Assert-Condition ($dialog.Owner -eq $main[0].Handle) 'Dialog is not owned by the normal client window.'
      $isPrivacy = $dialog.Title -ceq 'Privacy' -or $dialog.Title -ceq $privacyTitle
      if ($isPrivacy) {
        Assert-Condition (-not $privacySeen) 'Unexpected repeated privacy dialog.'
        Capture-Observation $case $main[0] $dialog 'privacy'
        $privacySeen = $true
        [NmgGuiObserver]::ClickOk($dialog.Handle)
        Start-Sleep -Milliseconds 150
        continue
      }
      Capture-Observation $case $main[0] $dialog 'import-dialog'
      $expectedCount = $InputCase.evidence.expectedImportedCount
      $text = $dialog.Text.Trim()
      if ($expectedCount -eq 1) {
        Assert-Condition ($text -ceq 'The appearance pack was safely imported and enabled.' -or $text -ceq $singleZh) `
          "Actual app did not show its production single-pack success dialog: $text"
        $case.countEvidence = 'Exact singular production success dialog plus one matching original package in the actual catalog'
      } else {
        $match = [regex]::Match($text, '^([0-9]+) packs imported\. Switch between them in Change Appearance\.$')
        if (-not $match.Success) {
          $match = [regex]::Match($text, '^([0-9]+)' + [regex]::Escape($batchZh) + '$')
        }
        Assert-Condition ($match.Success -and [int]$match.Groups[1].Value -eq $expectedCount) `
          "Actual app batch success dialog did not report the expected count: $text"
        $case.dialogImportedCount = [int]$match.Groups[1].Value
        $case.countEvidence = 'Numeric count in the exact production batch success dialog plus matching original catalog bytes'
      }
      $case.successDialogObserved = $true
      $case.catalogAfter = Get-CatalogSnapshot
      foreach ($pack in $InputCase.packs) {
        $destination = Join-Path $catalogDir ($pack.id + '.nmgpack')
        $stored = @($case.catalogAfter | Where-Object { $_.path -ieq $destination })
        Assert-Condition ($stored.Count -eq 1 -and $stored[0].sha256 -ceq $pack.sha256 -and
          $stored[0].bytes -eq $pack.bytes) 'Actual catalog does not contain the original imported package bytes.'
        $case.actualImportedCount++
      }
      Assert-Condition ($case.actualImportedCount -eq $expectedCount) 'Actual imported catalog count does not match the manifest.'
      $case.selectedPackId = [NmgGuiObserver]::SelectedPack((Join-Path $dataRoot 'data.ini'))
      Assert-Condition (@($InputCase.packs | Where-Object { $_.id -ceq $case.selectedPackId }).Count -eq 1) `
        'Actual app storage does not show an imported pack enabled.'
      [NmgGuiObserver]::ClickOk($dialog.Handle)
      $success = $true
      break
    }
    Assert-Condition $success 'No observable production success dialog within the 25-second GUI stage.'
    # The app installs its ordinary input hooks after dismissing import success.
    # Observe a stable normal window rather than closing before startup can fail.
    $settle = [Diagnostics.Stopwatch]::StartNew()
    do {
      Assert-Condition (-not $app.handle.HasExited) 'Normal app exited immediately after import.'
      $windows = @([NmgGuiObserver]::Windows($app.handle.Id))
      $dialogs = @($windows | Where-Object { $_.ClassName -eq '#32770' })
      $main = @($windows | Where-Object { $_.ClassName -eq 'NiuMaMeritWindow' })
      if ($dialogs.Count -gt 0) {
        if ($main.Count -eq 1) { Capture-Observation $case $main[0] $dialogs[0] 'post-import-unexpected-dialog' }
        throw 'Unexpected normal-app dialog after import; startup/hook failure is not a pass.'
      }
      Start-Sleep -Milliseconds 100
    } while ($settle.ElapsedMilliseconds -lt 1000)
    Assert-Condition ($main.Count -eq 1) 'Normal app GUI disappeared after import.'
    Capture-Observation $case $main[0] $null 'normal-app'
    Assert-Condition ([NmgGuiObserver]::PostMessage($main[0].Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) `
      'Could not request normal closure of the owned app window.'
    Wait-OwnedProcess $app 10000
    Assert-Condition (-not $app.evidence.forcedTermination) 'Forced termination is not successful GUI acceptance.'
    $case.actualGuiObserved = $true
    $case.normalGuiImportObserved = $true
    $case.result = 'PASS'
    $report.normalGuiImportObserved = $true
    Write-Receipt
  } catch { $case.failure = $_.Exception.Message; Write-Receipt; throw }
}

function Cleanup-AppArtifacts {
  if (-not $clientStarted) { return }
  Assert-NoForeignClient
  $command = '"' + $clientPath + '" "%1"'
  foreach ($pair in @(
    @('.nmgpack', 'NiuMaMerit.AppearancePack'),
    @('.nmgpacks', 'NiuMaMerit.AppearanceBatch')
  )) {
    $extensionPath = 'HKCU:\Software\Classes\' + $pair[0]
    $classPath = 'HKCU:\Software\Classes\' + $pair[1]
    if (Test-Path -LiteralPath $classPath) {
      $registered = Get-Item -LiteralPath ($classPath + '\shell\open\command')
      Assert-Condition ([string]$registered.GetValue('') -ieq $command) 'Association ownership changed; preserving it.'
      if (Test-Path -LiteralPath $extensionPath) {
        $extension = Get-Item -LiteralPath $extensionPath
        Assert-Condition ([string]$extension.GetValue('') -ceq $pair[1]) 'Extension ownership changed; preserving it.'
        Remove-Item -LiteralPath $extensionPath -Recurse
      }
      Remove-Item -LiteralPath $classPath -Recurse
    } else {
      Assert-Condition (-not (Test-Path -LiteralPath $extensionPath)) 'Partial association without verifiable ownership is preserved.'
    }
  }
  $runValue = Get-RunValue 'HKCU:'
  if ($null -ne $runValue) {
    Assert-Condition ($runValue -ieq ('"' + $clientPath + '" --autostart')) 'Startup value ownership changed; preserving it.'
    Remove-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'NiuMaMerit'
  }
  if ([IO.Directory]::Exists($dataRoot)) {
    Get-SafePath $dataRoot | Out-Null
    if ([IO.Directory]::Exists($catalogDir)) {
      foreach ($file in @(Get-ChildItem -LiteralPath $catalogDir -Force)) {
        $safe = Get-SafePath $file.FullName
        Assert-Condition ($file -is [IO.FileInfo]) 'Unexpected catalog subdirectory is preserved.'
        $packName = $file.Name -replace '\.incoming$', ''
        $originals = @($inputs.ToArray() | ForEach-Object { $_.packs } |
          Where-Object { ($_.id + '.nmgpack') -ceq $packName })
        $hash = (Get-FileHash -LiteralPath $safe -Algorithm SHA256).Hash.ToLowerInvariant()
        Assert-Condition (@($originals | Where-Object { $_.sha256 -ceq $hash }).Count -gt 0) `
          'Unknown or changed catalog file is preserved instead of cleared.'
        Remove-Item -LiteralPath $safe
      }
      [IO.Directory]::Delete($catalogDir, $false)
    }
    $ini = Join-Path $dataRoot 'data.ini'
    if ([IO.File]::Exists($ini)) { Get-SafePath $ini | Out-Null; Remove-Item -LiteralPath $ini }
    # Non-recursive deletion deliberately fails if any unowned content exists.
    [IO.Directory]::Delete($dataRoot, $false)
  }
}

try {
  $runnerTemp = (Get-SafePath $env:RUNNER_TEMP).TrimEnd('\')
  $outputRoot = Get-SafePath $OutputDirectory
  Assert-Condition ($outputRoot.StartsWith($runnerTemp + '\', [StringComparison]::OrdinalIgnoreCase)) `
    'OutputDirectory must be below RUNNER_TEMP.'
  Assert-Condition (-not (Test-Path -LiteralPath $outputRoot)) 'OutputDirectory must be fresh; no prior evidence may be overwritten.'
  Assert-Condition ([IO.Directory]::Exists([IO.Path]::GetDirectoryName($outputRoot))) 'OutputDirectory parent must already exist.'
  # Directory.CreateDirectory silently accepts an existing directory. Use the
  # native create operation instead so a concurrent creator cannot confer
  # ownership on this run. False (including ERROR_ALREADY_EXISTS) never owns it.
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NmgExclusiveOutputDirectory {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CreateDirectory(string path, IntPtr securityAttributes);
}
'@
  if (-not [NmgExclusiveOutputDirectory]::CreateDirectory($outputRoot, [IntPtr]::Zero)) {
    throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error(),
      'OutputDirectory exclusive creation failed; this run does not own it.')
  }
  $outputDirectoryOwned = $true
  $report['outputDirectory'] = $outputRoot
  Assert-Condition ($ExpectedInstallerSha256 -match '^[a-fA-F0-9]{64}$') 'ExpectedInstallerSha256 must be SHA256 hex.'
  Assert-Condition ($ExpectedClientSha256 -match '^[a-fA-F0-9]{64}$' -and
    $ExpectedClientSha256.ToLowerInvariant() -ceq $frozenClientSha) 'ExpectedClientSha256 must match the frozen 0.8.4 client digest.'

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.Drawing
  $manifestBinding = Open-BoundFile $SdkManifestPath
  Assert-Condition ($manifestBinding.bytes -le 1MB) 'SDK input manifest exceeds 1 MiB.'
  $manifest = $utf8.GetString((Read-BoundBytes $manifestBinding)) | ConvertFrom-Json
  Assert-Condition ((Get-RequiredField $manifest 'schema') -ceq 'gongde-original-sdk-inputs.v2') 'Unsupported SDK binding manifest; v2 sourceRecords are required.'
  $declaredInputs = @(Get-RequiredField $manifest 'cases')
  Assert-Condition ($declaredInputs.Count -eq 3) 'Exactly three original SDK inputs are required before installation.'
  $report.sdkManifest = [ordered]@{ path = $manifestBinding.path; bytes = $manifestBinding.bytes
    sha256 = $manifestBinding.sha256; schema = 'gongde-original-sdk-inputs.v2'
    sourceRecordsAlignedWithObservedSdk = $false
    pairSourceRecordsMatchSingles = $false
    provenanceScope = 'Actual SDK bytes and embedded fields observed; external producer metadata aligned, not independently authenticated; original submission archives not read' }
  $manifestDir = [IO.Path]::GetDirectoryName($manifestBinding.path)
  $inputNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($declared in $declaredInputs) {
    Assert-Condition ($declared -is [pscustomobject]) 'Each SDK case must be a plain JSON object.'
    $caseFields = @('name', 'path', 'bytes', 'sha256', 'schema', 'expectedImportedCount', 'sourceRecords')
    $actualCaseFields = @($declared.PSObject.Properties.Name)
    Assert-Condition ($actualCaseFields.Count -eq $caseFields.Count -and
      @($actualCaseFields | Where-Object { $_ -cnotin $caseFields }).Count -eq 0) 'Unknown or missing v2 case field; legacy scalar provenance is not accepted.'
    $caseName = Get-RequiredField $declared 'name'
    Assert-Condition ($caseName -is [string] -and $caseName -cin @('amber', 'green', 'pair')) `
      'SDK case name must be amber, green or pair.'
    $expectedInput = $frozenSdk[$caseName]
    $pathValue = Get-RequiredField $declared 'path'
    $shaValue = Get-RequiredField $declared 'sha256'
    Assert-Condition ($pathValue -is [string] -and $shaValue -is [string] -and
      $shaValue -cmatch '\A[a-f0-9]{64}\z') 'Invalid original SDK path/digest fields.'
    $byteCount = Get-Integer (Get-RequiredField $declared 'bytes') 'bytes' 1 83886080
    $count = Get-Integer (Get-RequiredField $declared 'expectedImportedCount') 'expectedImportedCount' 1 2
    Assert-Condition ($byteCount -eq $expectedInput.sizeBytes -and $shaValue -ceq $expectedInput.sha -and
      $count -eq $expectedInput.expectedImportedCount) 'Declared input size/SHA/count differs from its frozen SDK identity.'
    $schema = Get-RequiredField $declared 'schema'
    $path = Get-SafePath $pathValue $manifestDir
    $bound = Open-BoundFile $path $shaValue $byteCount
    # Check the frozen outer artifact here, then align each sourceRecord with
    # its actual single/embedded SDK bytes and manifest below. The pair outer
    # ZIP is not a third producer source and has no fabricated sourceRecord.
    Assert-Condition ($bound.bytes -eq $expectedInput.sizeBytes -and $bound.sha256 -ceq $expectedInput.sha) `
      'Actual SDK input bytes/SHA do not equal frozen expectations.'
    $bytes = Read-BoundBytes $bound
    $packs = @()
    if ([IO.Path]::GetExtension($path) -ieq '.nmgpack') {
      $schemaValue = Get-Integer $schema 'schema' 1 3
      Assert-Condition ($caseName -cne 'pair' -and $count -eq 1 -and $schemaValue -eq $expectedInput.schema) `
        'Amber/green must bind their frozen single-pack schema and count 1.'
      $pack = Inspect-Pack $bytes
      Assert-Condition ($pack.schema -eq $schemaValue) 'Embedded single-pack schema does not match the manifest.'
      $packs = @($pack)
    } else {
      Assert-Condition ($caseName -ceq 'pair' -and [IO.Path]::GetExtension($path) -ieq '.nmgpacks' -and $count -eq 2) `
        'Pair input must be its frozen .nmgpacks with count 2.'
      $schemaValues = @($schema)
      Assert-Condition ($schemaValues.Count -eq 2) 'Batch schema must be the JSON array [1,3].'
      $first = Get-Integer $schemaValues[0] 'schema[0]' 1 3
      $second = Get-Integer $schemaValues[1] 'schema[1]' 1 3
      Assert-Condition ($first -eq 1 -and $second -eq 3) 'Batch schema must be [1,3].'
      $zip = Open-ReadOnlyZip $bytes
      try {
        Assert-Condition ($zip.Entries.Count -eq 2) 'Original SDK batch must contain exactly two existing packages.'
        foreach ($entryName in @('community-01.nmgpack', 'community-02.nmgpack')) {
          $entry = $zip.GetEntry($entryName)
          Assert-Condition ($null -ne $entry) 'Frozen pair must contain only community-01.nmgpack and community-02.nmgpack.'
          $packs += Inspect-Pack (Read-ZipBytes $entry 50MB)
        }
      } finally { $zip.Dispose() }
      Assert-Condition ((@($packs.schema | Sort-Object) -join ',') -eq '1,3' -and
        $packs[0].id -cne $packs[1].id) 'Actual batch schemas/identities do not match the two-pack binding.'
    }
    $records = Get-ValidatedSourceRecords $declared $packs
    Assert-Condition ($inputNames.Add($caseName)) 'Duplicate SDK case; amber, green and pair are all required.'
    $evidence = [ordered]@{
      name = $caseName
      path = $bound.path; bytes = $bound.bytes; sha256 = $bound.sha256; schema = $schema
      expectedImportedCount = $count; sourceRecords = $records
      directSdkObservation = [ordered]@{
        embeddedFields = @('id', 'version', 'review_id', 'publisher', 'schema_version')
        sdkArchiveBytesAndSha256Measured = $true
        sourceRevisionEmbedded = $false; sourceArchiveMetadataEmbedded = $false
      }
      externalProducerMetadataAlignment = [ordered]@{
        source = 'Caller-provided records of previously observed external SDK producer metadata'
        sdkIdentityManifestAndDigestFieldsAligned = $true
        externalOnlyFields = @('producerVersionId', 'sourceRevision', 'sourceArchiveSha256', 'sourceArchiveBytes')
        externalFieldFormatsChecked = $true
        independentlyAuthenticated = $false; producerOriginalSubmissionArchivesRead = $false
      }
      frozenSdkIdentityVerified = $true
      actualEmbeddedPacks = $packs; originalInputBytesVerified = $true
    }
    $inputs.Add([pscustomobject]@{ name = $caseName; binding = $bound; evidence = $evidence; packs = $packs })
  }
  Assert-Condition ($inputNames.SetEquals([string[]]@('amber', 'green', 'pair'))) 'Missing frozen original SDK acceptance input.'
  $amberInput = @($inputs.ToArray() | Where-Object { $_.name -ceq 'amber' })[0]
  $greenInput = @($inputs.ToArray() | Where-Object { $_.name -ceq 'green' })[0]
  $pairInput = @($inputs.ToArray() | Where-Object { $_.name -ceq 'pair' })[0]
  Assert-SameSourceRecord $pairInput.evidence.sourceRecords[0] $amberInput.evidence.sourceRecords[0]
  Assert-SameSourceRecord $pairInput.evidence.sourceRecords[1] $greenInput.evidence.sourceRecords[0]
  Assert-Condition ($pairInput.packs[0].sha256 -ceq $amberInput.binding.sha256 -and
    $pairInput.packs[0].bytes -eq $amberInput.binding.bytes -and
    $pairInput.packs[1].sha256 -ceq $greenInput.binding.sha256 -and
    $pairInput.packs[1].bytes -eq $greenInput.binding.bytes) `
    'Pair embedded original SDK bytes/digests differ from the bound amber/green singles.'
  $report.sdkManifest.sourceRecordsAlignedWithObservedSdk = $true
  $report.sdkManifest.pairSourceRecordsMatchSingles = $true
  $installerBinding = Open-BoundFile $InstallerPath $ExpectedInstallerSha256
  $report.installer = Get-PeEvidence $installerBinding 'installer'

  # This helper observes actual native windows and storage. It has no importer,
  # fake app, fixture generator, replacement renderer or production test hook.
  # In pwsh, an explicit ReferencedAssemblies list replaces the default .NET
  # reference set. System.Drawing alone therefore omits System.Collections
  # (List<T>) and dependencies of the other existing observer types. Use this
  # runtime's bundled reference assemblies, not mismatched implementation BCL
  # assemblies such as System.Private.CoreLib alongside reference System.Runtime.
  $guiReferencePaths = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
  if ($PSVersionTable.PSEdition -eq 'Core') {
    $referenceDirectory = Join-Path $PSHOME 'ref'
    Assert-Condition ([IO.Directory]::Exists($referenceDirectory)) 'The installed pwsh .NET reference directory is missing.'
    foreach ($reference in @(Get-ChildItem -LiteralPath $referenceDirectory -Filter '*.dll' -File)) {
      $guiReferencePaths[$reference.BaseName] = $reference.FullName
    }
    Assert-Condition ($guiReferencePaths.ContainsKey('System.Collections') -and
      $guiReferencePaths.ContainsKey('System.Runtime') -and
      $guiReferencePaths.ContainsKey('System.Drawing.Primitives')) `
      'The installed pwsh reference set lacks required collection/runtime/drawing types.'
  } else {
    # Preserve Windows PowerShell compatibility using its loaded framework types.
    foreach ($type in @([object], [Collections.Generic.List[object]],
      [ComponentModel.Win32Exception], [Diagnostics.Process], [Drawing.Size],
      [Runtime.InteropServices.Marshal], [Text.StringBuilder])) {
      $assembly = $type.Assembly
      $guiReferencePaths[$assembly.GetName().Name] = $assembly.Location
    }
  }
  # Bitmap/ImageFormat live in System.Drawing.Common on pwsh Windows, outside
  # the standard .NET reference pack. Reuse the already available implementation.
  $drawingAssembly = [Drawing.Bitmap].Assembly
  Assert-Condition (-not [string]::IsNullOrWhiteSpace($drawingAssembly.Location)) `
    'The installed drawing implementation has no usable assembly reference.'
  $guiReferencePaths[$drawingAssembly.GetName().Name] = $drawingAssembly.Location
  Add-Type -ReferencedAssemblies ([string[]]@($guiReferencePaths.Values)) -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
public sealed class NmgWindow {
  public IntPtr Handle { get; set; }
  public IntPtr Owner { get; set; }
  public string ClassName { get; set; }
  public string Title { get; set; }
  public string Text { get; set; }
  public int Left { get; set; }
  public int Top { get; set; }
  public int Right { get; set; }
  public int Bottom { get; set; }
}
public static class NmgGuiObserver {
  private delegate bool EnumProc(IntPtr window, IntPtr parameter);
  [StructLayout(LayoutKind.Sequential)] private struct Rect { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] private struct Point { public int X,Y; }
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr window, EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int size);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wparam, StringBuilder text, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr dialog, int id);
  [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint bytes, out uint needed);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] private static extern uint GetPrivateProfileString(string section, string key, string fallback, StringBuilder value, uint size, string path);
  private static string Class(IntPtr window) {
    var text=new StringBuilder(256); GetClassName(window,text,text.Capacity); return text.ToString();
  }
  private static string ControlText(IntPtr window) {
    var text=new StringBuilder(8192); IntPtr result;
    if (SendMessageTimeout(window,0x000D,new IntPtr(text.Capacity),text,2,200,out result)==IntPtr.Zero)
      throw new InvalidOperationException("Native control text observation timed out.");
    return text.ToString();
  }
  public static NmgWindow[] Windows(int processId) {
    var windows=new List<NmgWindow>();
    EnumWindows(delegate(IntPtr window,IntPtr unused) {
      uint pid; GetWindowThreadProcessId(window,out pid);
      if(pid!=(uint)processId || !IsWindowVisible(window)) return true;
      Rect rect; GetWindowRect(window,out rect);
      var title=new StringBuilder(1024); GetWindowText(window,title,title.Capacity);
      var parts=new List<string>(); string error=null;
      if(Class(window)=="#32770") EnumChildWindows(window,delegate(IntPtr child,IntPtr ignored) {
        if(Class(child)=="Static") {
          try { var text=ControlText(child); if(text.Length>0) parts.Add(text); }
          catch(Exception ex) { error=ex.Message; return false; }
        }
        return parts.Count<32;
      },IntPtr.Zero);
      if(error!=null) throw new InvalidOperationException(error);
      windows.Add(new NmgWindow {Handle=window,Owner=GetWindow(window,4),ClassName=Class(window),
        Title=title.ToString(),Text=String.Join("\n",parts.ToArray()),Left=rect.L,Top=rect.T,Right=rect.R,Bottom=rect.B});
      return true;
    },IntPtr.Zero);
    return windows.ToArray();
  }
  private static string DesktopName(IntPtr desktop) {
    var name=new StringBuilder(256); uint needed;
    if(!GetUserObjectInformation(desktop,2,name,512,out needed)) throw new Win32Exception();
    return name.ToString();
  }
  public static void CheckDesktop() {
    if(!Environment.UserInteractive || System.Diagnostics.Process.GetCurrentProcess().SessionId==0)
      throw new InvalidOperationException("Runner has no interactive non-service desktop; GUI acceptance is unavailable.");
    var input=OpenInputDesktop(0,false,1);
    if(input==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(),"Cannot observe input desktop.");
    try {
      var current=DesktopName(GetThreadDesktop(GetCurrentThreadId()));
      if(current!="Default" || DesktopName(input)!=current)
        throw new InvalidOperationException("Input desktop is locked, secure, or different from this process desktop.");
    } finally { CloseDesktop(input); }
  }
  public static bool Observable(IntPtr window) {
    Rect rect;
    if(!IsWindowVisible(window)||IsIconic(window)||!GetWindowRect(window,out rect)||rect.R<=rect.L||rect.B<=rect.T) return false;
    for(int y=1;y<=3;y++) for(int x=1;x<=3;x++) {
      var point=new Point {X=rect.L+(rect.R-rect.L)*x/4,Y=rect.T+(rect.B-rect.T)*y/4};
      if(GetAncestor(WindowFromPoint(point),2)==window) return true;
    }
    return false;
  }
  public static void ClickOk(IntPtr dialog) {
    var button=GetDlgItem(dialog,1);
    if(button==IntPtr.Zero || !IsWindowVisible(button) || !PostMessage(button,0x00F5,IntPtr.Zero,IntPtr.Zero))
      throw new InvalidOperationException("Actual owned dialog has no observable OK button.");
  }
  public static string SelectedPack(string path) {
    var value=new StringBuilder(128); GetPrivateProfileString("state","selected_pack_id","",value,128,path); return value.ToString();
  }
  public static void Capture(string path) {
    CheckDesktop();
    int left=GetSystemMetrics(76),top=GetSystemMetrics(77),width=GetSystemMetrics(78),height=GetSystemMetrics(79);
    if(width<=0 || height<=0 || (long)width*height>64000000) throw new InvalidOperationException("Desktop screenshot dimensions are unavailable or excessive.");
    using(var bitmap=new Bitmap(width,height,PixelFormat.Format32bppArgb)) {
      using(var graphics=Graphics.FromImage(bitmap)) graphics.CopyFromScreen(left,top,0,0,new Size(width,height),CopyPixelOperation.SourceCopy);
      bool varied=false; int initial=bitmap.GetPixel(0,0).ToArgb();
      for(int y=0;y<height&&!varied;y+=Math.Max(1,height/64)) for(int x=0;x<width;x+=Math.Max(1,width/64))
        if(bitmap.GetPixel(x,y).ToArgb()!=initial) { varied=true; break; }
      bitmap.Save(path,ImageFormat.Png);
      if(!varied) throw new InvalidOperationException("Actual desktop capture is blank/unobservable; retained screenshot is not passing evidence.");
    }
  }
}
'@
  [NmgGuiObserver]::CheckDesktop()
  $report.desktop = [ordered]@{ interactive = $true; inputDesktop = 'Default'
    sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId }
  [NmgGuiObserver]::Capture((Join-Path $outputRoot 'desktop-preflight.png'))
  $dataRoot = Get-SafePath (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'NiuMaMerit')
  $catalogDir = Join-Path $dataRoot 'Appearances'
  $installDir = Join-Path $outputRoot 'installed'
  $clientPath = Join-Path $installDir 'niuma-merit.exe'
  Assert-Condition (-not (Test-Path -LiteralPath $dataRoot)) 'Existing NiuMaMerit data/catalog must not be cleared or used.'
  Assert-NoForeignClient
  $mutex = $null
  $mutexExists = $false
  try { $mutex = [Threading.Mutex]::OpenExisting('Local\NiuMaMeritCounter'); $mutexExists = $true }
  catch [Threading.WaitHandleCannotBeOpenedException] { }
  finally { if ($mutex) { $mutex.Dispose() } }
  Assert-Condition (-not $mutexExists) 'Existing app mutex makes isolated normal-app acceptance unsafe.'
  $uninstallRelative = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{D1B9D81E-13A1-45E2-9B8F-33C9C7A06F27}_is1'
  foreach ($hive in @('HKCU:', 'HKLM:')) {
    Assert-Condition ($null -eq (Get-RunValue $hive)) 'Existing startup value must not be changed.'
    foreach ($key in @('.nmgpack', '.nmgpacks', 'NiuMaMerit.AppearancePack', 'NiuMaMerit.AppearanceBatch')) {
      Assert-Condition (-not (Test-Path -LiteralPath ($hive + '\Software\Classes\' + $key))) 'Existing file association must not be changed.'
    }
    foreach ($key in @($uninstallRelative, $uninstallRelative.Replace('Software\', 'Software\WOW6432Node\'))) {
      Assert-Condition (-not (Test-Path -LiteralPath ($hive + '\' + $key))) 'Existing Inno product registration must not be changed.'
    }
  }
  foreach ($base in @([Environment]::GetFolderPath('LocalApplicationData'), $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($base) {
      $directory = if ($base -eq [Environment]::GetFolderPath('LocalApplicationData')) { Join-Path $base 'Programs\NiumaMerit' }
        else { Join-Path $base 'NiumaMerit' }
      Assert-Condition (-not (Test-Path -LiteralPath $directory)) 'Existing normal installation directory must not be touched.'
    }
  }
  $isolationEstablished = $true
  $report['isolation'] = [ordered]@{ catalogInitiallyAbsent = $true; productRegistrationInitiallyAbsent = $true
    associationsInitiallyAbsent = $true; startupValueInitiallyAbsent = $true; ownInstallDirectory = $installDir; ownDataDirectory = $dataRoot }
  Write-Receipt

  $phase = 'silent-install'
  $installLog = Join-Path $outputRoot 'installer.log'
  $arguments = '/SP- /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /RESTARTEXITCODE=3010 /CURRENTUSER /NOICONS /TASKS="" /NOCLOSEAPPLICATIONS /NORESTARTAPPLICATIONS ' +
    '/DIR="' + $installDir + '" /GROUP="NmgAcceptance-' + $runId + '" /LOG="' + $installLog + '"'
  $report.installer['logPath'] = $installLog
  $installAttempted = $true
  $installer = Start-OwnedProcess $installerBinding.path $arguments 'installer'
  Wait-OwnedProcess $installer
  Assert-Condition ([IO.File]::Exists($installLog)) 'Real Inno installation log is missing.'
  $installedBinding = Open-BoundFile $clientPath $frozenClientSha
  $report.installedClient = Get-PeEvidence $installedBinding 'client'
  $uninstallerPath = Join-Path $installDir 'unins000.exe'
  $uninstallerBinding = Open-BoundFile $uninstallerPath
  Write-Receipt

  $phase = 'normal-gui-import'
  foreach ($name in @('amber', 'green', 'pair')) {
    $inputCase = @($inputs.ToArray() | Where-Object { $_.name -ceq $name })[0]
    Invoke-GuiCase $inputCase
  }
} catch {
  $failure = $_.Exception.Message
  $report.failure = [ordered]@{ phase = $phase; message = $failure; observedAt = [DateTime]::UtcNow.ToString('o') }
} finally {
  $report.cleanup.attempted = $isolationEstablished -and $installAttempted
  if ($ownedProcesses.Count -gt 0) { Stop-OwnedProcesses }
  foreach ($stream in $locks.ToArray()) { $stream.Dispose() }
  $locks.Clear()
  if ($isolationEstablished -and $installAttempted) {
    try {
      Assert-Condition (@($ownedProcesses.ToArray() | Where-Object { -not $_.evidence.waitCompleted }).Count -eq 0) `
        'Owned process exit is not confirmed; preserving install and catalog.'
      Assert-NoForeignClient
      $runValue = Get-RunValue 'HKCU:'
      Assert-Condition ($null -eq $runValue -or $runValue -ieq ('"' + $clientPath + '" --autostart')) `
        'Startup ownership changed; uninstall would affect an unowned value.'
      if ([IO.Directory]::Exists($installDir)) {
        $uninstallerPath = Join-Path $installDir 'unins000.exe'
        if ([IO.File]::Exists($uninstallerPath)) {
          $registration = Get-ItemProperty -LiteralPath ('HKCU:\' + $uninstallRelative)
          Assert-Condition ((Get-SafePath $registration.InstallLocation).TrimEnd('\') -ieq $installDir -and
            $registration.DisplayVersion -eq '0.8.4') 'Uninstaller registration does not bind this isolated installation.'
          $boundUninstaller = Open-BoundFile $uninstallerPath
          if ($uninstallerBinding) {
            Assert-Condition ($boundUninstaller.sha256 -ceq $uninstallerBinding.sha256) 'Owned uninstaller bytes changed.'
          }
          $uninstallLog = Join-Path $outputRoot 'uninstaller.log'
          $report.cleanup['uninstallerLogPath'] = $uninstallLog
          $report.cleanup['uninstallerSha256'] = $boundUninstaller.sha256
          # Release the image handle before Inno removes its own executable.
          $boundUninstaller.stream.Dispose()
          $uninstaller = Start-OwnedProcess $uninstallerPath `
            ('/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG="' + $uninstallLog + '"') 'uninstaller'
          Wait-OwnedProcess $uninstaller
          Assert-Condition ([IO.File]::Exists($uninstallLog)) 'Real Inno uninstallation log is missing.'
        } else {
          Assert-Condition (-not [IO.File]::Exists($clientPath)) 'Own installation has no uninstaller; preserving it.'
        }
        if ([IO.Directory]::Exists($installDir)) { [IO.Directory]::Delete((Get-SafePath $installDir), $false) }
      }
      Cleanup-AppArtifacts
      $report.cleanup.complete = $true
    } catch { $cleanupErrors.Add($_.Exception.Message) }
    if ($ownedProcesses.Count -gt 0) { Stop-OwnedProcesses }
  } else { $report.cleanup.complete = $true }
  foreach ($stream in $locks.ToArray()) { $stream.Dispose() }
  foreach ($owned in $ownedProcesses.ToArray()) {
    try { Record-Exit $owned } catch { $cleanupErrors.Add($_.Exception.Message) }
    $owned.handle.Dispose()
  }
  if (-not $failure -and $cleanupErrors.Count -eq 0 -and $report.cleanup.complete -and
      $report.cases.Count -eq 3 -and @($report.cases.ToArray() | Where-Object { $_.result -ne 'PASS' }).Count -eq 0) {
    $report.guiAcceptancePassed = $true
    $report.result = 'PASS'
  }
  $report['finishedAt'] = [DateTime]::UtcNow.ToString('o')
  Write-Receipt
  if ($outputDirectoryOwned) {
    try {
      Get-SafePath $outputRoot | Out-Null
      $finalReceiptPath = Join-Path $outputRoot 'receipt.json'
      $bytes = $utf8.GetBytes(($report | ConvertTo-Json -Depth 16) + [char]10)
      $destination = [IO.File]::Open($finalReceiptPath, [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write, [IO.FileShare]::None)
      try { $destination.Write($bytes, 0, $bytes.Length) }
      finally { $destination.Dispose() }
    } catch {
      $report.result = 'FAIL'
      $report.guiAcceptancePassed = $false
      if (-not $failure) { $failure = $_.Exception.Message }
      [Console]::Error.WriteLine('Final receipt was not created; no existing receipt was overwritten: ' + $_.Exception.Message)
    }
  }
}

if ($outputDirectoryOwned -and $finalReceiptPath -and [IO.File]::Exists($finalReceiptPath) -and -not $failure) {
  Write-Output ('WINDOWS_INSTALLED_GUI_RECEIPT=' + $finalReceiptPath)
}
if ($report.result -ne 'PASS') {
  $reason = if ($failure) { $failure } else { $cleanupErrors -join '; ' }
  [Console]::Error.WriteLine('Frozen installed normal-GUI acceptance failed: ' + $reason)
  throw ('Frozen installed normal-GUI acceptance failed: ' + $reason)
}
Write-Output 'WINDOWS_INSTALLED_ORIGINAL_SDK_GUI=PASS counts=1,1,2 scope=isolated-runner-only'
