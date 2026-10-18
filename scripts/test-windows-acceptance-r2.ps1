param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$ClientPath,
  [Parameter(Mandatory = $true)][string]$EvidenceDirectory,
  [ValidateSet('R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8')][string]$CandidateRevision = 'R2',
  [switch]$RequireSinglePage
)

# All installation, registry and input-listener checks are confined to a disposable runner.
$CandidateLabel = '牛马电子功德【综合验收·' + $CandidateRevision + '】'
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'An ephemeral GitHub runner is required.' }
$InstallerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
$expected = (Get-FileHash -LiteralPath $ClientPath -Algorithm SHA256).Hash
New-Item -ItemType Directory -Force -Path $EvidenceDirectory | Out-Null
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
Add-Type @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public class R2Window {
  public IntPtr Handle; public string ClassName;
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  public static R2Window[] ForProcess(int target) {
    var result = new List<R2Window>();
    EnumWindows((h,l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == target && IsWindowVisible(h)) {
        var name = new StringBuilder(256); GetClassName(h, name, 256);
        result.Add(new R2Window {Handle=h, ClassName=name.ToString()});
      }
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
}
'@
function Save-Screen([string]$Name) {
  $bitmap = New-Object Drawing.Bitmap([R2Window]::GetSystemMetrics(0), [R2Window]::GetSystemMetrics(1))
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen(0, 0, 0, 0, $bitmap.Size)
    $bitmap.Save((Join-Path $EvidenceDirectory $Name), [Drawing.Imaging.ImageFormat]::Png)
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
}
function Click-Control($Control) {
  if ($Control.Current.NativeWindowHandle -eq 0) { throw 'Control has no native handle.' }
  [R2Window]::SendMessage([IntPtr]$Control.Current.NativeWindowHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
}
function Visible-Controls($Window) {
  @($Window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition) |
    Where-Object { -not $_.Current.IsOffscreen })
}
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$data = Join-Path $env:LOCALAPPDATA 'NiuMaMerit/data.ini'
if ((Test-Path $data) -or (Get-Process -Name niuma-merit -ErrorAction SilentlyContinue)) { throw 'Runner profile must be clean.' }
New-Item -ItemType Directory -Force -Path (Split-Path $data) | Out-Null
# Sentinel records prove installing the preference preserves unrelated user state.
Set-Content -LiteralPath $data -Value "[state]`r`ntotal=73`r`n[acceptance_sentinel]`r`nkeep=unchanged" -Encoding Unicode
$pages = @()
$cases = @()

foreach ($case in @(
    @{name='default-enabled'; language='default'; initial=$true; selected=$true},
    @{name='chinese-opt-out'; language='chinesesimp'; initial=$true; selected=$false},
    @{name='traditional-chinese'; language='chinesetraditional'; initial=$false; selected=$false}
)) {
  $destination = Join-Path $env:RUNNER_TEMP ('NiuMaMerit-R2-' + $case.name)
  $arguments = @('/NORESTART', '/SP-', ('/DIR="' + $destination + '"'))
  if ($case.language -ne 'default') { $arguments += '/LANG=' + $case.language }
  $setup = Start-Process $InstallerPath -ArgumentList $arguments -PassThru
  $setup.Handle | Out-Null
  try {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    $wizard = $null
    do {
      $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ClassNameProperty, 'TWizardForm')
      $wizard = [Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Children, $condition)
      if ($null -eq $wizard) { Start-Sleep -Milliseconds 200 }
    } while ($null -eq $wizard -and [DateTime]::UtcNow -lt $deadline)
    if ($null -eq $wizard) { throw 'Installer window not found.' }
    $checked = $false; $installed = $false
    for ($index=0; $index -lt 6; $index++) {
      Start-Sleep -Milliseconds 400
      $controls = @(Visible-Controls $wizard)
      $captions = @($controls | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
      if (($captions -join "`n") -match '桌面快捷|desktop shortcut|Three Things|三件事') { throw 'Unwanted onboarding option.' }
      $checkbox = @($controls | Where-Object { $_.Current.Name -match '^(登录后自动启动|Start automatically when I sign in)$' })
      if ($checkbox.Count -eq 1) {
        if (($captions -join "`n") -notmatch '(安装包：|Installer: )\d+\.\d MB') { throw 'Installer size is missing from the destination page.' }
        if ($checked) { throw 'Startup choice shown on more than one page.' }
        $state = [R2Window]::SendMessage([IntPtr]$checkbox[0].Current.NativeWindowHandle, 0x00F0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
        if (($state -eq 1) -ne $case.initial) { throw 'Installer ignored the default or previous choice.' }
        if (($state -eq 1) -ne $case.selected) { Click-Control $checkbox[0] }
        if ($case.language -eq 'chinesetraditional' -and $checkbox[0].Current.Name -ne '登录后自动启动') { throw 'Traditional Chinese language fell back to English.' }
        $checked = $true
        $state = [R2Window]::SendMessage([IntPtr]$checkbox[0].Current.NativeWindowHandle, 0x00F0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
        if (($state -eq 1) -ne $case.selected) { throw 'Startup checkbox failed to change.' }
      }
      $pages += @{case=$case.name; page=$index; captions=$captions}
      $pages | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $EvidenceDirectory 'PAGES.json')
      Save-Screen ($case.name + '-' + $index + '.png')
      $buttons = @($controls | Where-Object { $_.Current.NativeWindowHandle -ne 0 -and $_.Current.IsEnabled })
      $install = @($buttons | Where-Object { ($_.Current.Name -replace '&','') -match '^(Install|安装)(\([A-Z]\))?$' })
      if ($install.Count -eq 1) {
        if (-not $checked) { throw 'Installation reached without the startup choice.' }
        if ($RequireSinglePage -and ($index -ne 0 -or $checkbox.Count -ne 1)) { throw 'Install must be available directly on the first destination/startup page.' }
        Click-Control $install[0]; $installed=$true; break
      }
      if ($RequireSinglePage) { throw 'The first page should have Install instead of Next; no separate confirmation is allowed.' }
      $next = @($buttons | Where-Object { ($_.Current.Name -replace '&','') -match '^(Next|下一步)' })
      if ($next.Count -ne 1) { throw 'Next button missing.' }
      Click-Control $next[0]
    }
    if (-not $installed) { throw 'Interactive install not started.' }
    if (-not $setup.WaitForExit(30000)) { Save-Screen ($case.name + '-unfinished.png'); throw 'Installation required another action.' }
    if ($setup.ExitCode -ne 0) { throw 'Interactive installation failed.' }
    $client = Join-Path $destination 'niuma-merit.exe'
    if ((Get-FileHash $client -Algorithm SHA256).Hash -ne $expected) { throw 'Installed binary mismatch.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      $running = @(Get-Process -Name niuma-merit -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $client })
      if ($running.Count -eq 0) { Start-Sleep -Milliseconds 200 }
    } while ($running.Count -eq 0 -and [DateTime]::UtcNow -lt $deadline)
    if ($running.Count -ne 1) { throw 'Installation did not automatically launch exactly one client.' }
    Start-Sleep -Seconds 2
    $windows = @([R2Window]::ForProcess($running[0].Id))
    if (@($windows | Where-Object { $_.ClassName -eq '#32770' }).Count -ne 0) { throw 'Unexpected first-use modal.' }
    $main = @($windows | Where-Object { $_.ClassName -eq 'NiuMaMeritWindow' })
    if ($main.Count -ne 1) { throw 'Main companion window is not visible.' }
    Save-Screen ($case.name + '-first-launch.png')
    $run = (Get-ItemProperty $runKey -Name NiuMaMerit -ErrorAction SilentlyContinue).NiuMaMerit
    if ($case.selected) {
      if ($run -ne ('"' + $client + '" --listener-acceptance --diagnostics --autostart')) { throw 'Startup command mismatch.' }
    } elseif ($null -ne $run) { throw 'Opt-out did not remove startup.' }
    $content = Get-Content -LiteralPath $data -Raw
    if ($content -notmatch ('autostart_enabled=' + [int]$case.selected) -or $content -notmatch 'autostart_configured=1' -or $content -notmatch 'keep=unchanged') { throw 'Preference or unrelated state lost.' }
    [R2Window]::PostMessage($main[0].Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    if (-not $running[0].WaitForExit(10000)) { throw 'Client did not exit normally.' }
    # Exercise normal startup without the acceptance guard: a disabled preference must stay off.
    $restart = Start-Process $client -PassThru
    $restart.Handle | Out-Null
    Start-Sleep -Seconds 2
    if ($restart.HasExited) { throw 'Client exited unexpectedly on restart.' }
    $run = (Get-ItemProperty $runKey -Name NiuMaMerit -ErrorAction SilentlyContinue).NiuMaMerit
    if ((-not $case.selected) -and $null -ne $run) { throw 'Restart silently re-enabled startup.' }
    $windows = @([R2Window]::ForProcess($restart.Id))
    if (@($windows | Where-Object { $_.ClassName -eq '#32770' }).Count -ne 0) { throw 'Restart displayed onboarding.' }
    $main = @($windows | Where-Object { $_.ClassName -eq 'NiuMaMeritWindow' })
    if ($main.Count -ne 1) { throw 'Restart window missing.' }
    [R2Window]::PostMessage($main[0].Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    if (-not $restart.WaitForExit(10000)) { throw 'Restarted client did not exit.' }
    foreach ($desktop in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'))) {
      if (Test-Path (Join-Path $desktop ($CandidateLabel + '.lnk'))) { throw 'Desktop shortcut created.' }
    }
    $cases += @{case=$case.name; selected=$case.selected; installed=$true; autoLaunched=$true; noFirstUseModal=$true; restartPreservedChoice=$true}
  } finally {
    if (-not $setup.HasExited) { & taskkill /PID $setup.Id /T /F | Out-Null }
    Get-Process -Name niuma-merit -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
}
# A later installer visit must also retain the user's previous opt-out.
$probe = Start-Process $InstallerPath -ArgumentList @('/NORESTART','/SP-') -PassThru
$probe.Handle | Out-Null
try {
  Start-Sleep -Seconds 2
  $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ClassNameProperty, 'TWizardForm')
  $wizard = [Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Children, $condition)
  if ($null -eq $wizard) { throw 'Upgrade probe window missing.' }
  $checkbox = @((Visible-Controls $wizard) | Where-Object { $_.Current.Name -match '^(登录后自动启动|Start automatically when I sign in)$' })
  if ($checkbox.Count -ne 1 -or [R2Window]::SendMessage([IntPtr]$checkbox[0].Current.NativeWindowHandle, 0x00F0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32() -ne 0) { throw 'Upgrade ignored the previous opt-out.' }
} finally {
  if (-not $probe.HasExited) { & taskkill /PID $probe.Id /T /F | Out-Null }
}
@{status='passed'; cases=$cases; upgradePreservedOptOut=$true; singlePreInstallPage=[bool]$RequireSinglePage; userDevicesTouched=$false; scope='Disposable Windows runner; real device input/import/security prompts remain pending.'} |
  ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $EvidenceDirectory 'JOURNEY_RECEIPT.json')
