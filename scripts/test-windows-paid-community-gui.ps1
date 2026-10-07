#Requires -Version 7.4
<#
Independent fixed paid-community acceptance, fresh GitHub-hosted Windows only.
Current public installer is SHA/size pinned. Its actual installed EXE is
measured after installation; no old CI EXE or source-commit identity is assumed.
No build, signing key, source intake, original SDK or security-policy changes.
InputDirectory: exactly the three pinned synthetic case files below.
Real UTC must satisfy the embedded license window before every import.
Export sanitized receipts and cropped owned opaque test GUI screenshots only.
No Windows 11 human, unpublished-source, physical-input or purchase-flow PASS.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$InstallerPath,
  [Parameter(Mandatory=$true)][string]$InputDirectory,
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
    $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP) -or
    [string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ID)) {
  throw 'PAID_GUI_REQUIRES_FRESH_GITHUB_HOSTED_WINDOWS'
}
$installerSha='817b55b91a3283a699c1f901eccfbec4c4ee7149b720b6f53a6ca08f69e5ee06'
$installerBytes=2838381
$issuedAt=1791318267L
$importBefore=1791404667L
$pins=@(
  @{name='licensed';file='signed-schema3.nmgpack';bytes=1646;sha='0e622724aad2c98f57e6c50c91a980fa5f74ee667e8c3c3927fd90cca83e89a7'},
  @{name='invalid-signature';file='invalid-signature.nmgpack';bytes=984;sha='824c4c70919a15b8b5da2f52a33434d6176f009452abd5f45230130f49ba94a1'},
  @{name='mixed';file='mixed-licensed-schema3-plus-synthetic-schema1.nmgpacks';bytes=1897;sha='b8304f78d676a7b6a715460c77710e41a05d0710e97788d46aba96cac4f788c0'}
)
$controlSha='a1a93ed04027a0751a23131f8c052ee07510b671262c79fd3d7c5f8ce5ff437c'
$utf8=[Text.UTF8Encoding]::new($false,$true)
$locks=[Collections.Generic.List[IO.FileStream]]::new()
$ownedProcesses=[Collections.Generic.List[object]]::new()
$inputs=[Collections.Generic.List[object]]::new()
$cleanupErrors=[Collections.Generic.List[string]]::new()
$cleanupFailures=[Collections.Generic.List[object]]::new()
$runId=[Guid]::NewGuid().ToString('N')
$outputRoot=$null;$outputDirectoryOwned=$false;$receiptSequence=0
$installDir=$null;$installDirectoryOwned=$false;$ownedInstallDirectory=$null
$clientPath=$null;$installedClientBinding=$null;$dataRoot=$null;$catalogDir=$null
$clientStarted=$false;$isolationEstablished=$false;$installAttempted=$false
$uninstallerBinding=$null;$failure=$null;$phase='preflight'
$report=[ordered]@{
  schema='gongde-windows-paid-community-gui.v1'
  classification='CURRENT_PUBLIC_INSTALLER_ISOLATED_WINDOWS2022_GUI'
  SourceCommitNotVerified=$true;workflowRunId=$env:GITHUB_RUN_ID
  workflowRunAttempt=$env:GITHUB_RUN_ATTEMPT;acceptanceToolRef=$env:GITHUB_SHA
  startedAt=[DateTime]::UtcNow.ToString('o');result='FAIL'
  guiAcceptancePassed=$false;actualGuiObserved=$false;normalGuiImportObserved=$false
  switchingChecksPassed=$false;installer=$null;installedClient=$null;desktop=$null
  cases=[Collections.Generic.List[object]]::new()
  processes=[Collections.Generic.List[object]]::new()
  clockChecks=[Collections.Generic.List[object]]::new()
  invalidSignature=$null
  cleanup=[ordered]@{attempted=$false;complete=$false;errors=@();phase='not-started'
    failurePhase=$null;failureType=$null;errorCode=$null}
  failure=$null
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


function Get-SafeFailureType($Record) {
  $name=$Record.Exception.GetType().FullName
  $allowed=@(
    'System.Management.Automation.RuntimeException',
    'System.Management.Automation.MethodInvocationException',
    'System.Management.Automation.PropertyNotFoundException',
    'System.Management.Automation.PSArgumentException',
    'System.Management.Automation.PSInvalidOperationException',
    'System.InvalidOperationException','System.IO.IOException',
    'System.IO.FileNotFoundException','System.IO.DirectoryNotFoundException',
    'System.UnauthorizedAccessException','System.ObjectDisposedException',
    'System.ArgumentException','System.ComponentModel.Win32Exception',
    'System.TimeoutException'
  )
  if ($name -cin $allowed) {return $name}
  return 'OTHER_EXCEPTION'
}
function Get-SafeFailureCode($Record) {
  # Exact literals only. Never export an arbitrary exception Message.
  $allowed=@(
    'PAID_GUI_REQUIRES_FRESH_GITHUB_HOSTED_WINDOWS',
    'PAID_LICENSE_REAL_CLOCK_OUTSIDE_WINDOW',
    'PAID_GUI_CASE_FAILED',
    'PAID_MAIN_NOT_OBSERVABLE',
    'PAID_TEST_UI_NOT_OBSERVABLE',
    'PAID_PACK_ENTRY_COUNT',
    'PAID_PACK_UNSAFE_ENTRY',
    'PAID_PACK_SIZE',
    'PAID_PACK_MANIFEST',
    'PAID_PACK_ID',
    'PAID_PACK_IDENTITY',
    'PAID_PACK_LICENSED_ID',
    'PAID_PACK_LICENSE_TIME_PIN',
    'PAID_PACK_CONTROL',
    'PAID_CATALOG_CHANGED_UNEXPECTEDLY',
    'PAID_REJECTION_APP_EXITED_BEFORE_DIALOG',
    'PAID_REJECTION_UNKNOWN_DIALOG',
    'PAID_REJECTION_WRONG_ERROR',
    'PAID_REJECTION_NO_NATIVE_DIALOG',
    'PAID_REJECTION_CHANGED_SELECTION',
    'PAID_REJECTION_FORCED_EXIT',
    'PAID_OWNED_PROCESS_IMAGE_DRIFT',
    'PAID_INSTALLED_CLIENT_IMAGE_DRIFT',
    'PAID_CATALOG_CARDINALITY',
    'PAID_PATH_SCOPE',
    'PAID_OUTPUT_NO_CLOBBER',
    'PAID_OUTPUT_NOT_EXCLUSIVELY_CREATED',
    'PAID_INPUT_FILE_SET',
    'PAID_MIXED_ENTRY_SET',
    'PAID_MIXED_INNER_BYTES',
    'PAID_MIXED_DISTINCT_ID',
    'PAID_INSTALLED_CLIENT_PATH_NOT_UNIQUE',
    'PAID_INITIAL_CATALOG_NOT_EMPTY',
    'PAID_GUI_STAGE_FAILED',
    'PAID_FINAL_RECEIPT_FAILED',
    'PAID_COMMUNITY_WINDOWS2022_GUI_FAILED_SEE_SANITIZED_RECEIPT',
    'PAID_MAIN_IDENTITY_CHANGED',
    'PAID_CAPTURE_TARGET_IDENTITY_CHANGED',
    'PAID_CAPTURE_TARGET_OWNER_CHANGED',
    'PAID_MODAL_OWNER_NOT_VERIFIED',
    'PAID_CLEANUP_PHASE_FAILED'
  )
  if ($Record.Exception.Message -cin $allowed) {return $Record.Exception.Message}
  return 'PAID_GUI_STAGE_FAILED'
}
$cleanupPhaseCodes=@{
  'not-started'='NOT_STARTED'
  'stop-owned-close'='OWNED_CLOSE_FAILED'
  'stop-owned-wait'='OWNED_STOP_WAIT_FAILED'
  'dispose-input-locks'='INPUT_LOCK_RELEASE_FAILED'
  'assert-exit'='OWNED_EXIT_ASSERT_FAILED'
  'release-handles'='OWNED_HANDLE_RELEASE_FAILED'
  'foreign-client'='FOREIGN_CLIENT_CHECK_FAILED'
  'startup-binding'='STARTUP_BINDING_FAILED'
  'uninstall-binding'='UNINSTALL_BINDING_FAILED'
  'uninstaller-start'='UNINSTALLER_START_FAILED'
  'uninstaller-wait'='UNINSTALLER_WAIT_FAILED'
  'uninstall-log'='UNINSTALL_LOG_CHECK_FAILED'
  'release-uninstaller-handles'='UNINSTALLER_HANDLE_RELEASE_FAILED'
  'remove-install-directory'='OWNED_INSTALL_DIRECTORY_REMOVE_FAILED'
  'cleanup-app-artifacts'='APP_ARTIFACT_CLEANUP_FAILED'
  'final-stop-owned-processes'='FINAL_OWNED_STOP_FAILED'
  'dispose-final-locks'='FINAL_LOCK_RELEASE_FAILED'
  'final-exit-record'='FINAL_EXIT_RECORD_FAILED'
  'final-handle-dispose'='FINAL_HANDLE_DISPOSE_FAILED'
  'complete'='NONE'
  'not-required'='NONE'
}
function Set-CleanupPhase([string]$Stage) {
  Assert-Condition ($cleanupPhaseCodes.ContainsKey($Stage)) 'PAID_CLEANUP_PHASE_FAILED'
  $report.cleanup.phase=$Stage
}
function Add-CleanupFailure([string]$Stage,$Record) {
  Assert-Condition ($cleanupPhaseCodes.ContainsKey($Stage)) 'PAID_CLEANUP_PHASE_FAILED'
  $code=$cleanupPhaseCodes[$Stage]
  $type=Get-SafeFailureType $Record
  $cleanupErrors.Add($code)
  $cleanupFailures.Add([ordered]@{phase=$Stage;failureType=$type;errorCode=$code})
  if ($null -eq $report.cleanup.errorCode) {
    $report.cleanup.failurePhase=$Stage
    $report.cleanup.failureType=$type
    $report.cleanup.errorCode=$code
  }
  $report.cleanup.complete=$false
}

function Assert-LiveLicenseWindow {
  $now=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $report.clockChecks.Add([ordered]@{unix=$now;issuedAt=$issuedAt;importBefore=$importBefore;phase=$phase})
  Assert-Condition ($now -ge $issuedAt -and $now -le $importBefore) 'PAID_LICENSE_REAL_CLOCK_OUTSIDE_WINDOW'
}
function Get-PublicCatalog($Snapshot) {
  return @($Snapshot | ForEach-Object {
    [ordered]@{file=[IO.Path]::GetFileName($_.path);bytes=$_.bytes;sha256=$_.sha256}
  } | Sort-Object { $_.file })
}
function Write-Receipt([switch]$Final) {
  if (-not $outputDirectoryOwned) {return}
  Get-SafePath $outputRoot | Out-Null
  $safeCases=@($report.cases.ToArray() | ForEach-Object {
    $c=$_
    [ordered]@{
      name=$c.name;result=$c.result;guiPhase=$c.guiPhase;failurePhase=$c.failurePhase
      failureCode=$(if ($c.failure) {'PAID_GUI_CASE_FAILED'} else {$null})
      input=$c.input;actualImportedCount=$c.actualImportedCount
      successDialogObserved=$c.successDialogObserved
      switchingObserved=$c.switchingObserved;restartSelectionObserved=$c.restartSelectionObserved
      catalogBefore=Get-PublicCatalog $c.catalogBefore;catalogAfter=Get-PublicCatalog $c.catalogAfter
      switches=@($c.switches.ToArray() | ForEach-Object {
        [ordered]@{expectedPackId=$_.expectedPackId;actualPackId=$_.actualPackId;selected=$_.selected
          cardDispatch=$_.cardDispatch;confirmCompleted=($null -ne $_.confirmDispatch -and $_.confirmDispatch.Completed)}
      })
      observations=@($c.observations.ToArray())
    }
  })
  $safeProcesses=@($report.processes.ToArray() | ForEach-Object {
    [ordered]@{role=$_.role;pid=$_.pid;parentPid=$_.parentPid;waitCompleted=$_.waitCompleted
      exitCode=$_.exitCode;exitCodeStatus=$_.exitCodeStatus;forcedTermination=$_.forcedTermination}
  })
  $safe=[ordered]@{
    schema=$report.schema;classification=$report.classification;SourceCommitNotVerified=$true
    workflowRunId=$report.workflowRunId;workflowRunAttempt=$report.workflowRunAttempt
    acceptanceToolRef=$report.acceptanceToolRef;runId=$runId;startedAt=$report.startedAt
    recordedAt=[DateTime]::UtcNow.ToString('o');phase=$phase;result=$report.result
    guiAcceptancePassed=$report.guiAcceptancePassed
    installer=$(if ($report.installer) {
      [ordered]@{url='https://download.gongde.zqscreen.cn/niuma-merit-windows-0.8.4-setup.exe'
        bytes=$report.installer.bytes;sha256=$report.installer.sha256
        fileNumericVersion=$report.installer.fileNumericVersion;signatureStatus=$report.installer.signatureStatus}
    } else {$null})
    installedClient=$(if ($report.installedClient) {
      [ordered]@{file='niuma-merit.exe';bytes=$report.installedClient.bytes;sha256=$report.installedClient.sha256
        fileNumericVersion=$report.installedClient.fileNumericVersion;productNumericVersion=$report.installedClient.productNumericVersion
        peMachine=$report.installedClient.peMachine;signatureStatus=$report.installedClient.signatureStatus
        measuredFromFreshOwnedInstallation=$true}
    } else {$null})
    inputPins=@($pins | ForEach-Object {[ordered]@{file=$_.file;bytes=$_.bytes;sha256=$_.sha}})
    clockChecks=$report.clockChecks.ToArray();cases=$safeCases
    invalidSignature=$report.invalidSignature;processes=$safeProcesses
    isolation=[ordered]@{freshRunnerOnly=$true;preexistingClientDataNeverCleared=$true
      established=$isolationEstablished;outputExclusivelyOwned=$outputDirectoryOwned
      installationExclusivelyOwned=$installDirectoryOwned}
    cleanup=[ordered]@{attempted=$report.cleanup.attempted;complete=$report.cleanup.complete
      phase=$report.cleanup.phase;failurePhase=$report.cleanup.failurePhase
      failureType=$report.cleanup.failureType;errorCount=$cleanupErrors.Count
      errorCode=$report.cleanup.errorCode;failures=$cleanupFailures.ToArray()}
    failure=$report.failure
    boundaries=[ordered]@{Windows11HumanAcceptance=$false;SourceCommitNotVerified=$true
      rebuiltClient=$false;signingKeyPresent=$false;productionStateChanged=$false;originalSdkChanged=$false
      physicalInputAccepted=$false;manualArtworkIdentityAccepted=$false;websitePurchaseAndDeliveryAccepted=$false
      securityPolicyChanged=$false;receiptAndOwnedOpaqueTestUiOnly=$true}
  }
  $script:receiptSequence++
  $leaf=if ($Final) {'receipt.json'} else {'receipt-{0:D6}.json' -f $script:receiptSequence}
  $stream=[IO.File]::Open((Join-Path $outputRoot $leaf),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {$bytes=$utf8.GetBytes(($safe | ConvertTo-Json -Depth 16)+[char]10);$stream.Write($bytes,0,$bytes.Length)}
  finally {$stream.Dispose()}
  Write-Output ('PAID_GUI_CHECKPOINT='+$leaf)
}
function Capture-Observation($Case,$Main,$Dialog,[string]$Name,[int]$ObservedProcessId = 0) {
  [NmgGuiObserver]::CheckDesktop()
  if ($ObservedProcessId -eq 0) { $ObservedProcessId = [int]$Case.appProcess.pid }
  Assert-Condition ($ObservedProcessId -gt 0) 'PAID_CAPTURE_TARGET_IDENTITY_CHANGED'
  $leaf=$null;$sha=$null
  if ($Dialog) {
    [NmgGuiObserver]::AssertCaptureContext($Main.Handle,$Dialog.Handle,$ObservedProcessId,$Dialog.ClassName,$Dialog.Owner)
    Assert-Condition ([NmgGuiObserver]::Observable($Dialog.Handle)) 'PAID_TEST_UI_NOT_OBSERVABLE'
    $leaf=$Case.name+'-'+$Name+'.png'
    [NmgGuiObserver]::CaptureOwnedOpaque((Join-Path $outputRoot $leaf),$Dialog.Handle,$ObservedProcessId)
    [NmgGuiObserver]::AssertCaptureContext($Main.Handle,$Dialog.Handle,$ObservedProcessId,$Dialog.ClassName,$Dialog.Owner)
    $sha=(Get-FileHash -LiteralPath (Join-Path $outputRoot $leaf) -Algorithm SHA256).Hash.ToLowerInvariant()
  } else {
    [NmgGuiObserver]::AssertCaptureContext($Main.Handle,[IntPtr]::Zero,$ObservedProcessId,'',[IntPtr]::Zero)
  }
  # No transparent pet-window/full-desktop screenshots. Only opaque owned
  # test dialog/picker/menu surfaces are cropped, with foreign pixels masked.
  $Case.observations.Add([ordered]@{stage=$Name;observedAt=[DateTime]::UtcNow.ToString('o')
    ownedWindowObserved=$true;screenshot=$leaf;screenshotSha256=$sha})
  $report.actualGuiObserved=$true
  Write-Receipt
}
function Inspect-PaidPack([byte[]]$Bytes,[bool]$Licensed) {
  $zip=Open-ReadOnlyZip $Bytes
  try {
    Assert-Condition ($zip.Entries.Count -ge 2 -and $zip.Entries.Count -le 64) 'PAID_PACK_ENTRY_COUNT'
    $names=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    [long]$total=0
    foreach ($entry in $zip.Entries) {
      Assert-Condition ($entry.FullName -notmatch '(^[\\/]|\\|(^|/)\.\.(/|$)|:)' -and
        -not $entry.FullName.EndsWith('/') -and $names.Add($entry.FullName)) 'PAID_PACK_UNSAFE_ENTRY'
      $total+=$entry.Length
      Assert-Condition ($entry.Length -ge 0 -and $total -le 50MB) 'PAID_PACK_SIZE'
    }
    $entry=$zip.GetEntry('manifest.json')
    Assert-Condition ($null -ne $entry) 'PAID_PACK_MANIFEST'
    $m=$utf8.GetString((Read-ZipBytes $entry 256KB)) | ConvertFrom-Json
    $schema=Get-Integer (Get-RequiredField $m 'schema_version') 'schema_version' 1 3
    $id=Get-RequiredField $m 'id'
    Assert-Condition ($id -is [string] -and $id -cmatch '\Acreator\.[a-f0-9]{32}\.[a-z0-9-]{1,32}\z') 'PAID_PACK_ID'
    Assert-Condition ((Get-RequiredField $m 'publisher') -ceq 'community' -and
      (Get-RequiredField $m 'version') -ceq '1.0.0') 'PAID_PACK_IDENTITY'
    if ($Licensed) {
      Assert-Condition ($schema -eq 3 -and $id -ceq 'creator.b55e561012a1c12c71efe58a50aa2810.operator-schema3') 'PAID_PACK_LICENSED_ID'
      $license=Get-RequiredField $m 'license'
      Assert-Condition ((Get-Integer (Get-RequiredField $license 'issued_at') 'issued_at' 0 9999999999) -eq $issuedAt -and
        (Get-Integer (Get-RequiredField $license 'import_before') 'import_before' 0 9999999999) -eq $importBefore) 'PAID_PACK_LICENSE_TIME_PIN'
    } else {
      Assert-Condition ($schema -eq 1 -and $null -eq $m.PSObject.Properties['license']) 'PAID_PACK_CONTROL'
    }
    return [pscustomobject]@{id=$id;schema=$schema;version='1.0.0';bytes=$Bytes.Length;sha256=Get-Sha $Bytes}
  } finally {$zip.Dispose()}
}
function Assert-CatalogEquals($Before,$After) {
  $left=@(Get-PublicCatalog $Before) | ConvertTo-Json -Depth 5 -Compress
  $right=@(Get-PublicCatalog $After) | ConvertTo-Json -Depth 5 -Compress
  Assert-Condition ($left -ceq $right) 'PAID_CATALOG_CHANGED_UNEXPECTEDLY'
}
function Invoke-SignatureRejection($InputCase) {
  Assert-LiveLicenseWindow
  Assert-NoForeignClient
  $before=Get-CatalogSnapshot
  $selected=[NmgGuiObserver]::SelectedPack((Join-Path $dataRoot 'data.ini'))
  $case=[ordered]@{name='invalid-signature';appProcess=$null;guiPhase='launch'
    observations=[Collections.Generic.List[object]]::new();controlEvents=[Collections.Generic.List[object]]::new()}
  $rejection=[ordered]@{result='FAIL';expectedCode='INVALID_LICENSE_SIGNATURE'
    signatureDialogObserved=$false;catalogUnchanged=$false;selectionUnchanged=$false;exitCode=$null
    observations=$case.observations}
  $report.invalidSignature=$rejection
  $app=Start-OwnedProcess $clientPath ('"'+$InputCase.binding.path+'"') 'app-invalid-signature'
  $case.appProcess=$app.evidence
  $timer=[Diagnostics.Stopwatch]::StartNew();$observed=$false
  while ($timer.ElapsedMilliseconds -lt 25000) {
    Assert-Condition (-not $app.handle.HasExited) 'PAID_REJECTION_APP_EXITED_BEFORE_DIALOG'
    $windows=@([NmgGuiObserver]::Windows($app.handle.Id))
    $main=@($windows | Where-Object {$_.ClassName -ceq 'NiuMaMeritWindow'})
    $dialogs=@($windows | Where-Object {$_.ClassName -ceq '#32770'})
    if ($main.Count -ne 1 -or $dialogs.Count -eq 0) {Start-Sleep -Milliseconds 100;continue}
    Assert-Condition ($dialogs.Count -eq 1 -and $dialogs[0].Owner -eq $main[0].Handle) 'PAID_REJECTION_UNKNOWN_DIALOG'
    $expected=[regex]::Unescape('\u5f62\u8c61\u5305\u6388\u6743\u7b7e\u540d\u65e0\u6548\u3002')
    Assert-Condition ($dialogs[0].Text.Trim() -ceq $expected) 'PAID_REJECTION_WRONG_ERROR'
    Capture-Observation $case $main[0] $dialogs[0] 'rejection'
    Confirm-OwnedDialog $case $app $main[0] $dialogs[0] 'signature-error-confirmation'
    $observed=$true;break
  }
  Assert-Condition $observed 'PAID_REJECTION_NO_NATIVE_DIALOG'
  Assert-CatalogEquals $before (Get-CatalogSnapshot)
  Assert-Condition ([NmgGuiObserver]::SelectedPack((Join-Path $dataRoot 'data.ini')) -ceq $selected) 'PAID_REJECTION_CHANGED_SELECTION'
  $main=Wait-OwnedGuiWindow $app 'NiuMaMeritWindow'
  Open-OwnedMenuItem $case $app $main 'Exit' 'rejection-exit'
  Wait-OwnedProcess $app 10000
  Assert-Condition (-not $app.evidence.forcedTermination) 'PAID_REJECTION_FORCED_EXIT'
  Assert-CatalogEquals $before (Get-CatalogSnapshot)
  $rejection.signatureDialogObserved=$true;$rejection.catalogUnchanged=$true;$rejection.selectionUnchanged=$true
  $rejection.exitCode=$app.evidence.exitCode;$rejection.result='PASS'
  Write-Receipt
}
function Get-RunValue([string]$Hive) {
  $key = Get-Item -LiteralPath ($Hive + '\Software\Microsoft\Windows\CurrentVersion\Run') -ErrorAction SilentlyContinue
  if ($key -and $key.GetValueNames() -contains 'NiuMaMerit') { return [string]$key.GetValue('NiuMaMerit') }
  return $null
}

function Assert-NoForeignClient {
  foreach ($process in @(Get-Process -Name 'niuma-merit' -ErrorAction SilentlyContinue)) {
    $ours = @($ownedProcesses.ToArray() | Where-Object { $_.evidence.pid -eq $process.Id -and -not $_.evidence.waitCompleted })
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
    exitCode = $null; exitCodeStatus = 'pending'; exitCodeSource = $null
    exitCodeQueryError = $null; nativeHandleRetained = $false
    forcedTermination = $false; parentPid = $null
  }
  $owned = [pscustomobject]@{
    handle = $process; processHandle = $null; handlesReleased = $false
    creationTimeUtc = $null; evidence = $evidence; rootPid = $process.Id
  }
  $ownedProcesses.Add($owned)
  $report.processes.Add($evidence)
  # Acquire and retain the actual OS handle before polling or inspecting the
  # image. This keeps exit status queryable after the PID disappears/recycles.
  $owned.processHandle = $process.SafeHandle
  Assert-Condition (-not $owned.processHandle.IsInvalid -and -not $owned.processHandle.IsClosed) `
    "Could not retain the owned root process handle: $Role"
  $owned.creationTimeUtc = $process.StartTime.ToUniversalTime()
  $evidence.nativeHandleRetained = $true
  Assert-Condition ((Get-SafePath $process.MainModule.FileName) -ieq $start.FileName) 'PAID_OWNED_PROCESS_IMAGE_DRIFT'
  if ($Role.StartsWith('app-', [StringComparison]::Ordinal)) {
    Assert-Condition ($null -ne $installedClientBinding -and $start.FileName -ieq $clientPath -and
      (Get-FileHash -LiteralPath $clientPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $installedClientBinding.sha256) 'PAID_INSTALLED_CLIENT_IMAGE_DRIFT'
  }
  return $owned
}

function Observe-OwnedChildren {
  # Keep handles for observed installer descendants. Never use name-based kills.
  foreach ($parent in $ownedProcesses.ToArray()) {
    if ($parent.evidence.waitCompleted -or $parent.handlesReleased -or $parent.handle.HasExited) { continue }
    foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($parent.handle.Id)")) {
      if (@($ownedProcesses.ToArray() | Where-Object { $_.evidence.pid -eq $child.ProcessId }).Count) { continue }
      try { $handle = [Diagnostics.Process]::GetProcessById([int]$child.ProcessId) }
      catch [ArgumentException] { continue }
      try {
        $processHandle = $handle.SafeHandle
        Assert-Condition (-not $processHandle.IsInvalid -and -not $processHandle.IsClosed) `
          'Could not retain the observed child process handle.'
        $creationTime = $handle.StartTime.ToUniversalTime()
        if ($creationTime -lt $parent.creationTimeUtc -or
            $child.CreationDate -isnot [DateTime] -or
            [Math]::Abs(($creationTime - $child.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 1) {
          $handle.Dispose(); continue
        }
        $image = [string]$child.ExecutablePath
        if ([string]::IsNullOrWhiteSpace($image) -and -not $handle.HasExited) {
          $image = $handle.MainModule.FileName
        }
      } catch { $handle.Dispose(); throw }
      $evidence = [ordered]@{
        role = $parent.evidence.role + '-child'; pid = $handle.Id; path = $image
        arguments = $null; startedAt = $creationTime.ToString('o')
        waitCompleted = $false; exitCode = $null; exitCodeStatus = 'pending'
        exitCodeSource = $null; exitCodeQueryError = $null; nativeHandleRetained = $true
        forcedTermination = $false
        parentPid = $parent.handle.Id
      }
      $ownedProcesses.Add([pscustomobject]@{
        handle = $handle; processHandle = $processHandle; handlesReleased = $false
        creationTimeUtc = $creationTime; evidence = $evidence; rootPid = $parent.rootPid
      })
      $report.processes.Add($evidence)
    }
  }
}

function Record-Exit($Owned) {
  if ($Owned.handlesReleased -or
      ($Owned.evidence.waitCompleted -and $Owned.evidence.exitCodeStatus -eq 'known')) { return }
  if ($Owned.handle.WaitForExit(0)) {
    if (-not $Owned.evidence.waitCompleted) {
      $Owned.evidence.waitCompleted = $true
      $Owned.evidence['exitedAt'] = [DateTime]::UtcNow.ToString('o')
    }
    [uint32]$nativeCode = 0
    if ($null -ne $Owned.processHandle -and -not $Owned.processHandle.IsClosed -and
        -not $Owned.processHandle.IsInvalid -and
        [NmgGuiObserver]::GetExitCodeProcess($Owned.processHandle, [ref]$nativeCode)) {
      $Owned.evidence.exitCode = [long]$nativeCode
      $Owned.evidence.exitCodeStatus = 'known'
      $Owned.evidence.exitCodeSource = 'GetExitCodeProcess on retained native process handle after completed wait'
      $Owned.evidence.exitCodeQueryError = $null
      return
    }
    $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $queryError = "Native exit query unavailable (Win32 $nativeError)."
    try {
      $managedCode = $Owned.handle.ExitCode
      if ($null -ne $managedCode -and ($managedCode -is [int] -or $managedCode -is [long])) {
        $Owned.evidence.exitCode = $managedCode
        $Owned.evidence.exitCodeStatus = 'known'
        $Owned.evidence.exitCodeSource = 'Process.ExitCode after completed wait'
        $Owned.evidence.exitCodeQueryError = $queryError
        return
      }
      $queryError += ' Process.ExitCode returned no numeric status.'
    } catch { $queryError += ' ' + $_.Exception.Message }
    # A completed wait proves termination, not a successful exit. Preserve the
    # unavailable status as unknown; never replace a null status with zero.
    $Owned.evidence.exitCode = $null
    $Owned.evidence.exitCodeStatus = 'unknown'
    $Owned.evidence.exitCodeSource = 'Unavailable after completed process wait'
    $Owned.evidence.exitCodeQueryError = $queryError
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
      Assert-Condition ($Owned.evidence.exitCodeStatus -eq 'known' -and
        $null -ne $Owned.evidence.exitCode -and $Owned.evidence.exitCode -eq 0) `
        "Owned root process must have a real zero exit code: $($Owned.evidence.role), status $($Owned.evidence.exitCodeStatus), code $($Owned.evidence.exitCode)"
      foreach ($member in $members) {
        if ($null -ne $member.evidence.parentPid -and $member.evidence.exitCodeStatus -eq 'unknown') {
          $member.evidence['exitCodeValidation'] = 'Unknown exited child status; neither success nor failure asserted'
          continue
        }
        Assert-Condition ($member.evidence.exitCodeStatus -eq 'known' -and
          $null -ne $member.evidence.exitCode -and $member.evidence.exitCode -eq 0) `
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
      if (-not $owned.handlesReleased -and -not $owned.evidence.waitCompleted -and -not $owned.handle.HasExited) {
        foreach ($window in [NmgGuiObserver]::Windows($owned.handle.Id)) {
          [NmgGuiObserver]::PostMessage($window.Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        }
      }
    } catch { Add-CleanupFailure 'stop-owned-close' $_ }
  }
  foreach ($owned in $members) {
    try {
      if ($owned.handlesReleased) { continue }
      $remaining = [Math]::Max(0, 3000 - [int]$timer.ElapsedMilliseconds)
      if (-not $owned.handle.WaitForExit($remaining)) {
        $owned.evidence.forcedTermination = $true
        $owned.handle.Kill()
        $remaining = [Math]::Max(0, 6000 - [int]$timer.ElapsedMilliseconds)
        Assert-Condition ($owned.handle.WaitForExit($remaining)) 'Owned process did not exit after bounded termination.'
      }
      Record-Exit $owned
    } catch { Add-CleanupFailure 'stop-owned-wait' $_ }
  }
}

function Assert-OwnedProcessesExited {
  foreach ($owned in $ownedProcesses.ToArray()) {
    if (-not $owned.handlesReleased) {
      Assert-Condition ($owned.handle.WaitForExit(0)) 'An owned process is still running; preserving installed artifacts.'
      Record-Exit $owned
    }
    Assert-Condition ($owned.evidence.waitCompleted) 'Owned process exit is not confirmed; preserving installed artifacts.'
  }
}

function Release-ExitedProcessHandles {
  Assert-OwnedProcessesExited
  foreach ($owned in $ownedProcesses.ToArray()) {
    if (-not $owned.handlesReleased) {
      # Query status before release. Close only these already-exited processes'
      # handles, so installer/uninstaller image resources do not impede cleanup.
      Record-Exit $owned
      $owned.handle.Dispose()
      if ($null -ne $owned.processHandle) { $owned.processHandle.Dispose() }
      $owned.handlesReleased = $true
    }
  }
}

function Remove-OwnedInstallDirectory {
  Assert-Condition ($outputDirectoryOwned -and $isolationEstablished -and
    $installDirectoryOwned -and -not [string]::IsNullOrWhiteSpace($ownedInstallDirectory)) `
    'Installation directory is not exclusively owned by this run.'
  Assert-OwnedProcessesExited
  Assert-NoForeignClient
  $safeOutput = (Get-SafePath $outputRoot).TrimEnd('\')
  $root = (Get-SafePath $ownedInstallDirectory).TrimEnd('\')
  $expectedRoot = (Get-SafePath (Join-Path $safeOutput 'installed')).TrimEnd('\')
  Assert-Condition ($root -ieq $expectedRoot -and $root -ieq (Get-SafePath $installDir).TrimEnd('\') -and
    $safeOutput.StartsWith($runnerTemp.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) `
    'Refusing cleanup outside the exact run-owned installation directory.'
  try { $rootAttributes = [IO.File]::GetAttributes($root) }
  catch [IO.FileNotFoundException] { return }
  catch [IO.DirectoryNotFoundException] { return }
  Assert-Condition (($rootAttributes -band [IO.FileAttributes]::Directory) -ne 0 -and
    ($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'Owned installation root is not an ordinary directory.'
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $pending = [Collections.Generic.Queue[string]]::new()
  $files = [Collections.Generic.List[string]]::new()
  $directories = [Collections.Generic.List[string]]::new()
  $inventory = [Collections.Generic.List[object]]::new()
  $pending.Enqueue($root)
  $directories.Add($root)
  # First inspect the complete bounded tree without following links. Reject any
  # reparse point before deleting any leftovers; no recursive Delete(true).
  while ($pending.Count -gt 0) {
    Assert-Condition ($timer.ElapsedMilliseconds -lt 25000 -and
      $files.Count + $directories.Count -le 2048) 'Owned installation cleanup inventory exceeded its bound.'
    $directory = Get-SafePath ($pending.Dequeue())
    foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
      $path = Get-SafePath $item.FullName
      Assert-Condition ($path.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) 'Cleanup entry escapes its exact owned root.'
      $attributes = [IO.File]::GetAttributes($path)
      Assert-Condition (($attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'Linked installation leftover is preserved; no target is traversed.'
      $isDirectory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
      $inventory.Add([ordered]@{ path = $path; kind = $(if ($isDirectory) { 'directory' } else { 'file' }) })
      if ($isDirectory) { $directories.Add($path); $pending.Enqueue($path) }
      else { $files.Add($path) }
    }
  }
  $report.cleanup['ownedInstallLeftovers'] = $inventory.ToArray()
  $deletePaths = [Collections.Generic.List[string]]::new()
  foreach ($file in $files) { $deletePaths.Add($file) }
  $directoryPaths = $directories.ToArray()
  [array]::Reverse($directoryPaths)
  foreach ($directory in $directoryPaths) { $deletePaths.Add($directory) }
  foreach ($path in $deletePaths) {
    while ($true) {
      Assert-Condition ($timer.ElapsedMilliseconds -lt 25000) 'Owned installation cleanup exceeded its 25-second bound.'
      Assert-OwnedProcessesExited
      Get-SafePath $safeOutput | Out-Null
      $safe = Get-SafePath $path
      Assert-Condition ($safe -ieq $root -or $safe.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) `
        'Cleanup deletion escapes its exact owned root.'
      try {
        $attributes = [IO.File]::GetAttributes($safe)
      } catch [IO.FileNotFoundException] { break }
      catch [IO.DirectoryNotFoundException] { break }
      Assert-Condition (($attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'Cleanup path became a link; preserving it.'
      try {
        if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { [IO.Directory]::Delete($safe, $false) }
        else { [IO.File]::Delete($safe) }
        break
      } catch [IO.IOException] {
        # Inno may briefly retain a deletion/image resource after exit. Retry
        # only this exact owned entry; never clear policy, attributes or locks.
        if ($timer.ElapsedMilliseconds -ge 25000) { throw }
        Start-Sleep -Milliseconds 150
      }
    }
  }
  $report.cleanup['ownedInstallDirectoryRemoved'] = $true
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

function Confirm-OwnedDialog($Case, $App, $Main, $Dialog, [string]$Stage) {
  $Case.guiPhase = $Stage + ':inspect-controls'
  $App.evidence['lastGuiPhase'] = $Case.guiPhase
  $snapshot = [NmgGuiObserver]::InspectOkDialog($Dialog.Handle, $App.evidence.pid, $Main.Handle)
  $event = [ordered]@{
    stage = $Stage; inspectedAt = [DateTime]::UtcNow.ToString('o')
    controls = $snapshot; message = 'BM_CLICK'; timeoutMs = 1500
    dispatch = $null; dialogDismissedObserved = $false
    windowsAfter = @(); catalogAfter = @(); failure = $null
  }
  $Case.controlEvents.Add($event)
  Write-Receipt
  try {
    $Case.guiPhase = $Stage + ':dispatch-click'
    $App.evidence['lastGuiPhase'] = $Case.guiPhase
    Write-Receipt
    $event.dispatch = [NmgGuiObserver]::ClickOk($snapshot)
    Write-Receipt
    Assert-Condition ($event.dispatch.Completed) `
      "Owned IDOK BM_CLICK dispatch failed: Win32 $($event.dispatch.Win32Error), result $($event.dispatch.MessageResult). See recorded controls; this is not proof the button is absent."
    $Case.guiPhase = $Stage + ':observe-dismissal'
    $App.evidence['lastGuiPhase'] = $Case.guiPhase
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($timer.ElapsedMilliseconds -lt 3000) {
      [NmgGuiObserver]::CheckDesktop()
      if ($App.handle.HasExited) {
        Record-Exit $App
        throw "App exited during $Stage confirmation: real exit code $($App.evidence.exitCode), status $($App.evidence.exitCodeStatus)."
      }
      if (-not [NmgGuiObserver]::DialogExistsForProcess($Dialog.Handle, $App.evidence.pid)) {
        $event.dialogDismissedObserved = $true
        $event['dismissalObservedAt'] = [DateTime]::UtcNow.ToString('o')
        $event.windowsAfter = @([NmgGuiObserver]::Windows($App.evidence.pid))
        $event.catalogAfter = Get-CatalogSnapshot
        $Case.guiPhase = $Stage + ':dismissal-observed'
        $App.evidence['lastGuiPhase'] = $Case.guiPhase
        Write-Receipt
        return
      }
      Start-Sleep -Milliseconds 100
    }
    throw "Owned $Stage dialog did not disappear within the bounded post-click observation."
  } catch {
    $event.failure = $_.Exception.Message
    $event['failurePhase'] = $Case.guiPhase
    try {
      Record-Exit $App
      if (-not $App.handle.HasExited) { $event.windowsAfter = @([NmgGuiObserver]::Windows($App.evidence.pid)) }
      $event.catalogAfter = Get-CatalogSnapshot
    } catch { $event['diagnosticObservationError'] = $_.Exception.Message }
    Write-Receipt
    throw
  }
}
function Wait-OwnedGuiWindow($App, [string]$ClassName, [IntPtr]$Owner = [IntPtr]::Zero) {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  while ($timer.ElapsedMilliseconds -lt 5000) {
    [NmgGuiObserver]::CheckDesktop()
    Assert-Condition (-not $App.handle.HasExited) "App exited while awaiting $ClassName."
    $windows = @([NmgGuiObserver]::Windows($App.evidence.pid))
    Assert-Condition (@($windows | Where-Object { $_.ClassName -eq '#32770' }).Count -eq 0) `
      'Unexpected native dialog during switching/restart.'
    $matches = @($windows | Where-Object { $_.ClassName -ceq $ClassName })
    Assert-Condition ($matches.Count -le 1) "Ambiguous owned $ClassName windows."
    if ($matches.Count -eq 1 -and [NmgGuiObserver]::Observable($matches[0].Handle)) {
      if ($Owner -ne [IntPtr]::Zero) { Assert-Condition ($matches[0].Owner -eq $Owner) 'GUI owner identity changed.' }
      return $matches[0]
    }
    Start-Sleep -Milliseconds 100
  }
  throw "No observable owned $ClassName within five seconds."
}

function Open-OwnedMenuItem($Case, $App, $Main, [string]$Caption, [string]$Stage) {
  $Case.guiPhase = $Stage + ':open-context-menu'
  $App.evidence['lastGuiPhase'] = $Case.guiPhase
  Assert-Condition ([NmgGuiObserver]::Observable($Main.Handle) -and
    [NmgGuiObserver]::PostMessage($Main.Handle, 0x007B, $Main.Handle, [IntPtr](-1))) `
    'Could not request ordinary owned context menu.'
  $menu = Wait-OwnedGuiWindow $App '#32768'
  Capture-Observation $Case $Main $menu ($Stage + '-menu')
  $target = [NmgGuiObserver]::InspectMenuItem($menu.Handle, $App.evidence.pid, $Caption)
  $event = [ordered]@{ stage = $Stage; nativeMenuItem = $target; dispatch = $null
    policy = 'Observed native caption/rectangle; owned mouse messages, no private WM_COMMAND' }
  $Case.controlEvents.Add($event)
  Write-Receipt
  $event.dispatch = [NmgGuiObserver]::ClickNativePoint($target)
  Assert-Condition $event.dispatch 'Owned native menu click failed.'
  Write-Receipt
}

function Invoke-AppearanceSwitchChecks($Case, $App, $Main, $InputCase) {
  $installedIds = @($inputs.ToArray() | ForEach-Object { $_.packs } |
    Where-Object { [IO.File]::Exists((Join-Path $catalogDir ($_.id + '.nmgpack'))) } |
    ForEach-Object { $_.id } | Sort-Object -Unique)
  Assert-Condition ($installedIds.Count -ge 1 -and $installedIds.Count -le 2) 'Unexpected picker catalog cardinality.'
  $targets = [Collections.Generic.List[object]]::new()
  $targets.Add([pscustomobject]@{ id = ''; index = 0; label = 'builtin' })
  foreach ($pack in $InputCase.packs) {
    $index = [array]::IndexOf([string[]]$installedIds, [string]$pack.id)
    Assert-Condition ($index -ge 0) 'Imported original absent from picker catalog.'
    $targets.Add([pscustomobject]@{ id = $pack.id; index = $index + 1; label = 'pack-' + ($index + 1) })
  }
  foreach ($target in $targets) {
    $stage = 'switch-' + $target.label
    Open-OwnedMenuItem $Case $App $Main 'Change Appearance' $stage
    $picker = Wait-OwnedGuiWindow $App 'NiuMaMeritAppearancePicker' $Main.Handle
    Capture-Observation $Case $Main $picker ($stage + '-picker')
    $card = [NmgGuiObserver]::InspectPickerCard($picker.Handle, $App.evidence.pid, $Main.Handle, $target.index)
    $switch = [ordered]@{ expectedPackId = $target.id; card = $card; actualPackId = $null
      cardDispatch = $null; confirmControl = $null; confirmDispatch = $null; selected = $false
      geometrySource = 'Prior bounded layout hypothesis; accepted only after requested ID actually persists' }
    $Case.switches.Add($switch)
    Write-Receipt
    $switch.cardDispatch = [NmgGuiObserver]::ClickNativePoint($card)
    Assert-Condition $switch.cardDispatch 'Owned picker card click failed.'
    Start-Sleep -Milliseconds 150
    Capture-Observation $Case $Main $picker ($stage + '-pending')
    $switch.confirmControl = [NmgGuiObserver]::InspectPickerConfirm($picker.Handle, $App.evidence.pid, $Main.Handle)
    Write-Receipt
    $switch.confirmDispatch = [NmgGuiObserver]::ClickPickerConfirm($switch.confirmControl, $picker.Handle, $App.evidence.pid, $Main.Handle)
    Assert-Condition $switch.confirmDispatch.Completed 'Picker Confirm BM_CLICK did not complete.'
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($timer.ElapsedMilliseconds -lt 3000) {
      Assert-Condition (-not $App.handle.HasExited) 'App exited during selection.'
      $switch.actualPackId = [NmgGuiObserver]::SelectedPack((Join-Path $dataRoot 'data.ini'))
      if (-not [NmgGuiObserver]::DialogExistsForProcess($picker.Handle, $App.evidence.pid) -and
          $switch.actualPackId -ceq $target.id) { $switch.selected = $true; break }
      Start-Sleep -Milliseconds 100
    }
    Assert-Condition $switch.selected 'Native picker did not persist requested appearance.'
    Start-Sleep -Milliseconds 1000
    $Main = Wait-OwnedGuiWindow $App 'NiuMaMeritWindow'
    Capture-Observation $Case $Main $null ($stage + '-rendered')
  }
  $Case.switchingObserved = $true
}

function Invoke-RestartSelectionCheck($Case) {
  $expected = $Case.switches[$Case.switches.Count - 1].expectedPackId
  Assert-NoForeignClient
  $beforeRestart = Get-CatalogSnapshot
  $restart = Start-OwnedProcess $clientPath '' ('app-' + $Case.name + '-restart')
  $Case.restartProcess = $restart.evidence
  $Case.guiPhase = 'restart-without-import-argument'
  $restart.evidence['lastGuiPhase'] = $Case.guiPhase
  Write-Receipt
  $main = Wait-OwnedGuiWindow $restart 'NiuMaMeritWindow'
  Start-Sleep -Milliseconds 1000
  $main = Wait-OwnedGuiWindow $restart 'NiuMaMeritWindow'
  $Case.restartSelectedPackId = [NmgGuiObserver]::SelectedPack((Join-Path $dataRoot 'data.ini'))
  Assert-Condition ($Case.restartSelectedPackId -ceq $expected -and
    [NmgGuiObserver]::PrivacyShown((Join-Path $dataRoot 'data.ini')) -ceq '1') `
    'Restart did not preserve GUI selection/privacy flag.'
  Capture-Observation $Case $main $null 'restart-rendered' ([int]$restart.evidence.pid)
  Assert-Condition ([NmgGuiObserver]::PostMessage($main.Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) `
    'Could not request owned restart closure.'
  Wait-OwnedProcess $restart 10000
  Assert-Condition (-not $restart.evidence.forcedTermination) 'Forced restart termination is not acceptance.'
  Assert-CatalogEquals $beforeRestart (Get-CatalogSnapshot)
  $Case.restartSelectionObserved = $true
  Write-Receipt
}
function Invoke-GuiCase($InputCase) {
  Assert-LiveLicenseWindow
  Assert-NoForeignClient
  $case = [ordered]@{
    name = $InputCase.name; result = 'FAIL'; input = $InputCase.evidence
    entry = 'Installed normal app, native file argument'
    actualGuiObserved = $false; normalGuiImportObserved = $false
    successDialogObserved = $false; dialogImportedCount = $null
    actualImportedCount = 0; countEvidence = $null; selectedPackId = $null
    privacyConfirmationObserved = $false; privacyShownAfter = $null
    switchingObserved = $false; switches = [Collections.Generic.List[object]]::new()
    restartProcess = $null; restartSelectedPackId = $null; restartSelectionObserved = $false
    catalogBefore = Get-CatalogSnapshot; catalogAfter = @()
    observations = [Collections.Generic.List[object]]::new()
    controlEvents = [Collections.Generic.List[object]]::new()
    guiPhase = 'launch'; failurePhase = $null; appProcess = $null; failure = $null
    exitDiagnosticScope = 'Real app exit status is retained, including access violations; fault origin is not attributed to client, automation or cleanup without evidence'
  }
  $report.cases.Add($case)
  Write-Receipt
  $app = $null
  try {
    # No existing instance is allowed: a launcher forwarding to somebody else's
    # window must never be confused with the installed app under test.
    $app = Start-OwnedProcess $clientPath ('"' + $InputCase.binding.path + '"') ('app-' + $InputCase.name)
    # Keep the same live evidence object so a later cleanup-time AV remains in
    # this case's final receipt, rather than disappearing behind the click error.
    $case.appProcess = $app.evidence
    $case.guiPhase = 'await-import-or-privacy-dialog'
    $app.evidence['lastGuiPhase'] = $case.guiPhase
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
        Confirm-OwnedDialog $case $app $main[0] $dialog 'privacy-confirmation'
        $case.privacyConfirmationObserved = $true
        $case.guiPhase = 'await-import-success-dialog'
        $app.evidence['lastGuiPhase'] = $case.guiPhase
        continue
      }
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
      Capture-Observation $case $main[0] $dialog 'import-dialog'
      $case.successDialogObserved = $true
      $case.catalogAfter = Get-CatalogSnapshot
    Assert-Condition ($case.catalogAfter.Count -eq $InputCase.evidence.expectedCatalogCount) 'PAID_CATALOG_CARDINALITY'
    if ($InputCase.name -ceq 'reimport') { Assert-CatalogEquals $case.catalogBefore $case.catalogAfter }
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
      Confirm-OwnedDialog $case $app $main[0] $dialog 'import-success-confirmation'
      $success = $true
      break
    }
    Assert-Condition $success 'No observable production success dialog within the 25-second GUI stage.'
    # The app installs its ordinary input hooks after dismissing import success.
    # Observe a stable normal window rather than closing before startup can fail.
    $settle = [Diagnostics.Stopwatch]::StartNew()
    $case.guiPhase = 'observe-normal-app-after-import'
    $app.evidence['lastGuiPhase'] = $case.guiPhase
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
    $case.privacyShownAfter = [NmgGuiObserver]::PrivacyShown((Join-Path $dataRoot 'data.ini'))
    Assert-Condition ($case.privacyShownAfter -ceq '1') 'Confirmed startup did not persist privacy_shown.'
    if ($InputCase.name -ceq 'licensed') {
      Assert-Condition $case.privacyConfirmationObserved 'Fresh startup must actually confirm Privacy.'
    }
    Capture-Observation $case $main[0] $null 'normal-app'
    Invoke-AppearanceSwitchChecks $case $app $main[0] $InputCase
    $case.guiPhase = 'request-normal-app-close'
    $app.evidence['lastGuiPhase'] = $case.guiPhase
    if ($InputCase.name -ceq 'mixed') {
      Open-OwnedMenuItem $case $app $main[0] 'Exit' 'normal-menu-exit'
    } else {
      Assert-Condition ([NmgGuiObserver]::PostMessage($main[0].Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) `
        'Could not request normal closure of the owned app window.'
    }
    Wait-OwnedProcess $app 10000
    Assert-Condition (-not $app.evidence.forcedTermination) 'Forced termination is not successful GUI acceptance.'
    Invoke-RestartSelectionCheck $case
    $case.actualGuiObserved = $true
    $case.normalGuiImportObserved = $true
    Assert-CatalogEquals $case.catalogAfter (Get-CatalogSnapshot)
    $case.result = 'PASS'
    $case.guiPhase = 'normal-app-exited-zero'
    $app.evidence['lastGuiPhase'] = $case.guiPhase
    $report.normalGuiImportObserved = $true
    Write-Receipt
  } catch {
    $case.failure = $_.Exception.Message
    $case.failurePhase = $case.guiPhase
    if ($null -ne $app) {
      $app.evidence['guiFailurePhase'] = $case.failurePhase
      try { Record-Exit $app } catch { $case['exitDiagnosticError'] = $_.Exception.Message }
    }
    Write-Receipt
    throw
  }
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
  $runnerTemp=(Get-SafePath $env:RUNNER_TEMP).TrimEnd('\')
  $inputRoot=Get-SafePath $InputDirectory;$outputRoot=Get-SafePath $OutputDirectory
  Assert-Condition ($inputRoot.StartsWith($runnerTemp+'\',[StringComparison]::OrdinalIgnoreCase) -and
    $outputRoot.StartsWith($runnerTemp+'\',[StringComparison]::OrdinalIgnoreCase) -and $inputRoot -ine $outputRoot -and
    -not $inputRoot.StartsWith($outputRoot+'\',[StringComparison]::OrdinalIgnoreCase)) 'PAID_PATH_SCOPE'
  Assert-Condition (-not (Test-Path -LiteralPath $outputRoot) -and
    [IO.Directory]::Exists([IO.Path]::GetDirectoryName($outputRoot))) 'PAID_OUTPUT_NO_CLOBBER'
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NmgExclusiveOutputDirectory {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CreateDirectory(string path, IntPtr attributes);
}
'@
  Assert-Condition ([NmgExclusiveOutputDirectory]::CreateDirectory($outputRoot,[IntPtr]::Zero)) 'PAID_OUTPUT_NOT_EXCLUSIVELY_CREATED'
  $outputDirectoryOwned=$true;Write-Receipt;Assert-LiveLicenseWindow
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.Drawing
  $files=@(Get-ChildItem -LiteralPath $inputRoot -Force)
  Assert-Condition ($files.Count -eq 3 -and @($files | Where-Object {$_ -isnot [IO.FileInfo]}).Count -eq 0) 'PAID_INPUT_FILE_SET'
  foreach ($pin in $pins) {
    $binding=Open-BoundFile (Join-Path $inputRoot $pin.file) $pin.sha $pin.bytes
    $inputs.Add([pscustomobject]@{name=$pin.name;binding=$binding;packs=@()
      evidence=[ordered]@{file=$pin.file;bytes=$pin.bytes;sha256=$pin.sha;expectedImportedCount=0;expectedCatalogCount=0}})
  }
  $licensed=@($inputs.ToArray() | Where-Object {$_.name -ceq 'licensed'})[0]
  $bad=@($inputs.ToArray() | Where-Object {$_.name -ceq 'invalid-signature'})[0]
  $mixed=@($inputs.ToArray() | Where-Object {$_.name -ceq 'mixed'})[0]
  $licensed.packs=@(Inspect-PaidPack (Read-BoundBytes $licensed.binding) $true)
  $bad.packs=@(Inspect-PaidPack (Read-BoundBytes $bad.binding) $true)
  $licensed.evidence.expectedImportedCount=1;$licensed.evidence.expectedCatalogCount=1
  $batch=Open-ReadOnlyZip (Read-BoundBytes $mixed.binding)
  try {
    Assert-Condition ($batch.Entries.Count -eq 2 -and $null -ne $batch.GetEntry('paid-schema3.nmgpack') -and
      $null -ne $batch.GetEntry('synthetic-control-schema1.nmgpack')) 'PAID_MIXED_ENTRY_SET'
    $paidBytes=Read-ZipBytes ($batch.GetEntry('paid-schema3.nmgpack')) 1646
    $controlBytes=Read-ZipBytes ($batch.GetEntry('synthetic-control-schema1.nmgpack')) 736
    Assert-Condition ($paidBytes.Length -eq 1646 -and (Get-Sha $paidBytes) -ceq $pins[0].sha -and
      $controlBytes.Length -eq 736 -and (Get-Sha $controlBytes) -ceq $controlSha) 'PAID_MIXED_INNER_BYTES'
    $mixed.packs=@((Inspect-PaidPack $paidBytes $true),(Inspect-PaidPack $controlBytes $false))
    Assert-Condition ($mixed.packs[0].id -cne $mixed.packs[1].id) 'PAID_MIXED_DISTINCT_ID'
  } finally {$batch.Dispose()}
  $mixed.evidence.expectedImportedCount=2;$mixed.evidence.expectedCatalogCount=2
  $installerBinding=Open-BoundFile $InstallerPath $installerSha $installerBytes
  $report.installer=Get-PeEvidence $installerBinding 'installer'
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
  if ($PSVersionTable.PSEdition -eq 'Core') {
    # .NET 10 exposes Bitmap/Image contracts through private Windows framework
    # assemblies (including GdiPlus and Core). Walk the actual implementation's
    # declared dependency graph so another member of that family is not omitted.
    # Never enumerate arbitrary implementation DLLs or replace standard ref-pack
    # BCL assemblies with System.Private.CoreLib/runtime implementation copies.
    $drawingPath = Get-SafePath $drawingAssembly.Location
    $drawingFrameworkDirectory = [IO.Path]::GetDirectoryName($drawingPath)
    $pwshFrameworkDirectory = (Get-SafePath $PSHOME).TrimEnd('\')
    $bundledDrawingFramework = $drawingFrameworkDirectory.TrimEnd('\') -ieq $pwshFrameworkDirectory
    $trustedPlatformPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $platformAssemblyPaths = [string][AppContext]::GetData('TRUSTED_PLATFORM_ASSEMBLIES')
    foreach ($platformPath in @($platformAssemblyPaths.Split([IO.Path]::PathSeparator))) {
      if (-not [string]::IsNullOrWhiteSpace($platformPath)) {
        $trustedPlatformPaths.Add([IO.Path]::GetFullPath($platformPath)) | Out-Null
      }
    }
    Assert-Condition ($bundledDrawingFramework -or $trustedPlatformPaths.Contains($drawingPath)) `
      'Bitmap implementation is not in the installed pwsh framework or declared trusted platform set.'
    $drawingDependencies = [Collections.Generic.Queue[Reflection.Assembly]]::new()
    $drawingDependencies.Enqueue($drawingAssembly)
    $visitedDrawingAssemblies = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $drawingDependencyIdentities = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    $drawingDependencyTimer = [Diagnostics.Stopwatch]::StartNew()
    while ($drawingDependencies.Count -gt 0) {
      Assert-Condition ($drawingDependencyTimer.ElapsedMilliseconds -lt 25000 -and
        $visitedDrawingAssemblies.Count -lt 64) 'Drawing dependency resolution exceeded its bounded framework closure.'
      $parentAssembly = $drawingDependencies.Dequeue()
      if (-not $visitedDrawingAssemblies.Add($parentAssembly.FullName)) { continue }
      foreach ($dependency in $parentAssembly.GetReferencedAssemblies()) {
        $privateWindowsFamily = $dependency.Name -cmatch '\ASystem\.Private\.Windows\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*\z'
        # Keep already supplied standard references. CoreLib is represented by
        # the installed reference pack, not an extra implementation reference.
        if ($dependency.Name -ceq 'System.Private.CoreLib' -or
            ($guiReferencePaths.ContainsKey($dependency.Name) -and -not $privateWindowsFamily)) { continue }
        $allowedDrawingDependency = $privateWindowsFamily -or $dependency.Name -cin @(
          'System.Drawing.Common', 'System.Drawing', 'System.Drawing.Primitives',
          'System.Windows.Extensions', 'Microsoft.Win32.SystemEvents', 'System.Formats.Nrbf')
        Assert-Condition $allowedDrawingDependency `
          "Drawing dependency is outside the supplied ref pack and approved Windows/Drawing family: $($dependency.FullName)"
        if ($drawingDependencyIdentities.ContainsKey($dependency.Name)) {
          Assert-Condition ($drawingDependencyIdentities[$dependency.Name] -ieq $dependency.FullName) `
            "Conflicting Drawing framework dependency identity: $($dependency.Name)"
          continue
        }
        # Resolve only the exact sibling of the actual trusted Bitmap assembly.
        # There is no working-directory, SDK-directory or external-path fallback.
        $dependencyPath = Get-SafePath (Join-Path $drawingFrameworkDirectory ($dependency.Name + '.dll'))
        Assert-Condition ([IO.File]::Exists($dependencyPath) -and
          ($bundledDrawingFramework -or $trustedPlatformPaths.Contains($dependencyPath))) `
          "Required Drawing dependency is missing from its trusted framework location: $($dependency.FullName)"
        $fileIdentity = [Reflection.AssemblyName]::GetAssemblyName($dependencyPath)
        Assert-Condition ($fileIdentity.FullName -ieq $dependency.FullName) `
          "Drawing dependency version/culture/public-key identity mismatch: $($dependency.Name)"
        $dependencyAssembly = [Reflection.Assembly]::LoadFrom($dependencyPath)
        Assert-Condition ($dependencyAssembly.FullName -ieq $dependency.FullName -and
          (Get-SafePath $dependencyAssembly.Location) -ieq $dependencyPath) `
          "Drawing dependency resolved outside its exact trusted framework image: $($dependency.Name)"
        $drawingDependencyIdentities[$dependency.Name] = $dependency.FullName
        $guiReferencePaths[$dependency.Name] = $dependencyPath
        $drawingDependencies.Enqueue($dependencyAssembly)
      }
    }
  }
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
public sealed class NmgControlInspection {
  public IntPtr Handle { get; set; }
  public IntPtr Parent { get; set; }
  public IntPtr Root { get; set; }
  public uint ProcessId { get; set; }
  public int ControlId { get; set; }
  public string ClassName { get; set; }
  public string Text { get; set; }
  public string TextError { get; set; }
  public bool Exists { get; set; }
  public bool Visible { get; set; }
  public bool Enabled { get; set; }
  public bool RectangleObserved { get; set; }
  public int Left { get; set; }
  public int Top { get; set; }
  public int Right { get; set; }
  public int Bottom { get; set; }
}
public sealed class NmgDialogInspection {
  public IntPtr Dialog { get; set; }
  public IntPtr Owner { get; set; }
  public IntPtr ExpectedOwner { get; set; }
  public uint ProcessId { get; set; }
  public int ExpectedProcessId { get; set; }
  public bool Exists { get; set; }
  public bool Visible { get; set; }
  public bool Enabled { get; set; }
  public string ClassName { get; set; }
  public string Title { get; set; }
  public IntPtr DirectIdOkHandle { get; set; }
  public string Resolution { get; set; }
  public string InspectionError { get; set; }
  public bool ControlsTruncated { get; set; }
  public NmgControlInspection[] Controls { get; set; }
  public NmgControlInspection Button { get; set; }
}
public sealed class NmgButtonDispatch {
  public bool Completed { get; set; }
  public int Win32Error { get; set; }
  public long MessageResult { get; set; }
  public uint TimeoutMs { get; set; }
  public IntPtr Button { get; set; }
  public IntPtr ForegroundBefore { get; set; }
  public IntPtr ForegroundAfter { get; set; }
  public bool ForegroundRequestSucceeded { get; set; }
}
public sealed class NmgNativePoint {
  public IntPtr Window { get; set; }
  public IntPtr Owner { get; set; }
  public int ProcessId { get; set; }
  public string ClassName { get; set; }
  public string Caption { get; set; }
  public int Index { get; set; }
  public uint Dpi { get; set; }
  public int ClientX { get; set; }
  public int ClientY { get; set; }
  public int ScreenX { get; set; }
  public int ScreenY { get; set; }
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
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", ExactSpelling=true, SetLastError=true)] private static extern IntPtr SendButtonMessageTimeout(IntPtr window, uint message, IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr window);
  [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr window);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll", EntryPoint="GetDlgItem", ExactSpelling=true)] private static extern IntPtr GetDlgItem(IntPtr dialog, int id);
  [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetExitCodeProcess(Microsoft.Win32.SafeHandles.SafeProcessHandle process, out uint exitCode);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint bytes, out uint needed);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] private static extern uint GetPrivateProfileString(string section, string key, string fallback, StringBuilder value, uint size, string path);
  [StructLayout(LayoutKind.Sequential)] private struct MenuBarInfo {
    public uint Size; public Rect Bar; public IntPtr Menu,MenuWindow; public uint FocusFlags;
  }
  [DllImport("user32.dll")] private static extern bool GetMenuBarInfo(IntPtr window,int objectId,int item,ref MenuBarInfo info);
  [DllImport("user32.dll")] private static extern int GetMenuItemCount(IntPtr menu);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetMenuString(IntPtr menu,uint item,StringBuilder text,int size,uint flags);
  [DllImport("user32.dll")] private static extern bool GetMenuItemRect(IntPtr window,IntPtr menu,uint item,out Rect rect);
  [DllImport("user32.dll")] private static extern bool ScreenToClient(IntPtr window,ref Point point);
  [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr window,ref Point point);
  [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr window,out Rect rect);
  [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr window);
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
  private static uint WindowProcessId(IntPtr window) {
    uint pid; GetWindowThreadProcessId(window,out pid); return pid;
  }
  private static NmgControlInspection ReadControl(IntPtr window) {
    Rect rect;
    bool rectangle=GetWindowRect(window,out rect);
    var item=new NmgControlInspection {Handle=window,Parent=GetParent(window),Root=GetAncestor(window,2),
      ProcessId=WindowProcessId(window),ControlId=GetDlgCtrlID(window),ClassName=Class(window),
      Exists=IsWindow(window),Visible=IsWindowVisible(window),Enabled=IsWindowEnabled(window),
      RectangleObserved=rectangle,Left=rect.L,Top=rect.T,Right=rect.R,Bottom=rect.B};
    try { item.Text=ControlText(window); } catch(Exception ex) { item.TextError=ex.Message; }
    return item;
  }
  private static bool IsStandardIdOk(NmgControlInspection item,IntPtr dialog,int processId) {
    return item!=null && item.Exists && item.ControlId==1 && item.Parent==dialog && item.Root==dialog &&
      item.ProcessId==(uint)processId && String.Equals(item.ClassName,"Button",StringComparison.OrdinalIgnoreCase);
  }
  private static bool IsOwnedVisibleOkCaption(NmgControlInspection item,IntPtr dialog,int processId) {
    return item!=null && item.Exists && item.Visible && item.Enabled && item.TextError==null &&
      item.Parent==dialog && item.Root==dialog && item.ProcessId==(uint)processId &&
      String.Equals(item.ClassName,"Button",StringComparison.OrdinalIgnoreCase) &&
      String.Equals((item.Text??String.Empty).Replace("&",String.Empty).Trim(),"OK",StringComparison.OrdinalIgnoreCase);
  }
  public static NmgDialogInspection InspectOkDialog(IntPtr dialog,int processId,IntPtr expectedOwner) {
    var title=new StringBuilder(1024); GetWindowText(dialog,title,title.Capacity);
    var snapshot=new NmgDialogInspection {Dialog=dialog,Owner=GetWindow(dialog,4),ExpectedOwner=expectedOwner,
      ProcessId=WindowProcessId(dialog),ExpectedProcessId=processId,Exists=IsWindow(dialog),
      Visible=IsWindowVisible(dialog),Enabled=IsWindowEnabled(dialog),ClassName=Class(dialog),Title=title.ToString(),
      Controls=new NmgControlInspection[0],Resolution="unresolved"};
    if(!snapshot.Exists || snapshot.ProcessId!=(uint)processId || snapshot.Owner!=expectedOwner ||
       !IsWindow(expectedOwner) || WindowProcessId(expectedOwner)!=(uint)processId ||
       Class(expectedOwner)!="NiuMaMeritWindow" || snapshot.ClassName!="#32770") {
      snapshot.InspectionError="Dialog/owner identity is not the tracked normal app.";
      return snapshot;
    }
    snapshot.DirectIdOkHandle=GetDlgItem(dialog,1);
    var controls=new List<NmgControlInspection>();
    EnumChildWindows(dialog,delegate(IntPtr child,IntPtr unused) {
      if(controls.Count>=64) { snapshot.ControlsTruncated=true; return false; }
      controls.Add(ReadControl(child)); return true;
    },IntPtr.Zero);
    snapshot.Controls=controls.ToArray();
    if(snapshot.DirectIdOkHandle!=IntPtr.Zero) {
      var direct=ReadControl(snapshot.DirectIdOkHandle);
      if(IsStandardIdOk(direct,dialog,processId)) {
        snapshot.Button=direct; snapshot.Resolution="GetDlgItem(IDOK)";
      }
    }
    if(snapshot.Button==null) {
      foreach(var item in controls) if(IsStandardIdOk(item,dialog,processId)) {
        if(snapshot.Button!=null) {
          snapshot.Button=null; snapshot.InspectionError="Ambiguous enumerated standard IDOK controls."; return snapshot;
        }
        snapshot.Button=item; snapshot.Resolution="EnumChildWindows/GetDlgCtrlID(IDOK)";
      }
    }
    if(snapshot.Button==null) {
      // The observed single-button Privacy message box uses control ID 2
      // while its actual caption is OK. Resolve that observed control, not
      // an assumed ID, and retain the original ID in the receipt.
      NmgControlInspection captionButton=null;
      foreach(var item in controls) if(IsOwnedVisibleOkCaption(item,dialog,processId)) {
        if(captionButton!=null) {
          snapshot.InspectionError="Ambiguous owned visible OK-caption controls."; return snapshot;
        }
        captionButton=item;
      }
      if(captionButton!=null) {
        snapshot.Button=captionButton; snapshot.Resolution="Owned unique visible OK-caption button";
      }
    }
    if(snapshot.Button==null) snapshot.InspectionError="Neither standard IDOK nor a unique owned visible OK-caption control was observed; inspect recorded controls.";
    return snapshot;
  }
  private static bool ButtonObservable(NmgControlInspection button,IntPtr dialog) {
    if(!button.RectangleObserved || button.Right<=button.Left || button.Bottom<=button.Top) return false;
    // These coordinates come only from the actual control rectangle and are
    // used for read-only visibility hit-testing, never coordinate input.
    for(int y=1;y<=3;y++) for(int x=1;x<=3;x++) {
      var point=new Point {X=button.Left+(button.Right-button.Left)*x/4,Y=button.Top+(button.Bottom-button.Top)*y/4};
      var hit=WindowFromPoint(point);
      if((hit==button.Handle || IsChild(button.Handle,hit)) && GetAncestor(hit,2)==dialog) return true;
    }
    return false;
  }
  public static NmgButtonDispatch ClickOk(NmgDialogInspection snapshot) {
    CheckDesktop();
    if(snapshot==null || snapshot.InspectionError!=null || snapshot.ControlsTruncated)
      throw new InvalidOperationException("IDOK control inspection failed: "+(snapshot==null?"no snapshot":snapshot.InspectionError));
    IntPtr dialog=snapshot.Dialog;
    if(!DialogExistsForProcess(dialog,snapshot.ExpectedProcessId) || Class(dialog)!="#32770" ||
       GetWindow(dialog,4)!=snapshot.ExpectedOwner || !IsWindow(snapshot.ExpectedOwner) ||
       WindowProcessId(snapshot.ExpectedOwner)!=(uint)snapshot.ExpectedProcessId ||
       Class(snapshot.ExpectedOwner)!="NiuMaMeritWindow")
      throw new InvalidOperationException("Target dialog/owner identity changed before IDOK dispatch.");
    if(snapshot.Button==null) throw new InvalidOperationException("No verified owned OK control; see recorded enumeration.");
    var button=ReadControl(snapshot.Button.Handle);
    bool standardResolution=IsStandardIdOk(button,dialog,snapshot.ExpectedProcessId);
    bool captionResolution=String.Equals(snapshot.Resolution,"Owned unique visible OK-caption button",StringComparison.Ordinal) &&
      IsOwnedVisibleOkCaption(button,dialog,snapshot.ExpectedProcessId);
    if((!standardResolution && !captionResolution) || button.ControlId!=snapshot.Button.ControlId ||
       !String.Equals(button.Text,snapshot.Button.Text,StringComparison.Ordinal))
      throw new InvalidOperationException("Observed OK control ID/caption/class/parent/process identity changed before dispatch.");
    if(!IsWindowVisible(dialog) || !IsWindowEnabled(dialog) || !button.Visible || !button.Enabled)
      throw new InvalidOperationException("Verified IDOK control or target dialog is hidden/disabled; not a missing-button assertion.");
    if(!Observable(dialog) || !ButtonObservable(button,dialog))
      throw new InvalidOperationException("Verified IDOK control is not observable on the actual input desktop.");
    var dispatch=new NmgButtonDispatch {Button=button.Handle,TimeoutMs=1500,ForegroundBefore=GetForegroundWindow()};
    // Only the verified owned dialog may be foregrounded. No global keys,
    // coordinates, WM_COMMAND shortcut, message filter or trust-policy change.
    dispatch.ForegroundRequestSucceeded=SetForegroundWindow(dialog);
    dispatch.ForegroundAfter=GetForegroundWindow();
    IntPtr result;
    // BM_CLICK's LRESULT is normally zero. The API return, not that LRESULT,
    // says whether dispatch completed. Do not use SMTO_ERRORONEXIT: destroying
    // the clicked button/dialog is the expected action, not a dispatch failure.
    var completed=SendButtonMessageTimeout(button.Handle,0x00F5,IntPtr.Zero,IntPtr.Zero,2,1500,out result);
    dispatch.Win32Error=completed==IntPtr.Zero?Marshal.GetLastWin32Error():0;
    dispatch.Completed=completed!=IntPtr.Zero;
    dispatch.MessageResult=result.ToInt64();
    return dispatch;
  }
  public static bool DialogExistsForProcess(IntPtr dialog,int processId) {
    return IsWindow(dialog) && WindowProcessId(dialog)==(uint)processId;
  }
  public static string SelectedPack(string path) {
    var value=new StringBuilder(128); GetPrivateProfileString("state","selected_pack_id","",value,128,path); return value.ToString();
  }
  public static string PrivacyShown(string path) {
    var value=new StringBuilder(16); GetPrivateProfileString("state","privacy_shown","0",value,16,path); return value.ToString();
  }
  private static void RequireOwnedVisible(IntPtr window,int processId,string className) {
    CheckDesktop();
    if(!IsWindow(window)||WindowProcessId(window)!=(uint)processId||Class(window)!=className||
       !IsWindowVisible(window)||!IsWindowEnabled(window)||!Observable(window))
      throw new InvalidOperationException("Native UI target is not the owned observable "+className+".");
  }
  public static NmgNativePoint InspectMenuItem(IntPtr window,int processId,string caption) {
    RequireOwnedVisible(window,processId,"#32768");
    var info=new MenuBarInfo {Size=(uint)Marshal.SizeOf(typeof(MenuBarInfo))};
    if(!GetMenuBarInfo(window,-4,0,ref info)||info.Menu==IntPtr.Zero)
      throw new InvalidOperationException("Native popup menu handle unobservable; no private command fallback.");
    int count=GetMenuItemCount(info.Menu), found=-1;
    if(count<1||count>16) throw new InvalidOperationException("Unexpected native menu item count.");
    for(int i=0;i<count;i++) {
      var text=new StringBuilder(256); GetMenuString(info.Menu,(uint)i,text,text.Capacity,0x400);
      string actual=text.ToString().Replace("&",String.Empty).Trim();
      string chinese=caption=="Exit"?"\u9000\u51fa":"\u66f4\u6362\u5f62\u8c61";
      if(actual==caption||actual==chinese) {
        if(found>=0) throw new InvalidOperationException("Ambiguous native menu caption.");
        found=i;
      }
    }
    Rect rect;
    if(found<0||!GetMenuItemRect(IntPtr.Zero,info.Menu,(uint)found,out rect)||rect.R<=rect.L||rect.B<=rect.T)
      throw new InvalidOperationException("Native menu item/rectangle not observed.");
    var screen=new Point {X=rect.L+(rect.R-rect.L)/2,Y=rect.T+(rect.B-rect.T)/2};
    var client=screen;
    if(!ScreenToClient(window,ref client)||GetAncestor(WindowFromPoint(screen),2)!=window)
      throw new InvalidOperationException("Native menu item occluded.");
    return new NmgNativePoint {Window=window,ProcessId=processId,ClassName="#32768",Caption=caption,Index=found,
      ClientX=client.X,ClientY=client.Y,ScreenX=screen.X,ScreenY=screen.Y};
  }
  public static NmgNativePoint InspectPickerCard(IntPtr window,int processId,IntPtr owner,int index) {
    RequireOwnedVisible(window,processId,"NiuMaMeritAppearancePicker");
    if(!IsWindow(owner)||WindowProcessId(owner)!=(uint)processId||Class(owner)!="NiuMaMeritWindow"||
       GetWindow(window,4)!=owner||index<0||index>2)
      throw new InvalidOperationException("Picker identity/index outside the bounded check.");
    uint dpi=GetDpiForWindow(owner);
    if(dpi<96||dpi>480) throw new InvalidOperationException("Owner DPI unavailable/outside bound.");
    // Frozen app.cpp PickerCardRect, <=2 installed packs and scrollRow==0.
    int x=(int)Math.Round((16+(index%2)*172+78)*dpi/96.0,MidpointRounding.AwayFromZero);
    int y=(int)Math.Round((14+(index/2)*142+65)*dpi/96.0,MidpointRounding.AwayFromZero);
    Rect rect;
    var screen=new Point {X=x,Y=y};
    if(!GetClientRect(window,out rect)||x<0||y<0||x>=rect.R||y>=rect.B||!ClientToScreen(window,ref screen)||
       WindowFromPoint(screen)!=window)
      throw new InvalidOperationException("Owned source-derived picker point outside/occluded.");
    return new NmgNativePoint {Window=window,Owner=owner,ProcessId=processId,ClassName="NiuMaMeritAppearancePicker",
      Caption="source-derived-card",Index=index,Dpi=dpi,ClientX=x,ClientY=y,ScreenX=screen.X,ScreenY=screen.Y};
  }
  public static bool ClickNativePoint(NmgNativePoint point) {
    if(point==null) throw new InvalidOperationException("Missing native pointer target.");
    NmgNativePoint now;
    if(point.ClassName=="#32768") now=InspectMenuItem(point.Window,point.ProcessId,point.Caption);
    else if(point.ClassName=="NiuMaMeritAppearancePicker") now=InspectPickerCard(point.Window,point.ProcessId,point.Owner,point.Index);
    else throw new InvalidOperationException("Unapproved native pointer class.");
    if(now.ClientX!=point.ClientX||now.ClientY!=point.ClientY||now.ScreenX!=point.ScreenX||now.ScreenY!=point.ScreenY||
       now.Index!=point.Index||now.Dpi!=point.Dpi||now.ClientX<0||now.ClientY<0||now.ClientX>32767||now.ClientY>32767)
      throw new InvalidOperationException("Native pointer target moved/changed before dispatch.");
    IntPtr position=new IntPtr((now.ClientY<<16)|(now.ClientX&0xffff));
    // Owned mouse messages, not global SendInput or private WM_COMMAND.
    return PostMessage(now.Window,0x0200,IntPtr.Zero,position)&&
      PostMessage(now.Window,0x0201,new IntPtr(1),position)&&PostMessage(now.Window,0x0202,IntPtr.Zero,position);
  }
  public static NmgControlInspection InspectPickerConfirm(IntPtr picker,int processId,IntPtr owner) {
    RequireOwnedVisible(picker,processId,"NiuMaMeritAppearancePicker");
    if(GetWindow(picker,4)!=owner||!IsWindow(owner)||WindowProcessId(owner)!=(uint)processId||
       Class(owner)!="NiuMaMeritWindow") throw new InvalidOperationException("Picker owner changed.");
    var button=ReadControl(GetDlgItem(picker,1));
    if(!IsStandardIdOk(button,picker,processId)||!button.Visible||!button.Enabled||button.TextError!=null||
       (button.Text!="Confirm"&&button.Text!="\u786e\u8ba4")||!ButtonObservable(button,picker))
      throw new InvalidOperationException("Owned picker Confirm control not observed.");
    return button;
  }
  public static NmgButtonDispatch ClickPickerConfirm(NmgControlInspection expected,IntPtr picker,int processId,IntPtr owner) {
    var button=InspectPickerConfirm(picker,processId,owner);
    if(expected==null||button.Handle!=expected.Handle||button.Text!=expected.Text)
      throw new InvalidOperationException("Picker Confirm identity changed.");
    var dispatch=new NmgButtonDispatch {Button=button.Handle,TimeoutMs=1500,ForegroundBefore=GetForegroundWindow()};
    dispatch.ForegroundRequestSucceeded=SetForegroundWindow(picker); dispatch.ForegroundAfter=GetForegroundWindow();
    IntPtr result;
    var completed=SendButtonMessageTimeout(button.Handle,0x00F5,IntPtr.Zero,IntPtr.Zero,2,1500,out result);
    dispatch.Completed=completed!=IntPtr.Zero; dispatch.Win32Error=completed==IntPtr.Zero?Marshal.GetLastWin32Error():0;
    dispatch.MessageResult=result.ToInt64(); return dispatch;
  }
  public static void AssertCaptureContext(IntPtr main,IntPtr target,int processId,string expectedClass,IntPtr expectedOwner) {
    CheckDesktop();
    if(!IsWindow(main)||WindowProcessId(main)!=(uint)processId||
       Class(main)!="NiuMaMeritWindow"||!IsWindowVisible(main)||IsIconic(main))
      throw new InvalidOperationException("PAID_MAIN_IDENTITY_CHANGED");
    if(target==IntPtr.Zero) {
      if(!Observable(main)) throw new InvalidOperationException("PAID_MAIN_NOT_OBSERVABLE");
      return;
    }
    if(!IsWindow(target)||WindowProcessId(target)!=(uint)processId||
       Class(target)!=expectedClass||!IsWindowVisible(target)||IsIconic(target)||
       (expectedClass!="#32770"&&expectedClass!="#32768"&&expectedClass!="NiuMaMeritAppearancePicker"))
      throw new InvalidOperationException("PAID_CAPTURE_TARGET_IDENTITY_CHANGED");
    if(GetWindow(target,4)!=expectedOwner)
      throw new InvalidOperationException("PAID_CAPTURE_TARGET_OWNER_CHANGED");
    bool ownedModal=expectedOwner==main&&!IsWindowEnabled(main)&&
      (expectedClass=="#32770"||expectedClass=="NiuMaMeritAppearancePicker");
    if((expectedClass=="#32770"&&!ownedModal)||
       (expectedClass=="NiuMaMeritAppearancePicker"&&expectedOwner!=main))
      throw new InvalidOperationException("PAID_MODAL_OWNER_NOT_VERIFIED");
    // Only a live, identity-bound owned modal with its owner disabled may
    // obscure Main. A menu/modeless/foreign occluder grants no exemption.
    if(!ownedModal&&!Observable(main))
      throw new InvalidOperationException("PAID_MAIN_NOT_OBSERVABLE");
    if(!Observable(target))
      throw new InvalidOperationException("PAID_TEST_UI_NOT_OBSERVABLE");
  }
  public static void CaptureOwnedOpaque(string path,IntPtr window,int processId) {
    CheckDesktop();
    string cls=Class(window);
    if(cls!="#32770"&&cls!="#32768"&&cls!="NiuMaMeritAppearancePicker")
      throw new InvalidOperationException("Only opaque owned test UI may be captured.");
    RequireOwnedVisible(window,processId,cls);
    Rect rect;
    if(!GetClientRect(window,out rect)) throw new Win32Exception();
    var origin=new Point {X=rect.L,Y=rect.T};
    int width=rect.R-rect.L,height=rect.B-rect.T;
    if(width<=0||height<=0||(long)width*height>8000000||!ClientToScreen(window,ref origin))
      throw new InvalidOperationException("Owned capture bounds unavailable.");
    if(System.IO.File.Exists(path)) throw new InvalidOperationException("Screenshot no-clobber.");
    using(var bitmap=new Bitmap(width,height,PixelFormat.Format32bppArgb)) {
      using(var graphics=Graphics.FromImage(bitmap))
        graphics.CopyFromScreen(origin.X,origin.Y,0,0,new Size(width,height),CopyPixelOperation.SourceCopy);
      var timer=System.Diagnostics.Stopwatch.StartNew();
      for(int y=0;y<height;y++) {
        if(timer.ElapsedMilliseconds>10000) throw new InvalidOperationException("Owned capture mask timeout.");
        for(int x=0;x<width;x++) {
          var point=new Point {X=origin.X+x,Y=origin.Y+y};
          IntPtr hit=WindowFromPoint(point);
          if(GetAncestor(hit,2)!=window||WindowProcessId(hit)!=(uint)processId)
            bitmap.SetPixel(x,y,Color.Black);
        }
      }
      RequireOwnedVisible(window,processId,cls);
      bitmap.Save(path,ImageFormat.Png);
    }
  }
}
'@
  [NmgGuiObserver]::CheckDesktop()
  $report.desktop=[ordered]@{interactive=$true;inputDesktop='Default';sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId}
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
  Assert-Condition ($outputDirectoryOwned -and $isolationEstablished) 'Exclusive output/isolation ownership is required before installation.'
  $ownedInstallDirectory = Get-SafePath (Join-Path $outputRoot 'installed')
  Assert-Condition ($ownedInstallDirectory -ieq (Get-SafePath $installDir)) 'Installation target does not equal the exact isolated directory.'
  if (-not [NmgExclusiveOutputDirectory]::CreateDirectory($ownedInstallDirectory, [IntPtr]::Zero)) {
    throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error(),
      'Installation directory exclusive creation failed; this run does not own it.')
  }
  $installDirectoryOwned = $true
  $report.isolation['installDirectoryExclusivelyCreated'] = $true
  $installLog = Join-Path $outputRoot 'installer.log'
  $arguments = '/SP- /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /RESTARTEXITCODE=3010 /CURRENTUSER /NOICONS /TASKS="" /NOCLOSEAPPLICATIONS /NORESTARTAPPLICATIONS ' +
    '/DIR="' + $installDir + '" /GROUP="NmgAcceptance-' + $runId + '" /LOG="' + $installLog + '"'
  $report.installer['logPath'] = $installLog
  $installAttempted = $true
  $installer = Start-OwnedProcess $installerBinding.path $arguments 'installer'
  Wait-OwnedProcess $installer
  Assert-Condition ([IO.File]::Exists($installLog)) 'Real Inno installation log is missing.'
  $installedBinding = Open-BoundFile $clientPath
  $installedClientBinding=$installedBinding
  $copies=@(Get-ChildItem -LiteralPath $installDir -Filter 'niuma-merit.exe' -Recurse -File)
  Assert-Condition ($copies.Count -eq 1 -and (Get-SafePath $copies[0].FullName) -ieq $clientPath) 'PAID_INSTALLED_CLIENT_PATH_NOT_UNIQUE'
  $report.installedClient = Get-PeEvidence $installedBinding 'client'
  $uninstallerPath = Join-Path $installDir 'unins000.exe'
  $uninstallerBinding = Open-BoundFile $uninstallerPath
  Write-Receipt

  $initialCatalog=Get-CatalogSnapshot
  Assert-Condition ($initialCatalog.Count -eq 0) 'PAID_INITIAL_CATALOG_NOT_EMPTY'
  $phase='licensed-single';Invoke-GuiCase $licensed
  $phase='licensed-reimport'
  $reimport=[pscustomobject]@{name='reimport';binding=$licensed.binding;packs=$licensed.packs;evidence=$licensed.evidence}
  Invoke-GuiCase $reimport
  $phase='invalid-signature';Invoke-SignatureRejection $bad
  $phase='mixed-two-packs';Invoke-GuiCase $mixed
} catch {
  $failure=Get-SafeFailureCode $_
  $report.failure=[ordered]@{code=$failure;phase=$phase;type=(Get-SafeFailureType $_)}
} finally {
  $report.cleanup.attempted=$isolationEstablished -and ($installAttempted -or $installDirectoryOwned)
  if ($ownedProcesses.Count -gt 0) { Stop-OwnedProcesses }
  Set-CleanupPhase 'dispose-input-locks'
  foreach ($stream in $locks.ToArray()) {
    try {$stream.Dispose()} catch {Add-CleanupFailure 'dispose-input-locks' $_}
  }
  $locks.Clear()
  if ($isolationEstablished -and ($installAttempted -or $installDirectoryOwned)) {
    try {
      Set-CleanupPhase 'assert-exit'
      Assert-OwnedProcessesExited
      Set-CleanupPhase 'release-handles'
      Release-ExitedProcessHandles
      Set-CleanupPhase 'foreign-client'
      Assert-NoForeignClient
      Set-CleanupPhase 'startup-binding'
      $runValue = Get-RunValue 'HKCU:'
      Assert-Condition ($null -eq $runValue -or $runValue -ieq ('"' + $clientPath + '" --autostart')) `
        'Startup ownership changed; uninstall would affect an unowned value.'
      if ([IO.Directory]::Exists($installDir)) {
        Set-CleanupPhase 'uninstall-binding'
        Assert-Condition ($outputDirectoryOwned -and $installDirectoryOwned -and
          (Get-SafePath $installDir) -ieq $ownedInstallDirectory -and
          $ownedInstallDirectory -ieq (Get-SafePath (Join-Path $outputRoot 'installed'))) `
          'Refusing uninstall or deletion of an installation directory not exclusively created by this run.'
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
          Set-CleanupPhase 'uninstaller-start'
          $uninstaller = Start-OwnedProcess $uninstallerPath `
            ('/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG="' + $uninstallLog + '"') 'uninstaller'
          Set-CleanupPhase 'uninstaller-wait'
          Wait-OwnedProcess $uninstaller
          Set-CleanupPhase 'uninstall-log'
          Assert-Condition ([IO.File]::Exists($uninstallLog)) 'Real Inno uninstallation log is missing.'
          Set-CleanupPhase 'release-uninstaller-handles'
          Release-ExitedProcessHandles
        } else {
          Assert-Condition (-not [IO.File]::Exists($clientPath)) 'Own installation has no uninstaller; preserving it.'
        }
      }
      Set-CleanupPhase 'remove-install-directory'
      if ($installDirectoryOwned) { Remove-OwnedInstallDirectory }
      Set-CleanupPhase 'cleanup-app-artifacts'
      Cleanup-AppArtifacts
      $report.cleanup.complete = ($cleanupErrors.Count -eq 0)
    } catch { Add-CleanupFailure $report.cleanup.phase $_ }
    Set-CleanupPhase 'final-stop-owned-processes'
    if ($ownedProcesses.Count -gt 0) { Stop-OwnedProcesses }
  } else {
    Set-CleanupPhase 'not-required'
    $report.cleanup.complete = ($cleanupErrors.Count -eq 0)
  }
  Set-CleanupPhase 'dispose-final-locks'
  foreach ($stream in $locks.ToArray()) {
    try {$stream.Dispose()} catch {Add-CleanupFailure 'dispose-final-locks' $_}
  }
  foreach ($owned in $ownedProcesses.ToArray()) {
    Set-CleanupPhase 'final-exit-record'
    try { Record-Exit $owned } catch { Add-CleanupFailure 'final-exit-record' $_ }
    Set-CleanupPhase 'final-handle-dispose'
    try {$owned.handle.Dispose()} catch {Add-CleanupFailure 'final-handle-dispose' $_}
  }
  if ($cleanupErrors.Count -gt 0) {
    $report.cleanup.complete=$false
    $report.cleanup.phase=$report.cleanup.failurePhase
  } elseif ($report.cleanup.complete) {Set-CleanupPhase 'complete'}

  if (-not $failure -and $cleanupErrors.Count -eq 0 -and $report.cleanup.complete -and $report.cases.Count -eq 3 -and
      @($report.cases.ToArray() | Where-Object {$_.result -ne 'PASS' -or -not $_.switchingObserved -or -not $_.restartSelectionObserved}).Count -eq 0 -and
      $null -ne $report.invalidSignature -and $report.invalidSignature.result -ceq 'PASS' -and
      @($report.processes.ToArray() | Where-Object {$_.forcedTermination -or -not $_.waitCompleted -or $_.exitCodeStatus -ne 'known' -or $_.exitCode -ne 0}).Count -eq 0) {
    $report.result='PASS';$report.guiAcceptancePassed=$true;$report.switchingChecksPassed=$true
  }
  try {Write-Receipt -Final}
  catch {
    $failure='PAID_FINAL_RECEIPT_FAILED';$report.result='FAIL';$report.guiAcceptancePassed=$false
    if ($null -eq $report.failure) {
      $report.failure=[ordered]@{code=$failure;phase=$phase;type=(Get-SafeFailureType $_)}
    }
    [Console]::Error.WriteLine('PAID_FINAL_RECEIPT_FAILED')
  }
}
if ($report.result -ne 'PASS' -or $failure) {
  $diagnostic=[ordered]@{phase=$phase;failure=$report.failure
    cleanupPhase=$report.cleanup.phase;cleanupFailurePhase=$report.cleanup.failurePhase
    cleanupCode=$report.cleanup.errorCode;cleanupType=$report.cleanup.failureType
    cleanupErrorCount=$cleanupErrors.Count
    cases=@($report.cases.ToArray() | ForEach-Object {
      [ordered]@{name=$_.name;guiPhase=$_.guiPhase;failurePhase=$_.failurePhase}
    })}
  Write-Output ('PAID_GUI_FAILURE='+($diagnostic | ConvertTo-Json -Depth 6 -Compress))
  throw 'PAID_COMMUNITY_WINDOWS2022_GUI_FAILED_SEE_SANITIZED_RECEIPT'
}
Write-Output 'PAID_COMMUNITY_WINDOWS2022_GUI=PASS SOURCE_COMMIT_NOT_VERIFIED=true WIN11_HUMAN_ACCEPTANCE=false'
