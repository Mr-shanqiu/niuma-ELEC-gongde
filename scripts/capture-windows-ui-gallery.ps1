param([Parameter(Mandatory=$true)][string]$ExecutablePath,
      [Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NiuMaGallery {
 public delegate bool Visitor(IntPtr h, IntPtr p);
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern bool EnumWindows(Visitor v,IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,System.Text.StringBuilder b,int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h,int id);
 [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr menu);
 [DllImport("user32.dll")] public static extern bool GetMenuItemRect(IntPtr window,IntPtr menu,uint index,out Rect rect);
 [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr window,IntPtr region);
 [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l,int t,int r,int b);
 [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr region,int x,int y);
 [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
 public static IntPtr Find(int pid,string cls) {
  IntPtr found=IntPtr.Zero;
  EnumWindows((h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);var b=new System.Text.StringBuilder(128);GetClassName(h,b,128);
   if(owner==(uint)pid&&b.ToString()==cls&&IsWindowVisible(h)){found=h;return false;}return true;},IntPtr.Zero);
  return found;
 }
}
'@
$ExecutablePath=(Resolve-Path -LiteralPath $ExecutablePath).Path
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$root=Join-Path $env:TEMP ('NiuMaMerit-ReminderAcceptance-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root|Out-Null
$previous=$env:NIUMA_ACCEPTANCE_ROOT
$env:NIUMA_ACCEPTANCE_ROOT=$root
$process=Start-Process -FilePath $ExecutablePath -ArgumentList '--isolated-acceptance' -PassThru
$process.Handle|Out-Null
function Wait-Window([string]$Class) {
 $end=[DateTime]::UtcNow.AddSeconds(5)
 do { $h=[NiuMaGallery]::Find($process.Id,$Class); if($h -ne [IntPtr]::Zero){return $h};Start-Sleep -Milliseconds 80 } while([DateTime]::UtcNow -lt $end)
 throw ('Missing gallery window: '+$Class)
}
function Capture-Window([IntPtr]$Window,[string]$Name,[bool]$IsMenu=$false) {
 # A popup menu is owned by its app's active window; activating the menu itself dismisses it.
 if(-not $IsMenu){[NiuMaGallery]::SetForegroundWindow($Window)|Out-Null}
 Start-Sleep -Milliseconds 180
 $rect=New-Object NiuMaGallery+Rect
 if(-not [NiuMaGallery]::GetWindowRect($Window,[ref]$rect)){throw ('Window bounds unavailable: '+$Name)}
 $bitmap=New-Object Drawing.Bitmap(($rect.Right-$rect.Left),($rect.Bottom-$rect.Top))
 $graphics=[Drawing.Graphics]::FromImage($bitmap)
 try { $graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,$bitmap.Size);$bitmap.Save((Join-Path $OutputDirectory $Name),[Drawing.Imaging.ImageFormat]::Png) }
 finally {$graphics.Dispose();$bitmap.Dispose()}
}
try {
 $main=Wait-Window 'NiuMaMeritWindow'
 $cases=@(@{action=1;class='NiuMaMeritCalendar';name='calendar.png';close=0},
          @{action=2;class='NiuMaMeritAppearancePicker';name='appearances.png';close=2},
          @{action=3;class='#32770';name='offwork.png';close=2},
          @{action=4;class='#32770';name='about.png';close=1},
          @{action=5;class='#32768';name='menu.png';close=-1})
 foreach($case in $cases) {
  [NiuMaGallery]::PostMessage($main,0x8046,[IntPtr]$case.action,[IntPtr]::Zero)|Out-Null
  $window=Wait-Window $case.class
  if($case.action -eq 1) {
   $today=[DateTime]::Today
   $currentMonth=$today.Year*12+$today.Month-1
   $scale=[NiuMaGallery]::GetDpiForWindow($window)/96.0
   $cy=[int][Math]::Round(90*$scale)
   $previousX=[int][Math]::Round(46*$scale)
   $nextX=[int][Math]::Round(514*$scale)
   $previousPoint=[IntPtr](($cy -shl 16) -bor $previousX)
   $nextPoint=[IntPtr](($cy -shl 16) -bor $nextX)
   foreach($point in @($previousPoint,$nextPoint)) {
    [NiuMaGallery]::SendMessage($window,0x202,[IntPtr]::Zero,$point)|Out-Null
    if([NiuMaGallery]::SendMessage($window,0x8047,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32() -ne $currentMonth){throw 'Empty calendar browsed outside current month'}
   }
   [NiuMaGallery]::SendMessage($window,0x10,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null
   $meritDay=$today.AddMonths(-3).ToString('yyyy-MM-dd',[Globalization.CultureInfo]::InvariantCulture)
   $overtimeDay=$today.AddMonths(-5).ToString('yyyy-MM-dd',[Globalization.CultureInfo]::InvariantCulture)
   $zeroDay=$today.AddMonths(-8).ToString('yyyy-MM-dd',[Globalization.CultureInfo]::InvariantCulture)
   $futureDay=$today.AddMonths(1).ToString('yyyy-MM-dd',[Globalization.CultureInfo]::InvariantCulture)
   $sample=[DateTimeOffset]::Now.ToUnixTimeSeconds()
   $ini="[daily]`r`n$meritDay=5`r`n$zeroDay=0`r`n$futureDay=1`r`ninvalid-day=9`r`n[offwork_daily]`r`n$overtimeDay=3600,1080,$sample`r`n$zeroDay=0,1080,$sample`r`n"
   [IO.File]::WriteAllText((Join-Path $root 'data.ini'),$ini,[Text.Encoding]::Unicode)
   [NiuMaGallery]::PostMessage($main,0x8046,[IntPtr]1,[IntPtr]::Zero)|Out-Null
   $window=Wait-Window $case.class
   for($i=0;$i -lt 80;$i++){[NiuMaGallery]::SendMessage($window,0x202,[IntPtr]::Zero,$previousPoint)|Out-Null}
   $earliestMonth=$today.AddMonths(-5).Year*12+$today.AddMonths(-5).Month-1
   if([NiuMaGallery]::SendMessage($window,0x8047,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32() -ne $earliestMonth){throw 'Earliest valid recorded month boundary failed'}
   [NiuMaGallery]::SendMessage($window,0x202,[IntPtr]::Zero,$nextPoint)|Out-Null
   if([NiuMaGallery]::SendMessage($window,0x8047,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32() -ne $earliestMonth+1){throw 'Empty month inside history range became inaccessible'}
   for($i=0;$i -lt 80;$i++){[NiuMaGallery]::SendMessage($window,0x202,[IntPtr]::Zero,$nextPoint)|Out-Null}
   if([NiuMaGallery]::SendMessage($window,0x8047,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32() -ne $currentMonth){throw 'Current month boundary failed'}
   @{status='passed';emptyHistoryCurrentOnly=$true;earliestRecordedMonth=$earliestMonth;currentMonth=$currentMonth;emptyGapsBrowsable=$true;repeatedBoundaryClicks=80;zeroAndInvalidAndFutureIgnored=$true;realProfileUsed=$false}|ConvertTo-Json|Set-Content -Encoding UTF8 (Join-Path $OutputDirectory 'CALENDAR_BOUNDS.json')
  }
  Capture-Window $window $case.name ($case.close -eq -1)
  if($case.action -in @(1,4,5)) {
   $region=[NiuMaGallery]::CreateRectRgn(0,0,0,0)
   try {
    if([NiuMaGallery]::GetWindowRgn($window,$region) -eq 0 -or [NiuMaGallery]::PtInRegion($region,0,0) -or -not [NiuMaGallery]::PtInRegion($region,30,30)){throw ('Rounded shell missing: '+$case.name)}
   } finally {[NiuMaGallery]::DeleteObject($region)|Out-Null}
  }
  if($case.close -eq -1) {
   $menu=[NiuMaGallery]::SendMessage($window,0x1E1,[IntPtr]::Zero,[IntPtr]::Zero)
   if([NiuMaGallery]::GetMenuItemCount($menu) -ne 6){throw 'Expected six equal command rows'}
   $heights=@()
   for($i=0;$i -lt 6;$i++) {
    $row=New-Object NiuMaGallery+Rect
    if(-not [NiuMaGallery]::GetMenuItemRect($main,$menu,$i,[ref]$row)){throw 'Menu row bounds unavailable'}
    $heights+=($row.Bottom-$row.Top)
   }
   if(@($heights|Select-Object -Unique).Count -ne 1){throw 'Menu command heights differ'}
   @{rows=6;heights=$heights;roundedShell=$true}|ConvertTo-Json|Set-Content -Encoding UTF8 (Join-Path $OutputDirectory 'MENU_GEOMETRY.json')
  }
  if($case.close -eq -1){[NiuMaGallery]::PostMessage($main,0x8046,[IntPtr]6,[IntPtr]::Zero)|Out-Null}
  elseif($case.close -gt 0){$button=[NiuMaGallery]::GetDlgItem($window,$case.close);if($button -eq [IntPtr]::Zero){throw 'Close control missing'};[NiuMaGallery]::SendMessage($button,0xF5,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null}
  else{[NiuMaGallery]::PostMessage($window,0x10,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null}
  $end=[DateTime]::UtcNow.AddSeconds(3)
  while([NiuMaGallery]::IsWindow($window) -and [DateTime]::UtcNow -lt $end){Start-Sleep -Milliseconds 50}
  if([NiuMaGallery]::IsWindowVisible($window)){throw 'Gallery page did not close'}
 }
 [NiuMaGallery]::PostMessage($main,0x10,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null
 if(-not $process.WaitForExit(5000) -or $process.ExitCode -ne 0){throw 'Gallery did not exit normally'}
 @{status='passed';scope='Disposable instrumented cloud gallery; not user-device acceptance';pages=@($cases|ForEach-Object{$_.name});realProfileUsed=$false}|ConvertTo-Json -Depth 4|Set-Content -Encoding UTF8 (Join-Path $OutputDirectory 'GALLERY_RECEIPT.json')
} finally {
 if(-not $process.HasExited){Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue}
 $env:NIUMA_ACCEPTANCE_ROOT=$previous
 Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
