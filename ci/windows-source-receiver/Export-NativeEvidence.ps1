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
function Assert-NoSecretMaterial($Value) {
  if ($null -eq $Value) { return }
  if ($Value -is [string]) {
    if ($Value -match '(?i)https?://|bearer\s+[A-Za-z0-9._~+/-]+') {
      throw [GongdeSourceReceiver.ReceiverFault]::new('EVIDENCE_UNAPPROVED_URL_OR_AUTH')
    }
    return
  }
  if ($Value -is [pscustomobject]) {
    foreach ($property in $Value.PSObject.Properties) {
      if ($property.Name -match '(?i)^(authorization|accessToken|bearerToken|token|secret|payloadBase64|sourceObjectUri|sourceUrl|ownerBindingPath|privatePayloadJson|responseBody)$') {
        throw [GongdeSourceReceiver.ReceiverFault]::new('EVIDENCE_SECRET_FIELD')
      }
      Assert-NoSecretMaterial $property.Value
    }
  } elseif ($Value -is [Collections.IEnumerable]) {
    foreach ($item in $Value) { Assert-NoSecretMaterial $item }
  }
}
function Read-EvidenceJson([string]$Path,[string]$Schema) {
  $bytes=Read-RegularBytes $Path 16777216
  $value=$utf8.GetString($bytes) | ConvertFrom-Json
  if ($Schema -and $value.schema -cne $Schema) {
    throw [GongdeSourceReceiver.ReceiverFault]::new('EVIDENCE_SCHEMA')
  }
  Assert-NoSecretMaterial $value
  return [pscustomobject]@{Bytes=$bytes;Value=$value}
}
$lease=$null
try {
  $SourceRoot=Get-RunnerLocalPath $SourceRoot
  $OutputDirectory=Get-RunnerLocalPath $OutputDirectory -Fresh
  $receiver=Read-EvidenceJson $SourceReceiverReceiptPath 'gongde-controlled-windows-source-receiver.v1'
  if ($receiver.Value.result -cne 'SOURCE_VERIFIED_NOT_NATIVE_ACCEPTANCE' -or
      $receiver.Value.sourceArchiveAndAllFilesVerified -ne $true -or
      $receiver.Value.sourceRoot -ine $SourceRoot) {
    throw [GongdeSourceReceiver.ReceiverFault]::new('EVIDENCE_RECEIVER_BINDING')
  }
  $planned=[Collections.Generic.List[object]]::new()
  $planned.Add([pscustomobject]@{Name='source-receiver-receipt.json';Bytes=$receiver.Bytes})
  # EXACT positive JSON list. No source manifest, archive, SDK manifest/data,
  # private owner binding, console/build/installer/uninstaller logs or globbing.
  foreach ($entry in @(
    @{Relative='native-build-evidence/client-artifact.json';Name='client-artifact.json';Schema='gongde-windows-artifact-binding.v1'},
    @{Relative='native-build-evidence/installer-artifact.json';Name='installer-artifact.json';Schema='gongde-windows-artifact-binding.v1'},
    @{Relative='native-build-evidence/candidate-binding.json';Name='candidate-binding.json';Schema='gongde-windows-native-candidate.v1'},
    @{Relative='native-build-evidence/normal-client-build.process.json';Name='normal-client-build.process.json';Schema=''},
    @{Relative='native-build-evidence/normal-installer-build.process.json';Name='normal-installer-build.process.json';Schema=''}
  )) {
    $path=Get-RunnerLocalPath (Join-Path $SourceRoot $entry.Relative)
    if ([IO.File]::Exists($path)) {
      $read=Read-EvidenceJson $path $entry.Schema
      $planned.Add([pscustomobject]@{Name=$entry.Name;Bytes=$read.Bytes})
    }
  }
  $guiPath=Join-Path $SourceRoot 'native-gui-evidence/receipt.json'
  $gui=$null
  if ([IO.File]::Exists($guiPath)) {
    $gui=Read-EvidenceJson $guiPath 'gongde-windows-installed-original-sdk-gui.v3'
    $planned.Add([pscustomobject]@{Name='native-gui-receipt.json';Bytes=$gui.Bytes})
    $guiRoot=(Get-RunnerLocalPath (Join-Path $SourceRoot 'native-gui-evidence')).TrimEnd('\')
    $names=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $observations=@($gui.Value.cases | ForEach-Object { $_.observations }) +
      @($gui.Value.lifecycleCases | ForEach-Object { $_.observations })
    foreach ($observation in $observations) {
      $path=Get-RunnerLocalPath ([string]$observation.screenshot)
      $name=[IO.Path]::GetFileName($path)
      if ([IO.Path]::GetDirectoryName($path) -ine $guiRoot -or
          $name -cnotmatch '\A(?:(?:amber|green|pair)-(?:privacy|import-dialog|normal-app|post-import-unexpected-dialog|restart-rendered|normal-menu-exit-menu|switch-(?:builtin|pack-[12])-(?:menu|picker|pending|rendered))|privacy-(?:owner-close|dialog-close|escape)-before-exit)\.png\z' -or
          -not $names.Add($name) -or $names.Count -gt 80) {
        throw [GongdeSourceReceiver.ReceiverFault]::new('EVIDENCE_SCREENSHOT_WHITELIST')
      }
      $bytes=Read-RegularBytes $path 67108864
      if ($bytes.Length -lt 8 -or [BitConverter]::ToString($bytes,0,8) -cne '89-50-4E-47-0D-0A-1A-0A' -or
          (Get-BytesSha $bytes) -cne $observation.screenshotSha256) {
        throw [GongdeSourceReceiver.ReceiverFault]::new('EVIDENCE_SCREENSHOT_BINDING')
      }
      $planned.Add([pscustomobject]@{Name=('screenshots/'+$name);Bytes=$bytes})
    }
  }
  $summary=[ordered]@{
    schema='gongde-native-evidence-export.v1'
    classification='WHITELIST_EXPORT_OF_ACTUAL_RECEIPTS_NOT_INFERRED_NATIVE_PASS'
    sourceZipSha256='0029f5e9fdd8b88adeff94a45c009afc70c061ee9dd83f4107e29148a07632fa'
    sourceManifestSha256='c02e32da628429414382efdf4b60c3b79bfdd518e257558db9d026231d80000a'
    nativeGuiReceiptPresent=($null -ne $gui)
    nativeGuiResult=if ($gui) {$gui.Value.result} else {'NOT_EXECUTED_OR_NO_FINAL_RECEIPT'}
    nativeGuiAcceptancePassed=if ($gui) {$gui.Value.guiAcceptancePassed} else {$false}
    historicalRun37288741395='FAIL 0xC0000005; not superseded or cause-proven'
    sourceSdkOrRawLogsIncluded=$false
    files=@($planned | ForEach-Object {@{name=$_.Name;bytes=$_.Bytes.Length;sha256=(Get-BytesSha $_.Bytes)}})
  }
  $lease=[GongdeSourceReceiver.DirectoryLease]::CreateExclusive($OutputDirectory)
  foreach ($file in $planned) { $lease.WriteNew($file.Name,$file.Bytes) }
  Write-LeasedJson $lease 'evidence-export.json' $summary
  [pscustomobject]@{EvidenceDirectory=$OutputDirectory;NativeGuiPassed=$summary.nativeGuiAcceptancePassed}
} catch {
  throw 'Native evidence export failed closed; no broad artifact upload or log/secret fallback.'
} finally { if ($lease) {$lease.Dispose()} }
