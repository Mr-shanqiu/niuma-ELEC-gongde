#Requires -Version 7.4
param(
 [Parameter(Mandatory=$true)][string]$ReceiverPath,
 [Parameter(Mandatory=$true)][string]$FixturesPath,
 [Parameter(Mandatory=$true)][string]$OriginalBlockPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$stage='FULL_RECEIVER_PARSE'
$faultCode='SOURCE_READ_FAILED'
$sourceSha=$null
try {
 $utf8=[Text.UTF8Encoding]::new($false,$true)
 $sourceBytes=[IO.File]::ReadAllBytes($ReceiverPath)
 $sourceSha=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($sourceBytes)).ToLowerInvariant()
 if ($sourceSha -cne '0bd6cdd90f1891051d7f51693d7251434059b32c4dfd131aec3bedfc63184b0b') {
  $faultCode='RECEIVER_IDENTITY_DRIFT'
  throw 'Receiver identity drift.'
 }
 $faultCode='RECEIVER_SYNTAX_FAILED'
 $source=$utf8.GetString($sourceBytes)
 $tokens=$null; $errors=$null
 [Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors) | Out-Null
 if (@($errors).Count) {throw 'Full receiver syntax failed.'}
 $faultCode='DATE_BLOCK_MARKERS_MISSING'
 $start=$source.IndexOf('  # Read expiry from the verified JSON string')
 $end=$source.IndexOf('  $text=[Text.StringBuilder]::new(1014564)')
 if ($start -lt 0 -or $end -le $start) {throw 'Date block markers missing.'}
 $fixedBlock=$source.Substring($start,$end-$start)
 $originalBlock=[IO.File]::ReadAllText($OriginalBlockPath)
 $fixedBlock=$fixedBlock.Replace('[DateTimeOffset]::UtcNow','$fixtureNow')
 $originalBlock=$originalBlock.Replace('[DateTimeOffset]::UtcNow','$fixtureNow')
 $stage='FIXTURE_SETUP'
 $faultCode='FIXTURE_SETUP_FAILED'
 Add-Type -TypeDefinition @'
namespace GongdeSourceReceiver {
 public sealed class ReceiverFault : System.Exception {
  public string Code { get; private set; }
  public ReceiverFault(string code) : base(code) { Code=code; }
 }
}
'@
 function Invoke-DateBlock([string]$Block,[byte[]]$Raw,[DateTimeOffset]$fixtureNow,[bool]$Original) {
  $utf8=[Text.UTF8Encoding]::new($false,$true)
  $raw=$Raw; $expiryText=$null
  try {
   if ($Original) {$binding=$utf8.GetString($raw) | ConvertFrom-Json}
   . ([scriptblock]::Create($Block))
   return [pscustomobject]@{accepted=$true;code=$null;type=$null;text=$expiryText}
  } catch {
   $exception=$_.Exception; $type=$exception.GetType().FullName; $code='RECEIVER_INTERNAL_FAILURE'
   while ($exception) {
    if ($exception -is [GongdeSourceReceiver.ReceiverFault]) {$code=$exception.Code;break}
    $exception=$exception.InnerException
   }
   return [pscustomobject]@{accepted=$false;code=$code;type=$type;text=$null}
  }
 }
 $fixture=[Text.Json.JsonDocument]::Parse([IO.File]::ReadAllText($FixturesPath),[Text.Json.JsonDocumentOptions]::new())
 try {
  $cases=$fixture.RootElement.GetProperty('cases')
  if ($cases.GetArrayLength() -ne 25) {throw 'Fixture identity count mismatch.'}
  $results=[Collections.Generic.List[object]]::new()
  $probe=$cases[0].GetProperty('raw').GetString() | ConvertFrom-Json
  $convertedType=$probe.expiresAtUtc.GetType().FullName
  $stage='DATE_COMPARISON'
  $faultCode='DATE_COMPARISON_FAILED'
  foreach ($item in $cases.EnumerateArray()) {
   $name=$item.GetProperty('name').GetString()
   $raw=$utf8.GetBytes($item.GetProperty('raw').GetString())
   $clock=[DateTimeOffset]::Parse($item.GetProperty('now').GetString(),
    [Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal)
   $expected=$item.GetProperty('accepted').GetBoolean()
   $old=Invoke-DateBlock $originalBlock $raw $clock $true
   $fixed=Invoke-DateBlock $fixedBlock $raw $clock $false
   $preserved=if ($fixed.accepted) {$fixed.text -ceq $item.GetProperty('text').GetString()} else {$null}
   $passed=($fixed.accepted -eq $expected) -and (-not $expected -or $preserved)
   $results.Add([pscustomobject]@{name=$name;expectedAccepted=$expected;fixedAccepted=$fixed.accepted;
    fixedCode=$fixed.code;fixedExceptionType=$fixed.type;fixedTextPreserved=$preserved;
    originalAccepted=$old.accepted;originalCode=$old.code;originalExceptionType=$old.type;passed=$passed})
  }
 } finally {$fixture.Dispose()}
 $regression=$results.Find([Predicate[object]]{param($x) $x.name -ceq 'future-one-day'})
 $regressionPassed=(-not $regression.originalAccepted) -and
  ($regression.originalCode -ceq 'OWNER_BINDING_EXPIRED') -and
  $regression.fixedAccepted -and $regression.fixedTextPreserved
 $failed=@($results | Where-Object {-not $_.passed})
 $passed=($failed.Count -eq 0) -and $regressionPassed
 [pscustomobject]@{classification='REAL_POWERSHELL_SYNTHETIC_DATE_ONLY_NOT_WINDOWS_NATIVE';
  failureCategory=if($passed){$null}else{'DATE'};stage=$stage;passed=$passed;
  version=$PSVersionTable.PSVersion.ToString();receiverSha256=$sourceSha;
  fullReceiverSyntaxParsed=$true;convertFromJsonActualFieldType=$convertedType;
  originalRejectsAndCorrectionPreserves=$regressionPassed;cases=$results.ToArray();
  windowsGuardInvoked=$false;pinvokeInvoked=$false;fullReceiverExecuted=$false;
  privateInputRead=$false;nativeCandidateBuilt=$false} | ConvertTo-Json -Depth 8 -Compress
 if (-not $passed) {exit 1}
} catch {
 $category=if ($stage -eq 'DATE_COMPARISON') {'DATE'} else {'FIXTURE'}
 [pscustomobject]@{passed=$false;failureCategory=$category;stage=$stage;
  faultCode=$faultCode;receiverSha256=$sourceSha;
  exceptionType=$_.Exception.GetType().FullName;version=$PSVersionTable.PSVersion.ToString();
  windowsGuardInvoked=$false;pinvokeInvoked=$false;privateInputRead=$false} | ConvertTo-Json -Compress
 exit 2
}
