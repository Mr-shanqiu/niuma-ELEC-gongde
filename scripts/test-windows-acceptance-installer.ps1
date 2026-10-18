param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$EvidenceDirectory
)

# Run only on an ephemeral Windows CI runner, never on the user's computer.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This check requires an ephemeral GitHub runner.' }
$InstallerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
$EvidenceDirectory = [IO.Path]::GetFullPath($EvidenceDirectory)
New-Item -ItemType Directory -Force -Path $EvidenceDirectory | Out-Null
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SetupCheckWindow {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
}
'@

function Save-Screen([string]$Name) {
  $bitmap = New-Object Drawing.Bitmap([SetupCheckWindow]::GetSystemMetrics(0), [SetupCheckWindow]::GetSystemMetrics(1))
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen(0, 0, 0, 0, $bitmap.Size)
    $bitmap.Save((Join-Path $EvidenceDirectory $Name), [Drawing.Imaging.ImageFormat]::Png)
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
}

$pages = @()
foreach ($language in @('default', 'chinesesimp')) {
  $arguments = @('/NORESTART', '/SP-')
  if ($language -ne 'default') { $arguments += "/LANG=$language" }
  $process = Start-Process -FilePath $InstallerPath -ArgumentList $arguments -PassThru
  $process.Handle | Out-Null
  try {
    $window = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
      $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ClassNameProperty, 'TWizardForm')
      $window = [Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Children, $condition)
      if ($null -eq $window) { Start-Sleep -Milliseconds 200 }
    } while ($null -eq $window -and [DateTime]::UtcNow -lt $deadline)
    if ($null -eq $window) {
      Save-Screen "$language-window-not-found.png"
      throw 'The installer did not show its main wizard.'
    }
    if ($window.Current.Name -notmatch 'R1') { throw 'Unexpected installer window.' }
    [SetupCheckWindow]::SetForegroundWindow([IntPtr]$window.Current.NativeWindowHandle) | Out-Null
    $ready = $false
    for ($index = 0; $index -lt 8; $index++) {
      Start-Sleep -Milliseconds 500
      $controls = @($window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition) |
        Where-Object { -not $_.Current.IsOffscreen })
      $captions = @($controls | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
      $pages += @{ language = $language; page = $index; captions = $captions }
      Save-Screen "$language-$index.png"
      $pages | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $EvidenceDirectory 'WIZARD_PAGES.json')
      if (($captions -join "`n") -match '桌面快捷|desktop shortcut|Select Additional Tasks|选择附加任务') {
        throw 'Desktop shortcut or obsolete task page is still visible.'
      }
      $buttons = @($controls | Where-Object {
        $_.Current.NativeWindowHandle -ne 0 -and $_.Current.IsEnabled
      })
      $install = @($buttons | Where-Object { ($_.Current.Name -replace '&','') -match '^(Install|安装)(\([A-Z]\))?$' })
      if ($install.Count -eq 1) { $ready = $true; break }
      $next = @($buttons | Where-Object { ($_.Current.Name -replace '&','') -match '^(Next|下一步)' })
      if ($next.Count -ne 1) { throw 'Expected one Next button before installation.' }
      [SetupCheckWindow]::SendMessage([IntPtr]$next[0].Current.NativeWindowHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    }
    if (-not $ready) { throw 'The wizard did not reach its pre-installation confirmation.' }
  } finally {
    # No install button is clicked in the visible wizard check.
    if (-not $process.HasExited) { & taskkill /PID $process.Id /T /F | Out-Null }
  }
}

$pages | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $EvidenceDirectory 'WIZARD_PAGES.json')
$destination = Join-Path $env:RUNNER_TEMP 'NiuMaMerit-SetupSmoke'
$shortcutName = '牛马电子功德【综合验收·R1】.lnk'
$desktops = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'))
foreach ($desktop in $desktops) {
  if (Test-Path -LiteralPath (Join-Path $desktop $shortcutName)) { throw 'Runner desktop is not clean.' }
}
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runBefore = (Get-ItemProperty -LiteralPath $runKey -Name NiuMaMerit -ErrorAction SilentlyContinue).NiuMaMerit
$installed = Start-Process -FilePath $InstallerPath -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', ('/DIR="' + $destination + '"')) -PassThru -Wait
if ($installed.ExitCode -ne 0) { throw "Silent install failed: $($installed.ExitCode)" }
$client = Join-Path $destination 'niuma-merit.exe'
if ((Get-FileHash -LiteralPath $client -Algorithm SHA256).Hash.ToLowerInvariant() -ne '26604b166e58cb40c145b46326c54bb50ebfafafbc2b9b762294110de4762c2b') {
  throw 'Installed client differs from frozen R1.'
}
foreach ($desktop in $desktops) {
  if (Test-Path -LiteralPath (Join-Path $desktop $shortcutName)) { throw 'Installer created a desktop shortcut.' }
}
$runAfter = (Get-ItemProperty -LiteralPath $runKey -Name NiuMaMerit -ErrorAction SilentlyContinue).NiuMaMerit
if ($runBefore -ne $runAfter) { throw 'Acceptance installer unexpectedly changed login startup.' }
if (Get-Process -Name niuma-merit -ErrorAction SilentlyContinue) { throw 'Silent install unexpectedly launched the client.' }
@{
  status = 'passed'
  wizardLanguages = @('runner-default-English', 'explicit-simplified-Chinese')
  preinstallPages = $pages.Count
  desktopShortcutCreated = $false
  clientSha256 = (Get-FileHash -LiteralPath $client -Algorithm SHA256).Hash.ToLowerInvariant()
  clientLaunched = $false
  loginStartupChanged = $false
  scope = 'Pre-install wizard and silent payload installation only; interactive completion and first launch remain pending.'
} | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $EvidenceDirectory 'SETUP_CHECK_RECEIPT.json')
