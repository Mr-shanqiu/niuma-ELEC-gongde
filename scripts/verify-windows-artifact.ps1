param(
  [Parameter(Mandatory = $true)][string]$ExecutablePath,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [Parameter(Mandatory = $true)][ValidateSet('client', 'installer')][string]$ArtifactKind,
  [Parameter(Mandatory = $true)][string]$ReceiptPath,
  [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw 'Windows artifact metadata must be checked on native Windows'
}
function Convert-VersionParts {
  param([string]$Value, [string]$Field)
  $value = $Value.Trim()
  if ($value -notmatch '^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(?:\.[0-9]{1,5})?$') {
    throw "Invalid numeric version in $Field"
  }
  $parts = @($value.Split('.') | ForEach-Object { [int]$_ })
  if ($parts.Count -eq 3) { $parts += 0 }
  foreach ($part in $parts) {
    if ($part -gt 65535) { throw "Version part exceeds PE resource range in $Field" }
  }
  return $parts
}

$expectedParts = @(Convert-VersionParts -Value $ExpectedVersion -Field 'VERSION')
$expectedNumeric = $expectedParts -join '.'
$item = Get-Item -LiteralPath $ExecutablePath
if ($item -isnot [System.IO.FileInfo] -or $item.Extension -ine '.exe' -or
    (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
  throw 'Artifact must be a regular non-reparse EXE file'
}
$resolvedReceipt = [System.IO.Path]::GetFullPath($ReceiptPath)
if ([System.IO.Path]::GetExtension($resolvedReceipt) -ine '.json' -or
    [string]::Equals($resolvedReceipt, $item.FullName, [System.StringComparison]::OrdinalIgnoreCase) -or
    -not [System.IO.Directory]::Exists([System.IO.Path]::GetDirectoryName($resolvedReceipt))) {
  throw 'Receipt must be a distinct JSON path in an existing output directory'
}

# Hold a read-only handle without write/delete sharing throughout the binding.
# Version resources are inspected as data; neither client nor installer is run.
$stream = [System.IO.File]::Open($item.FullName, [System.IO.FileMode]::Open,
  [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
$reader = $null
try {
  if ($stream.Length -lt 64 -or $stream.Length -gt 80 * 1024 * 1024) {
    throw 'Artifact size is outside the installer-upload contract'
  }
  $reader = [System.IO.BinaryReader]::new($stream)
  if ($reader.ReadUInt16() -ne 0x5a4d) { throw 'Artifact DOS header is invalid' }
  $stream.Position = 60
  $peOffset = [long]$reader.ReadUInt32()
  if ($peOffset -lt 64 -or $peOffset -gt $stream.Length - 26) {
    throw 'Artifact PE header offset is invalid'
  }
  $stream.Position = $peOffset
  if ($reader.ReadUInt32() -ne 0x00004550) { throw 'Artifact PE signature is invalid' }
  $machine = $reader.ReadUInt16()
  $sectionCount = $reader.ReadUInt16()
  $stream.Position = $peOffset + 20
  $optionalSize = $reader.ReadUInt16()
  if ($sectionCount -eq 0 -or $optionalSize -lt 2 -or
      $peOffset + 24 + $optionalSize + 40 * $sectionCount -gt $stream.Length) {
    throw 'Artifact PE headers are truncated'
  }
  $stream.Position = $peOffset + 24
  $magic = $reader.ReadUInt16()
  $x64Image = $machine -eq 0x8664 -and $magic -eq 0x20b
  $x86Image = $machine -eq 0x014c -and $magic -eq 0x10b
  if (($ArtifactKind -eq 'client' -and -not $x64Image) -or
      ($ArtifactKind -eq 'installer' -and -not ($x64Image -or $x86Image))) {
    throw 'Artifact PE architecture does not match its client/installer role'
  }

  $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($item.FullName)
  $fileParts = @($info.FileMajorPart, $info.FileMinorPart, $info.FileBuildPart, $info.FilePrivatePart)
  $productParts = @($info.ProductMajorPart, $info.ProductMinorPart, $info.ProductBuildPart, $info.ProductPrivatePart)
  $fileStringParts = @(Convert-VersionParts -Value $info.FileVersion -Field 'FileVersion')
  $productStringParts = @(Convert-VersionParts -Value $info.ProductVersion -Field 'ProductVersion')
  foreach ($actual in @(
    ($fileParts -join '.'),
    ($productParts -join '.'),
    ($fileStringParts -join '.'),
    ($productStringParts -join '.')
  )) {
    if ($actual -ne $expectedNumeric) {
      throw "Artifact version resources do not match VERSION: expected $expectedNumeric, got $actual"
    }
  }
  $sourceRef = $env:GITHUB_SHA
  if ($sourceRef -and $sourceRef -notmatch '^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$') {
    throw 'CI source reference is not a commit digest'
  }
  $report = [ordered]@{
    schema = 'gongde-windows-artifact-binding.v1'
    classification = 'NATIVE_WINDOWS_PE_VERSION_METADATA_NOT_INSTALL_OR_GUI_IMPORT'
    checkedAt = [System.DateTime]::UtcNow.ToString('o')
    sourceVersion = $ExpectedVersion.Trim()
    numericVersion = $expectedNumeric
    configurationDeclared = $Configuration
    sourceRef = $sourceRef
    workflowRunId = $env:GITHUB_RUN_ID
    artifact = [ordered]@{
      kind = $ArtifactKind
      fileName = $item.Name
      bytes = $stream.Length
      sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      peMachine = ('0x{0:x4}' -f $machine)
      optionalMagic = ('0x{0:x}' -f $magic)
      peArchitecture = $(if ($x64Image) { 'x64' } else { 'x86' })
      targetArchitecture = $(if ($ArtifactKind -eq 'client') { 'x64' } else { 'not_inferred_from_installer_stub' })
      fileVersion = $info.FileVersion
      productVersion = $info.ProductVersion
      fileNumericVersion = $fileParts -join '.'
      productNumericVersion = $productParts -join '.'
      versionResourceScope = 'Native FileVersionInfo query, not every resource language'
    }
    boundaries = [ordered]@{
      artifactExecuted = $false
      installerOrUpgradeAccepted = $false
      nativeGuiOrOriginalSdkImportAccepted = $false
      signatureTrustVerified = $false
      unsignedDistributionPolicyChanged = $false
      productionPublished = $false
      creatorFreeDeliveryEnabled = $false
      goalComplete = $false
    }
  }
  $json = ($report | ConvertTo-Json -Depth 8) + [char]10
  # A fresh run directory and CreateNew preserve prior receipts instead of
  # silently overwriting a previously bound artifact.
  $output = [System.IO.File]::Open($resolvedReceipt, [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try {
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json)
    $output.Write($bytes, 0, $bytes.Length)
  } finally {
    $output.Dispose()
  }
  "WINDOWS_ARTIFACT_BINDING=$resolvedReceipt"
  "WINDOWS_ARTIFACT_VERSION=$expectedNumeric"
  "WINDOWS_ARTIFACT_SHA256=$($report.artifact.sha256)"
} finally {
  if ($reader) { $reader.Dispose() }
  $stream.Dispose()
}

