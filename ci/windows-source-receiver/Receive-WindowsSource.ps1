#Requires -Version 7.4
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$OwnerBindingPath,
  [Parameter(Mandatory=$true)][string]$ExpectedOwnerBindingSha256,
  [Parameter(Mandatory=$true)][string]$ExpectedSourceIdentity,
  [Parameter(Mandatory=$true)][string]$ExpectedOwnerApprovalId,
  [Parameter(Mandatory=$true)][string]$DestinationRoot
)
. (Join-Path $PSScriptRoot 'Receiver.Common.ps1')
Assert-RealWindowsRunner
Initialize-ReceiverTypes
$utf8=[Text.UTF8Encoding]::new($false,$true)
$clock=[Diagnostics.Stopwatch]::StartNew()
$prefix='GONGDE_WINDOWS_SOURCE_084_20261006_'
$stage=$null; $destination=$null
$receipt=[ordered]@{
  schema='gongde-controlled-windows-source-receiver.v1'; result='FAIL'
  classification='SOURCE_ONLY_PRIVATE_INPUT_NOT_NATIVE_BUILD_OR_GUI_PASS'
  transport='independent-temporary-github-actions-source-secrets.v1'
  expectedSourceZipBytes=760923
  expectedSourceZipSha256='0029f5e9fdd8b88adeff94a45c009afc70c061ee9dd83f4107e29148a07632fa'
  expectedSourceManifestSha256='c02e32da628429414382efdf4b60c3b79bfdd518e257558db9d026231d80000a'
  ownerBindingSha256=$null; sourceIdentitySha256=$null; ownerApprovalIdSha256=$null
  providerPrivateAccessControlIndependentlyVerified=$false
  sourceRoot=$null; stageRoot=$null; receivedZipBytes=0
  sourceArchiveAndAllFilesVerified=$false; regularEntriesVerified=0
  networkRequests=0; sdkChannelUsedForSource=$false; errorCode=$null
  nativeWindowsCompiled=$false; nativeGuiPassed=$false
  historicalRun37288741395='FAIL 0xC0000005; root cause unproven, not superseded'
}
try {
  $DestinationRoot=Get-RunnerLocalPath $DestinationRoot -Fresh
  if ($env:GITHUB_REPOSITORY -cne 'Mr-shanqiu/niuma-ELEC-gongde' -or
      $ExpectedOwnerBindingSha256 -cnotmatch '\A[a-f0-9]{64}\z' -or
      $ExpectedSourceIdentity -cnotmatch '\A[A-Za-z0-9._:-]{1,128}\z' -or
      $ExpectedOwnerApprovalId -cnotmatch '\A[A-Za-z0-9._:-]{1,128}\z') {
    throw [GongdeSourceReceiver.ReceiverFault]::new('OWNER_BINDING_REQUIRED')
  }
  $raw=Read-RegularBytes $OwnerBindingPath 16384
  if ((Get-BytesSha $raw) -cne $ExpectedOwnerBindingSha256) {
    throw [GongdeSourceReceiver.ReceiverFault]::new('OWNER_BINDING_SHA')
  }
  $binding=$utf8.GetString($raw) | ConvertFrom-Json
  $fields=@('schema','inputClass','sourceIdentity','ownerApprovalId',
    'privateAccessControlAttestationId','transport','repository','chunkPrefix',
    'chunkCount','chunkCharacters','base64Characters','sourceZipSha256',
    'sourceZipBytes','sourceManifestSha256','expiresAtUtc')
  if ($binding -isnot [pscustomobject] -or @($binding.PSObject.Properties).Count -ne $fields.Count -or
      @($binding.PSObject.Properties.Name | Where-Object {$_ -cnotin $fields}).Count -ne 0 -or
      $binding.schema -cne 'gongde-private-source-owner-binding.v2' -or
      $binding.inputClass -cne 'private-source-zip-only' -or
      $binding.sourceIdentity -cne $ExpectedSourceIdentity -or
      $binding.ownerApprovalId -cne $ExpectedOwnerApprovalId -or
      $binding.privateAccessControlAttestationId -cnotmatch '\A[A-Za-z0-9._:-]{1,128}\z' -or
      $binding.transport -cne $receipt.transport -or
      $binding.repository -cne $env:GITHUB_REPOSITORY -or
      $binding.chunkPrefix -cne $prefix -or
      $binding.chunkCount -ne 34 -or $binding.chunkCharacters -ne 30000 -or
      $binding.base64Characters -ne 1014564 -or
      $binding.sourceZipSha256 -cne $receipt.expectedSourceZipSha256 -or
      $binding.sourceManifestSha256 -cne $receipt.expectedSourceManifestSha256 -or
      $binding.sourceZipBytes -ne 760923) {
    throw [GongdeSourceReceiver.ReceiverFault]::new('OWNER_BINDING_CONTRACT')
  }
  # Read expiry from the verified JSON string, not ConvertFrom-Json date coercion.
  $expiryDocument=[Text.Json.JsonDocument]::Parse($utf8.GetString($raw),[Text.Json.JsonDocumentOptions]::new())
  try {
    $expiryElement=$expiryDocument.RootElement.GetProperty('expiresAtUtc')
    if ($expiryElement.ValueKind -ne [Text.Json.JsonValueKind]::String) {
      throw [GongdeSourceReceiver.ReceiverFault]::new('OWNER_BINDING_EXPIRED')
    }
    $expiryText=$expiryElement.GetString()
  } finally {$expiryDocument.Dispose()}
  $expires=[DateTimeOffset]::MinValue
  if ($expiryText -cnotmatch '\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z\z' -or
      -not [DateTimeOffset]::TryParse($expiryText,[Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AssumeUniversal,[ref]$expires) -or
      $expires -le [DateTimeOffset]::UtcNow -or $expires -gt [DateTimeOffset]::UtcNow.AddDays(7)) {
    throw [GongdeSourceReceiver.ReceiverFault]::new('OWNER_BINDING_EXPIRED')
  }
  $text=[Text.StringBuilder]::new(1014564)
  for ($index=1; $index -le 34; $index++) {
    $name=$prefix+$index.ToString('00')
    $chunk=[Environment]::GetEnvironmentVariable($name)
    $expectedLength=if ($index -eq 34) {24564} else {30000}
    if ($null -eq $chunk -or $chunk.Length -ne $expectedLength -or
        $chunk -cnotmatch '\A[A-Za-z0-9+/]+\z') {
      throw [GongdeSourceReceiver.ReceiverFault]::new('SOURCE_CHUNK_FORMAT')
    }
    [void]$text.Append($chunk)
    [Environment]::SetEnvironmentVariable($name,$null)
    $chunk=$null
  }
  $bytes=[Convert]::FromBase64String($text.ToString())
  [void]$text.Clear(); $text=$null
  if ($bytes.Length -ne 760923 -or (Get-BytesSha $bytes) -cne $receipt.expectedSourceZipSha256) {
    throw [GongdeSourceReceiver.ReceiverFault]::new('SOURCE_ZIP_SIZE_OR_SHA')
  }
  $receipt.ownerBindingSha256=$ExpectedOwnerBindingSha256
  $receipt.sourceIdentitySha256=Get-BytesSha ($utf8.GetBytes($ExpectedSourceIdentity))
  $receipt.ownerApprovalIdSha256=Get-BytesSha ($utf8.GetBytes($ExpectedOwnerApprovalId))
  $receipt.receivedZipBytes=$bytes.Length
  $stageRoot=Get-RunnerLocalPath (Join-Path $env:RUNNER_TEMP ('source-stage-'+[Guid]::NewGuid().ToString('N'))) -Fresh
  $stage=[GongdeSourceReceiver.DirectoryLease]::CreateExclusive($stageRoot)
  $receipt.stageRoot=$stageRoot
  # Base64 and ZIP validation remain in memory; no ZIP/payload file is staged.
  $plan=[GongdeSourceReceiver.ArchiveVerifier]::Verify($bytes)
  [Array]::Clear($bytes,0,$bytes.Length); $bytes=$null
  if ($clock.ElapsedMilliseconds -gt 55000) {throw [GongdeSourceReceiver.ReceiverFault]::new('RECEIVER_TIME_BOUND')}
  # Verify ALL paths, regular attributes, CRC, count, manifest and file hashes
  # before extraction. CREATE_NEW and pinned non-reparse directories only.
  $destination=[GongdeSourceReceiver.DirectoryLease]::CreateExclusive($DestinationRoot)
  foreach ($entry in $plan.Entries) {
    if ($clock.ElapsedMilliseconds -gt 55000) {throw [GongdeSourceReceiver.ReceiverFault]::new('RECEIVER_TIME_BOUND')}
    $destination.WriteNew($entry.Path,$entry.Bytes)
  }
  $receipt.sourceArchiveAndAllFilesVerified=$true; $receipt.regularEntriesVerified=22
  $receipt.sourceRoot=$DestinationRoot; $receipt.result='SOURCE_VERIFIED_NOT_NATIVE_ACCEPTANCE'
  Write-LeasedJson $stage 'receiver-receipt.json' $receipt
  [pscustomobject]@{SourceRoot=$DestinationRoot;StageRoot=$stageRoot;ReceiptPath=(Join-Path $stageRoot 'receiver-receipt.json')}
} catch {
  $receipt.errorCode=Get-RedactedFailureCode $_
  # Public diagnostics are literal fault codes only, never exception details.
  $allowedFaultCodes=@(
    'AUX',
    'COM',
    'CON',
    'DIRECTORY_IDENTITY',
    'DIRECTORY_PIN_FAILED',
    'EXTRACT_DIRECTORY_EXISTS',
    'EXTRACT_ESCAPE',
    'EXTRACT_FILE_EXISTS_OR_CREATE_FAILED',
    'EXTRACT_FILE_IDENTITY',
    'HANDLE_FINAL_PATH',
    'HANDLE_LOCAL_PATH',
    'INPUT_NOT_REGULAR',
    'INPUT_SIZE',
    'LPT',
    'NUL',
    'OWNER_BINDING_CONTRACT',
    'OWNER_BINDING_EXPIRED',
    'OWNER_BINDING_REQUIRED',
    'OWNER_BINDING_SHA',
    'PATH_FORMAT',
    'PATH_NOT_RUNNER_TEMP',
    'PATH_REPARSE',
    'PRN',
    'RECEIVER_INTERNAL_FAILURE',
    'RECEIVER_TIME_BOUND',
    'ROOT_EXISTS',
    'ROOT_EXISTS_OR_CREATE_FAILED',
    'ROOT_PARENT_MISSING',
    'SOURCE_CHUNK_FORMAT',
    'SOURCE_FILE_BINDING',
    'SOURCE_MANIFEST_COUNT',
    'SOURCE_MANIFEST_PATH',
    'SOURCE_MANIFEST_SCHEMA',
    'SOURCE_MANIFEST_SHA',
    'SOURCE_MANIFEST_WHITELIST',
    'SOURCE_ZIP_SHA',
    'SOURCE_ZIP_SIZE',
    'SOURCE_ZIP_SIZE_OR_SHA',
    'VERSION',
    'ZIP64_BOUNDS',
    'ZIP64_DUPLICATE',
    'ZIP64_EOCD',
    'ZIP64_FIELD',
    'ZIP64_LOCATOR',
    'ZIP_AGGREGATE',
    'ZIP_BOUNDS',
    'ZIP_CENTRAL_COUNT',
    'ZIP_CENTRAL_HEADER',
    'ZIP_CENTRAL_TRAILING',
    'ZIP_CRC',
    'ZIP_DUPLICATE',
    'ZIP_ENCODING',
    'ZIP_ENTRY_LIMIT',
    'ZIP_EOCD',
    'ZIP_EXTRA_BOUNDS',
    'ZIP_FLAGS_METHOD',
    'ZIP_LOCAL_DATA',
    'ZIP_LOCAL_HEADER',
    'ZIP_LOCAL_NAME',
    'ZIP_MULTIDISK',
    'ZIP_NON_REGULAR',
    'ZIP_PATH',
    'ZIP_RESERVED_NAME',
    'ZIP_RUNTIME_COUNT',
    'ZIP_RUNTIME_NAME',
    'ZIP_RUNTIME_SIZE',
    'ZIP_STREAM_SIZE',
    'ZIP_WHITELIST'
  )
  if ($receipt.errorCode -cnotin $allowedFaultCodes) { $receipt.errorCode='RECEIVER_INTERNAL_FAILURE' }
  [Console]::Error.WriteLine('SOURCE_RECEIVER_ERROR_CODE='+$receipt.errorCode)
  if ($stage) {try {Write-LeasedJson $stage 'receiver-failure.json' $receipt} catch {}}
  throw 'Controlled source input failed closed; no source execution authorized. No private input is printed.'
} finally {
  for ($index=1; $index -le 34; $index++) {
    [Environment]::SetEnvironmentVariable($prefix+$index.ToString('00'),$null)
  }
  if ($destination) {$destination.Dispose()}; if ($stage) {$stage.Dispose()}
}
