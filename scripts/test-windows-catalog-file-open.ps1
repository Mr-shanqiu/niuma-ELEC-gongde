param(
  [Parameter(Mandatory = $true)][string]$ClientPath,
  [Parameter(Mandatory = $true)][string]$CatalogPath,
  [Parameter(Mandatory = $true)][string]$EvidenceDirectory
)

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Only a disposable GitHub runner is allowed.' }
$ClientPath = (Resolve-Path -LiteralPath $ClientPath).Path
$CatalogPath = (Resolve-Path -LiteralPath $CatalogPath).Path
New-Item -ItemType Directory -Path $EvidenceDirectory | Out-Null
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class CatalogOpenNative {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string c, string t);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
'@
$catalog = Join-Path $env:LOCALAPPDATA 'NiuMaMerit/Reminders/Catalog/official.nmgtext'
$digest = (Get-FileHash $CatalogPath -Algorithm SHA256).Hash
if ($digest -ne 'fe61c56eb88e44122a0050c856ca68a3be89bc2c4ff38f3944d318eddb89e22a') { throw 'Official fixture differs.' }
if ((Test-Path $catalog) -or (Get-Process niuma-merit -ErrorAction SilentlyContinue)) { throw 'No active client or previous catalog is allowed.' }
$records = @()

function Clients { @(Get-Process niuma-merit -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $ClientPath }) }
function Wait-Client {
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    $items = @(Clients)
    if ($items.Count -eq 1) { $items[0].Handle | Out-Null; return $items[0] }
    Start-Sleep -Milliseconds 150
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Expected exactly one running client.'
}
function Wait-Dialog($Process) {
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    $condition = New-Object Windows.Automation.AndCondition(
      (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ProcessIdProperty, $Process.Id)),
      (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')))
    $dialog = [Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Children, $condition)
    if ($null -ne $dialog) { return $dialog }
    Start-Sleep -Milliseconds 150
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Import result dialog did not appear.'
}
function Finish-Dialog($Process, [string]$Name, [bool]$Success) {
  $dialog = Wait-Dialog $Process
  $text = (@($dialog.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)) |
    ForEach-Object { $_.Current.Name }) -join "`n"
  if ($Success) {
    if ($dialog.Current.Name -notmatch 'Messages Imported|文案包已导入' -or $text -notmatch '800.*800') { throw "Unexpected import result: $text" }
  } elseif ($dialog.Current.Name -notmatch 'Could Not Import Messages|无法导入文案包' -or $text -notmatch 'signature|签名') { throw "Invalid signature was not rejected: $text" }
  $bitmap = New-Object Drawing.Bitmap([CatalogOpenNative]::GetSystemMetrics(0), [CatalogOpenNative]::GetSystemMetrics(1))
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen(0, 0, 0, 0, $bitmap.Size)
    $bitmap.Save((Join-Path $EvidenceDirectory ($Name + '.png')), [Drawing.Imaging.ImageFormat]::Png)
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
  $script:records += @{case=$Name; dialog=$dialog.Current.Name; text=$text; pid=$Process.Id}
  [CatalogOpenNative]::PostMessage([IntPtr]$dialog.Current.NativeWindowHandle, 0x0111, [IntPtr]1, [IntPtr]::Zero) | Out-Null
  Start-Sleep -Milliseconds 500
  if (-not (Test-Path $catalog) -or (Get-FileHash $catalog -Algorithm SHA256).Hash -ne $digest) { throw 'Installed catalog differs after file-open result.' }
}
function Stop-Client($Process) {
  $Process.Refresh()
  [CatalogOpenNative]::PostMessage(([CatalogOpenNative]::FindWindowW('NiuMaMeritWindow', $null)), 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  if (-not $Process.WaitForExit(10000)) { throw 'Client did not close normally.' }
}

try {
  $running = Start-Process $ClientPath -ArgumentList '--listener-acceptance --diagnostics' -PassThru
  $running.Handle | Out-Null
  $running = Wait-Client
  Start-Sleep -Seconds 2
  $command = (Get-Item 'HKCU:\Software\Classes\NiuMaMerit.MessageCatalog\shell\open\command').GetValue('')
  if ($command -ne ('"' + $ClientPath + '" "%1"')) { throw 'Message-file open command is not safely quoted.' }
  if ((Get-Item 'HKCU:\Software\Classes\.nmgtext').GetValue('') -ne 'NiuMaMerit.MessageCatalog') { throw 'Message extension is not associated.' }
  # ShellExecute exercises the same association as opening the downloaded file.
  Start-Process -FilePath $CatalogPath
  Finish-Dialog $running 'warm-import' $true
  if ((@(Clients)).Count -ne 1 -or (@(Clients))[0].Id -ne $running.Id) { throw 'File open created a second persistent client.' }
  Stop-Client $running
  Start-Process -FilePath $CatalogPath
  $running = Wait-Client
  $running.Handle | Out-Null
  Finish-Dialog $running 'cold-duplicate-import' $true
  $bad = Join-Path $EvidenceDirectory 'invalid-signature.nmgtext'
  $envelope = Get-Content -LiteralPath $CatalogPath -Raw | ConvertFrom-Json
  $signature = [Convert]::FromBase64String($envelope.signature_b64)
  $signature[0] = $signature[0] -bxor 1
  $envelope.signature_b64 = [Convert]::ToBase64String($signature)
  [IO.File]::WriteAllText($bad, ($envelope | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
  Start-Process -FilePath $bad
  Finish-Dialog $running 'warm-invalid-signature' $false
  Stop-Client $running
  @{status='passed'; cases=$records; shellFileAssociation=$true; onePersistentInstance=$true; unchangedCatalogAfterRejection=$true; userDevicesTouched=$false} |
    ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $EvidenceDirectory 'FILE_OPEN_RECEIPT.json')
} finally {
  Get-Process niuma-merit -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
