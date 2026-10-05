#Requires -Version 7.4
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$SourceRoot,
  [Parameter(Mandatory=$true)][string]$SourceReceiverReceiptPath,
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
. (Join-Path $PSScriptRoot 'Receiver.Common.ps1')
Assert-RealWindowsRunner
Initialize-ReceiverTypes
$utf8=[Text.UTF8Encoding]::new($false,$true)
$lease=$null
function Read-BoundJson([string]$Path,[string]$Schema) {
  $bytes=Read-RegularBytes $Path 65536
  $value=$utf8.GetString($bytes) | ConvertFrom-Json
  if ($value.schema -cne $Schema) { throw 'Binary binding schema mismatch.' }
  return $value
}
try {
  $SourceRoot=(Get-RunnerLocalPath $SourceRoot).TrimEnd('\')
  $OutputDirectory=Get-RunnerLocalPath $OutputDirectory -Fresh
  $receiver=Read-BoundJson $SourceReceiverReceiptPath 'gongde-controlled-windows-source-receiver.v1'
  if ($receiver.result -cne 'SOURCE_VERIFIED_NOT_NATIVE_ACCEPTANCE' -or
      $receiver.sourceArchiveAndAllFilesVerified -isnot [bool] -or
      -not $receiver.sourceArchiveAndAllFilesVerified -or
      $receiver.sourceRoot -ine $SourceRoot -or
      $receiver.expectedSourceZipSha256 -cne '0029f5e9fdd8b88adeff94a45c009afc70c061ee9dd83f4107e29148a07632fa' -or
      $receiver.expectedSourceManifestSha256 -cne 'c02e32da628429414382efdf4b60c3b79bfdd518e257558db9d026231d80000a') {
    throw 'Binary source receiver binding mismatch.'
  }
  $manifestPath=Join-Path $SourceRoot 'source-binding.json'
  if ((Get-BytesSha (Read-RegularBytes $manifestPath 65536)) -cne
      'c02e32da628429414382efdf4b60c3b79bfdd518e257558db9d026231d80000a') {
    throw 'Frozen source manifest changed after receipt.'
  }
  $candidate=Read-BoundJson (Join-Path $SourceRoot 'native-build-evidence/candidate-binding.json') 'gongde-windows-native-candidate.v1'
  if ($candidate.nativeBuildCompleted -isnot [bool] -or -not $candidate.nativeBuildCompleted -or
      $null -ne $candidate.gitSourceRef -or
      $candidate.sourceManifestSha256 -cne 'c02e32da628429414382efdf4b60c3b79bfdd518e257558db9d026231d80000a' -or
      $candidate.sourceManifestPath -ine $manifestPath -or
      $candidate.target -cne 'normal niuma-merit WIN32 Release x64, unchanged production lifecycle source' -or
      $candidate.clientArtifactReceipt -ine (Join-Path $SourceRoot 'native-build-evidence/client-artifact.json') -or
      $candidate.installerArtifactReceipt -ine (Join-Path $SourceRoot 'native-build-evidence/installer-artifact.json')) {
    throw 'Binary candidate provenance mismatch.'
  }
  $planned=[Collections.Generic.List[object]]::new()
  foreach ($entry in @(
      @{Kind='client';Name='niuma-merit.exe';Sha=$candidate.clientSha256},
      @{Kind='installer';Name='niuma-merit-windows-0.8.4-setup.exe';Sha=$candidate.installerSha256}
  )) {
    if ($entry.Sha -isnot [string] -or $entry.Sha -cnotmatch '\A[a-f0-9]{64}\z') {
      throw 'Binary candidate digest missing.'
    }
    # Two fixed files only; no dist/source/SDK glob or raw build logs.
    $bytes=Read-RegularBytes (Join-Path $SourceRoot ('dist/'+$entry.Name)) 67108864
    if ($bytes.Length -lt 256 -or [BitConverter]::ToUInt16($bytes,0) -ne 0x5a4d -or
        (Get-BytesSha $bytes) -cne $entry.Sha) { throw 'Binary bytes mismatch.' }
    $pe=[BitConverter]::ToInt32($bytes,0x3c)
    if ($pe -lt 64 -or $pe -gt $bytes.Length-26 -or
        [BitConverter]::ToUInt32($bytes,$pe) -ne 0x00004550) { throw 'Binary PE header missing.' }
    if ($entry.Kind -ceq 'client' -and
        ([BitConverter]::ToUInt16($bytes,$pe+4) -ne 0x8664 -or
         [BitConverter]::ToUInt16($bytes,$pe+24) -ne 0x20b)) { throw 'Client is not x64 PE.' }
    $planned.Add([pscustomobject]@{Kind=$entry.Kind;Name=$entry.Name;Sha=$entry.Sha;Bytes=$bytes})
  }
  $receipt=[ordered]@{
    schema='gongde-windows-binary-only-delivery.v1'
    classification='CURRENT_SOURCE_BINARY_CANDIDATE_NOT_NATIVE_ACCEPTANCE_OR_PUBLIC_RELEASE'
    sourceZipSha256='0029f5e9fdd8b88adeff94a45c009afc70c061ee9dd83f4107e29148a07632fa'
    sourceManifestSha256='c02e32da628429414382efdf4b60c3b79bfdd518e257558db9d026231d80000a'
    version='0.8.4'; nativeBuildCompleted=$true
    nativeGuiAcceptanceInferred=$false; publicRelease=$false
    sourceSdkSecretsOrRawLogsIncluded=$false
    files=@($planned | ForEach-Object {
      [ordered]@{kind=$_.Kind;name=$_.Name;bytes=$_.Bytes.Length;sha256=$_.Sha}
    })
  }
  $lease=[GongdeSourceReceiver.DirectoryLease]::CreateExclusive($OutputDirectory)
  foreach ($entry in $planned) { $lease.WriteNew($entry.Name,$entry.Bytes) }
  Write-LeasedJson $lease 'candidate-binaries.json' $receipt
  [pscustomobject]@{BinaryDirectory=$OutputDirectory;NativeGuiAcceptanceInferred=$false}
} catch {
  throw 'Candidate binary export failed closed; no directory, source, SDK or log fallback.'
} finally { if ($lease) {$lease.Dispose()} }
