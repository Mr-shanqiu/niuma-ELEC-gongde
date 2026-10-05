#Requires -Version 7.4
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$SourceRoot,
  [Parameter(Mandatory=$true)][string]$PrivatePayloadJson,
  [Parameter(Mandatory=$true)][string]$DestinationRoot
)
. (Join-Path $PSScriptRoot 'Receiver.Common.ps1')
Assert-RealWindowsRunner
Initialize-ReceiverTypes
$lease=$null
try {
  $SourceRoot=Get-RunnerLocalPath $SourceRoot
  $DestinationRoot=Get-RunnerLocalPath $DestinationRoot -Fresh
  $templateBytes=Read-RegularBytes (Join-Path $SourceRoot 'handoff/sdk-manifest.template.json') 65536
  if ((Get-BytesSha $templateBytes) -cne '0005a79ecce7ac1722b0cff176f8287c547d4edc8a1d1f7780db94eac4c386bb') {
    throw [GongdeSourceReceiver.ReceiverFault]::new('SDK_TEMPLATE_SHA')
  }
  # Reuse the existing private SDK contract, not the new source HTTP binding.
  $template=[Text.UTF8Encoding]::new($false,$true).GetString($templateBytes) | ConvertFrom-Json
  if (-not $PrivatePayloadJson -or $PrivatePayloadJson.Length -gt 65536) {
    throw [GongdeSourceReceiver.ReceiverFault]::new('SDK_PRIVATE_INPUT_SIZE')
  }
  $inputObject=$PrivatePayloadJson | ConvertFrom-Json
  if ($inputObject.schema -cne 'gongde-frozen-sdk-private-ci-inputs.v1' -or
      @($inputObject.cases).Count -ne 3 -or $template.schema -cne 'gongde-original-sdk-inputs.v2') {
    throw [GongdeSourceReceiver.ReceiverFault]::new('SDK_PRIVATE_INPUT_SCHEMA')
  }
  $payloads=[Collections.Generic.List[object]]::new()
  foreach ($pin in $template.cases) {
    $provided=@($inputObject.cases | Where-Object { $_.name -ceq $pin.name })
    if ($provided.Count -ne 1 -or $provided[0].fileName -cne $pin.path -or
        $provided[0].bytes -ne $pin.bytes -or $provided[0].sha256 -cne $pin.sha256) {
      throw [GongdeSourceReceiver.ReceiverFault]::new('SDK_PRIVATE_IDENTITY')
    }
    $bytes=[Convert]::FromBase64String([string]$provided[0].payloadBase64)
    if ($bytes.Length -ne $pin.bytes -or (Get-BytesSha $bytes) -cne $pin.sha256) {
      throw [GongdeSourceReceiver.ReceiverFault]::new('SDK_PRIVATE_BYTES')
    }
    $payloads.Add([pscustomobject]@{Name=$pin.path;Bytes=$bytes})
  }
  if ($payloads.Count -ne 3) { throw [GongdeSourceReceiver.ReceiverFault]::new('SDK_PRIVATE_COUNT') }
  $lease=[GongdeSourceReceiver.DirectoryLease]::CreateExclusive($DestinationRoot)
  foreach ($payload in $payloads) { $lease.WriteNew($payload.Name,$payload.Bytes) }
  [pscustomobject]@{SdkDirectory=$DestinationRoot;OriginalByteInputs=3;Regenerated=$false;Resigned=$false}
} catch {
  # Do not print malformed JSON/base64 or any private payload.
  throw 'Approved SDK private input failed its existing pinned contract; no SDK generator, signing or source-channel fallback.'
} finally {
  $PrivatePayloadJson=$null
  if ($lease) { $lease.Dispose() }
}
