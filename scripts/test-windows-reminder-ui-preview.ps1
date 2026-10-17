param(
  [Parameter(Mandatory = $true)][string]$ExecutablePath,
  [Parameter(Mandatory = $true)][string]$ScreenshotPath,
  [ValidateSet('Auto', 'Close')][string]$DismissMode = 'Auto'
)

$ErrorActionPreference = 'Stop'
$ExecutablePath = (Resolve-Path -LiteralPath $ExecutablePath).Path
$ScreenshotPath = [IO.Path]::GetFullPath($ScreenshotPath)
$diagnosticPath = [IO.Path]::ChangeExtension($ScreenshotPath, '.txt')
$previousAcceptanceRoot = $env:NIUMA_ACCEPTANCE_ROOT

$acceptanceRoot = Join-Path $env:TEMP ("NiuMaMerit-ReminderAcceptance-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $acceptanceRoot | Out-Null
$env:NIUMA_ACCEPTANCE_ROOT = $acceptanceRoot

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NiuMaReminderPreviewWindows {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr FindWindow(string className, string windowName);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  public static IntPtr FindProcessWindowByClass(string className, int expectedProcessId) {
    // PowerShell can coerce $null to an empty string for a string parameter.
    // Pass the title's null pointer inside C# so titled windows also match.
    IntPtr window = FindWindow(className, null);
    uint processId;
    GetWindowThreadProcessId(window, out processId);
    return processId == (uint)expectedProcessId ? window : IntPtr.Zero;
  }
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")]
  public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")]
  public static extern IntPtr GetDlgItem(IntPtr window, int item);
  [DllImport("user32.dll")]
  public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@

Add-Type -AssemblyName System.Drawing
function Save-PreviewScreenshot([string]$TargetPath) {
  $screenWidth = [NiuMaReminderPreviewWindows]::GetSystemMetrics(0)
  $screenHeight = [NiuMaReminderPreviewWindows]::GetSystemMetrics(1)
  if ($screenWidth -le 0 -or $screenHeight -le 0) { throw 'The runner has no capturable display.' }
  $bitmap = New-Object System.Drawing.Bitmap($screenWidth, $screenHeight)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen(0, 0, 0, 0, $bitmap.Size)
    $bitmap.Save($TargetPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }

}
$previewClock = [Diagnostics.Stopwatch]::StartNew()

$process = Start-Process -FilePath $ExecutablePath `
  -ArgumentList @('--isolated-acceptance', '--reminder-ui-preview') `
  -WorkingDirectory (Split-Path -Parent $ExecutablePath) -PassThru
$networkObserver = $null
try {
  $observerScript = Join-Path $PSScriptRoot 'check-runtime-network.py'
  $networkReport = [IO.Path]::ChangeExtension($ScreenshotPath, '.network.json')
  $networkObserver = Start-Process -FilePath (Get-Command python -ErrorAction Stop).Source `
    -ArgumentList @(('"' + $observerScript + '"'), '--pid', $process.Id, '--duration', '7',
      '--report', ('"' + $networkReport + '"')) -PassThru -NoNewWindow
  # Retain the process handle while it is alive. Windows PowerShell otherwise
  # may return a null ExitCode when WaitForExit first runs after a short child exits.
  $networkObserver.Handle | Out-Null
  $pet = [IntPtr]::Zero
  $bubble = [IntPtr]::Zero
  $deadline = [DateTime]::UtcNow.AddSeconds(6)
  while ([DateTime]::UtcNow -lt $deadline) {
    $process.Refresh()
    if ($process.HasExited) { throw "Preview process exited early with code $($process.ExitCode)" }
    $pet = [NiuMaReminderPreviewWindows]::FindProcessWindowByClass('NiuMaMeritWindow', $process.Id)
    $bubble = [NiuMaReminderPreviewWindows]::FindProcessWindowByClass('NiuMaMeritReminder', $process.Id)
    if ($pet -ne [IntPtr]::Zero -and $bubble -ne [IntPtr]::Zero -and
        [NiuMaReminderPreviewWindows]::IsWindowVisible($pet) -and
        [NiuMaReminderPreviewWindows]::IsWindowVisible($bubble)) { break }
    Start-Sleep -Milliseconds 200
  }
  $statusPath = Join-Path $acceptanceRoot 'preview-status.txt'
  if (Test-Path -LiteralPath $statusPath) {
    Copy-Item -LiteralPath $statusPath -Destination $diagnosticPath
    Get-Content -LiteralPath $diagnosticPath | Write-Output
  }
  Write-Output "preview_pid=$($process.Id) pet_handle=$pet bubble_handle=$bubble"

  Save-PreviewScreenshot $ScreenshotPath

  if ($pet -eq [IntPtr]::Zero -or $bubble -eq [IntPtr]::Zero -or
      -not [NiuMaReminderPreviewWindows]::IsWindowVisible($pet) -or
      -not [NiuMaReminderPreviewWindows]::IsWindowVisible($bubble)) {
    throw 'The isolated pet window and reminder bubble were not both visible.'
  }

  $petRect = New-Object NiuMaReminderPreviewWindows+RECT
  $bubbleRect = New-Object NiuMaReminderPreviewWindows+RECT
  if (-not [NiuMaReminderPreviewWindows]::GetWindowRect($pet, [ref]$petRect) -or
      -not [NiuMaReminderPreviewWindows]::GetWindowRect($bubble, [ref]$bubbleRect)) {
    throw 'Could not read the isolated preview window bounds.'
  }
  if ($petRect.Right -le $petRect.Left -or $petRect.Bottom -le $petRect.Top -or
      $bubbleRect.Right -le $bubbleRect.Left -or $bubbleRect.Bottom -le $bubbleRect.Top) {
    throw 'The isolated preview produced an empty window.'
  }

  if ($DismissMode -eq 'Close') {
    $closeButton = [NiuMaReminderPreviewWindows]::GetDlgItem($bubble, 4101)
    if ($closeButton -eq [IntPtr]::Zero) { throw 'The reminder close button is missing.' }
    [NiuMaReminderPreviewWindows]::SendMessage($closeButton, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  }
  $dismissDeadline = [DateTime]::UtcNow.AddSeconds($(if ($DismissMode -eq 'Auto') { 10 } else { 2 }))
  while ([NiuMaReminderPreviewWindows]::IsWindowVisible($bubble) -and [DateTime]::UtcNow -lt $dismissDeadline) {
    Start-Sleep -Milliseconds 100
    $process.Refresh()
    if ($process.HasExited) { throw 'The app exited before reminder dismissal could be verified.' }
  }
  if ([NiuMaReminderPreviewWindows]::IsWindowVisible($bubble)) { throw "Reminder did not dismiss in $DismissMode mode." }
  $process.Refresh()
  if ($process.HasExited) { throw 'The preview app must remain alive after the bubble closes.' }
  if ($DismissMode -eq 'Auto' -and $previewClock.Elapsed.TotalSeconds -lt 7) { throw 'The reminder auto-dismissed too early.' }
  Save-PreviewScreenshot ([IO.Path]::ChangeExtension($ScreenshotPath, '.dismissed.png'))

  if (-not $process.WaitForExit(20000)) { throw 'The preview app did not exit on its bounded acceptance timer.' }
  if ($process.ExitCode -ne 0) { throw "Preview process exited with code $($process.ExitCode)" }
  $observerExited = $networkObserver.WaitForExit(10000)
  if (-not $observerExited -or $null -eq $networkObserver.ExitCode -or $networkObserver.ExitCode -ne 0) {
    throw "Runtime endpoint sampling failed: exited=$observerExited exit_code=$($networkObserver.ExitCode)"
  }
  $networkResult = Get-Content -Raw -LiteralPath $networkReport | ConvertFrom-Json
  if ($networkResult.status -ne 'passed' -or $networkResult.samples -lt 3 -or
      $networkResult.detected_endpoints -ne 0) { throw 'Runtime endpoint report failed its assertions.' }
  $statePath = Join-Path $acceptanceRoot 'data.ini'
  if (-not (Test-Path $statePath)) { throw 'The preview did not save its isolated state.' }
  $stateText = Get-Content -Raw -Path $statePath
  if ($stateText -notmatch '(?m)^total=0\s*$') {
    throw 'The isolated UI preview changed the merit total.'
  }
  $historyText = Get-Content -Raw -LiteralPath (Join-Path $acceptanceRoot 'Reminders\state.dat')
  if ($historyText -notmatch '(?m)^daily\t[0-9]{4}-[0-9]{2}-[0-9]{2}\t1$' -or
      $historyText -notmatch '(?m)^segment\t1$' -or
      [regex]::Matches($historyText, '(?m)^id\t').Count -ne 1) {
    throw 'Closing the reminder changed the reserved quota, segment lock, or ID history.'
  }
  Write-Output "WINDOWS_REMINDER_UI_PREVIEW_PASSED dismiss=$DismissMode quota=1 history=1 pet=$($petRect.Right - $petRect.Left)x$($petRect.Bottom - $petRect.Top) bubble=$($bubbleRect.Right - $bubbleRect.Left)x$($bubbleRect.Bottom - $bubbleRect.Top)"
} finally {
  if ($null -ne $networkObserver) {
    $networkObserver.Refresh()
    if (-not $networkObserver.HasExited) { Stop-Process -Id $networkObserver.Id -Force -ErrorAction SilentlyContinue }
  }
  $process.Refresh()
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  $env:NIUMA_ACCEPTANCE_ROOT = $previousAcceptanceRoot
  Remove-Item -Path $acceptanceRoot -Recurse -Force -ErrorAction SilentlyContinue
}
