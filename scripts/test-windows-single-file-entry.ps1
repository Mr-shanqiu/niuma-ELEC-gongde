param(
  [Parameter(Mandatory=$true)][string]$ExecutablePath,
  [Parameter(Mandatory=$true)][string]$EvidenceDir
)
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This test may install only in a disposable Actions user account.' }
$image=(Get-Item -LiteralPath $ExecutablePath).FullName
$evidence=(New-Item -ItemType Directory -Path $EvidenceDir -Force).FullName
$program=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\NiumaMerit'
$installed=Join-Path $program 'niuma-merit.exe'
$data=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'NiuMaMerit'
$uninstall='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{D1B9D81E-13A1-45E2-9B8F-33C9C7A06F27}_is1'
if ((Test-Path -LiteralPath $program) -or (Test-Path -LiteralPath $data) -or
    (Test-Path -LiteralPath $uninstall) -or (Get-Process niuma-merit -ErrorAction SilentlyContinue)) {
  throw 'An existing installation, data directory or process is present; test refuses to touch it.'
}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class NiuMaSetupUI {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder value, int capacity);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left,top,right,bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
  public static IntPtr Find(int owner, string wanted) {
    IntPtr found=IntPtr.Zero;
    EnumWindows((hwnd,unused)=>{uint pid;GetWindowThreadProcessId(hwnd,out pid);
      var cls=new StringBuilder(256);GetClassName(hwnd,cls,cls.Capacity);
      if(pid==owner && cls.ToString()==wanted && IsWindowVisible(hwnd)){found=hwnd;return false;}
      return true;},IntPtr.Zero);return found;
  }
}
'@
function Await([scriptblock]$Condition,[string]$Description,[int]$Seconds=25) {
  $deadline=[DateTime]::UtcNow.AddSeconds($Seconds)
  do { $value=& $Condition; if($value){return $value};Start-Sleep -Milliseconds 100 } while([DateTime]::UtcNow -lt $deadline)
  throw "Timeout: $Description"
}
function Snapshot-Dialog([IntPtr]$Window,[string]$Name) {
  Add-Type -AssemblyName System.Drawing
  $rect=New-Object NiuMaSetupUI+Rect
  if(-not [NiuMaSetupUI]::GetWindowRect($Window,[ref]$rect)){throw 'Dialog dimensions unavailable'}
  $bitmap=New-Object Drawing.Bitmap ($rect.right-$rect.left),($rect.bottom-$rect.top)
  $graphics=[Drawing.Graphics]::FromImage($bitmap);$dc=$graphics.GetHdc()
  try {if(-not [NiuMaSetupUI]::PrintWindow($Window,$dc,2)){throw 'Owned dialog capture failed'}}
  finally {$graphics.ReleaseHdc($dc);$graphics.Dispose()}
  $bitmap.Save((Join-Path $evidence $Name),[Drawing.Imaging.ImageFormat]::Png);$bitmap.Dispose()
}
$hash=(Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash
$receipt=[ordered]@{kind='single-file-native-entry';source=$image;sourceSha256=$hash;installed=$installed;
  environment='disposable Windows Server Actions account';win10Tested=$false;realHardwarePerformanceTested=$false}
# Drive only windows belonging to these explicitly launched test processes.
$download=Start-Process -FilePath $image -PassThru
$dialog=Await { [NiuMaSetupUI]::Find($download.Id,'#32770') } 'first installation dialog'
Snapshot-Dialog $dialog 'single-file-install.png'
[NiuMaSetupUI]::SendMessage($dialog,1137,[IntPtr]0,[IntPtr]0) | Out-Null # TDM_CLICK_VERIFICATION
[NiuMaSetupUI]::SendMessage($dialog,1126,[IntPtr]1,[IntPtr]0) | Out-Null # TDM_CLICK_BUTTON IDOK
if(-not $download.WaitForExit(30000) -or $download.ExitCode -ne 0){throw 'Download entry did not finish successfully'}
$client=Await {Get-Process niuma-merit -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq $installed} | Select-Object -First 1} 'installed client'
$window=Await {
  $notice=[NiuMaSetupUI]::Find($client.Id,'#32770')
  if($notice -ne [IntPtr]::Zero){[NiuMaSetupUI]::SendMessage($notice,273,[IntPtr]1,[IntPtr]0)|Out-Null}
  [NiuMaSetupUI]::Find($client.Id,'NiuMaMeritWindow')
} 'production client window'
$style=[NiuMaSetupUI]::GetWindowLongPtr($window,-20).ToInt64()
if(($style -band 0x200000) -eq 0 -or ($style -band 0x80000) -ne 0){throw 'Production window did not select DirectComposition'}
if((Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash -ne $hash){throw 'Installed bytes changed'}
if(-not (Test-Path -LiteralPath $uninstall)){throw 'System uninstall entry missing'}
$startLink=Join-Path ([Environment]::GetFolderPath('Programs')) '牛马电子功德.lnk'
$desktopLink=Join-Path ([Environment]::GetFolderPath('Desktop')) '牛马电子功德.lnk'
if(-not (Test-Path -LiteralPath $startLink) -or -not (Test-Path -LiteralPath $desktopLink)){throw 'Shortcut missing'}
# Allow the ordinary first-run guide to close before asking the real app to save.
$notice=[NiuMaSetupUI]::Find($client.Id,'#32770')
if($notice -ne [IntPtr]::Zero){[NiuMaSetupUI]::SendMessage($notice,273,[IntPtr]1,[IntPtr]0)|Out-Null}
[NiuMaSetupUI]::SendMessage($window,16,[IntPtr]0,[IntPtr]0)|Out-Null
if(-not $client.WaitForExit(15000) -or $client.ExitCode -ne 0){throw 'Installed client failed normal close'}
$ini=Join-Path $data 'data.ini'; if(-not (Test-Path -LiteralPath $ini)){throw 'Installed client did not save its data'}
$dataHash=(Get-FileHash -LiteralPath $ini -Algorithm SHA256).Hash
$receipt.exactInstall=$true;$receipt.productionComposition=$true;$receipt.normalClose=$true
$remover=Start-Process -FilePath $installed -ArgumentList '--uninstall' -PassThru
$confirmation=Await {[NiuMaSetupUI]::Find($remover.Id,'#32770')} 'uninstall confirmation'
Snapshot-Dialog $confirmation 'single-file-uninstall.png'
[NiuMaSetupUI]::SendMessage($confirmation,273,[IntPtr]1,[IntPtr]0)|Out-Null
if(-not $remover.WaitForExit(10000) -or $remover.ExitCode -ne 0){throw 'Uninstall parent failed'}
Await {-not (Test-Path -LiteralPath $installed)} 'installed executable removed' | Out-Null
$worker=Get-Process niuma-merit -ErrorAction SilentlyContinue | Where-Object {$_.Path -like (Join-Path $env:TEMP 'NiuMaMerit-remove-*\niuma-merit.exe')} | Select-Object -First 1
if(-not $worker){throw 'Signed-copy uninstall worker identity unavailable'}
if((Get-FileHash -LiteralPath $worker.Path -Algorithm SHA256).Hash -ne $hash){throw 'Uninstall copy bytes changed'}
$workerDir=Split-Path $worker.Path -Parent
$finished=Await {[NiuMaSetupUI]::Find($worker.Id,'#32770')} 'uninstall result'
[NiuMaSetupUI]::SendMessage($finished,273,[IntPtr]1,[IntPtr]0)|Out-Null
if(-not $worker.WaitForExit(10000) -or $worker.ExitCode -ne 0){throw 'Uninstall worker failed'}
if((Test-Path -LiteralPath $uninstall) -or (Test-Path -LiteralPath $startLink) -or (Test-Path -LiteralPath $desktopLink)){throw 'Owned uninstall entries remain'}
if((Get-FileHash -LiteralPath $ini -Algorithm SHA256).Hash -ne $dataHash){throw 'Uninstall modified user records'}
$receipt.uninstallSameImage=$true;$receipt.userRecordsRetained=$true
# Next ordinary invocation cleans only the marked, exited temporary copy.
$again=Start-Process -FilePath $image -PassThru
$cancel=Await {[NiuMaSetupUI]::Find($again.Id,'#32770')} 'reinstall confirmation'
if(Test-Path -LiteralPath $workerDir){throw 'Retired uninstall worker was not cleaned'}
[NiuMaSetupUI]::SendMessage($cancel,1126,[IntPtr]2,[IntPtr]0)|Out-Null
if(-not $again.WaitForExit(10000) -or $again.ExitCode -ne 0){throw 'Install cancellation failed'}
if(Test-Path -LiteralPath $installed){throw 'Cancelled setup created an installation'}
$receipt.retiredWorkerCleaned=$true;$receipt.cancelHasNoInstall=$true;$receipt.status='PASS'
$receipt | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $evidence 'single-file-entry.json') -Encoding utf8
'SINGLE_FILE_ENTRY=PASS exact install, production window, normal close, same-image uninstall, retained data, retired helper cleanup, cancel'
# The data directory was absent before this test. Remove only that owned CI data.
Remove-Item -LiteralPath $data -Recurse -Force
