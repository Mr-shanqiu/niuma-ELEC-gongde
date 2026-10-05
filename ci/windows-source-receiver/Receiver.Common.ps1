#Requires -Version 7.4
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Assert-RealWindowsRunner {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
      $PSVersionTable.PSEdition -ne 'Core' -or $env:GITHUB_ACTIONS -ne 'true' -or
      $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
      $env:GITHUB_EVENT_NAME -ne 'workflow_dispatch' -or
      -not $env:RUNNER_TEMP -or -not $env:GITHUB_RUN_ID) {
    throw 'A real, authorized GitHub-hosted Windows manual job is required; no environment override/test mode.'
  }
}
function Initialize-ReceiverTypes {
  if ('GongdeSourceReceiver.ArchiveVerifier' -as [type]) { return }
  $referenceRoot = Join-Path $PSHOME 'ref'
  if (-not [IO.Directory]::Exists($referenceRoot)) { throw 'Installed PowerShell reference pack is missing.' }
  $references = @(Get-ChildItem -LiteralPath $referenceRoot -Filter '*.dll' -File |
    ForEach-Object { $_.FullName })
  if ($references.Count -lt 20 -or $references.Count -gt 512) { throw 'Unexpected installed reference pack.' }
  Add-Type -ReferencedAssemblies $references -Path (Join-Path $PSScriptRoot 'VerifiedSourceArchive.cs')
}
function Get-RunnerLocalPath([string]$Path,[switch]$Fresh) {
  if (-not $Path -or $Path -match '["\r\n\x00]' -or $Path -match '^[\\/]{2}') {
    throw [GongdeSourceReceiver.ReceiverFault]::new('PATH_FORMAT')
  }
  $full = [IO.Path]::GetFullPath($Path)
  $temp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
  if ($full -notmatch '^[A-Za-z]:\\' -or $full.Substring(2) -match ':' -or
      -not $full.StartsWith($temp+'\',[StringComparison]::OrdinalIgnoreCase)) {
    throw [GongdeSourceReceiver.ReceiverFault]::new('PATH_NOT_RUNNER_TEMP')
  }
  [GongdeSourceReceiver.DirectoryLease]::NoReparsePath($full)
  if ($Fresh) {
    try { [IO.File]::GetAttributes($full) | Out-Null
      throw [GongdeSourceReceiver.ReceiverFault]::new('ROOT_EXISTS')
    } catch [IO.FileNotFoundException] {} catch [IO.DirectoryNotFoundException] {}
  }
  return $full
}
function Get-BytesSha([byte[]]$Bytes) {
  return [GongdeSourceReceiver.ArchiveVerifier]::Sha($Bytes)
}
function Read-RegularBytes([string]$Path,[long]$Maximum) {
  $path = Get-RunnerLocalPath $Path
  $attributes = [IO.File]::GetAttributes($path)
  if ($attributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)) {
    throw [GongdeSourceReceiver.ReceiverFault]::new('INPUT_NOT_REGULAR')
  }
  $stream = [IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try {
    if ($stream.Length -lt 1 -or $stream.Length -gt $Maximum) {
      throw [GongdeSourceReceiver.ReceiverFault]::new('INPUT_SIZE')
    }
    $reader = [IO.BinaryReader]::new($stream,[Text.Encoding]::UTF8,$true)
    try { return ,$reader.ReadBytes([int]$stream.Length) } finally { $reader.Dispose() }
  } finally { $stream.Dispose() }
}
function Write-LeasedJson($Lease,[string]$Name,$Object) {
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Object | ConvertTo-Json -Depth 24)+[char]10)
  $Lease.WriteNew($Name,$bytes)
}
function Get-RedactedFailureCode($ErrorRecord) {
  $exception = $ErrorRecord.Exception
  while ($exception) {
    if ($exception -is [GongdeSourceReceiver.ReceiverFault]) { return $exception.Code }
    $exception = $exception.InnerException
  }
  return 'RECEIVER_INTERNAL_FAILURE'
}
