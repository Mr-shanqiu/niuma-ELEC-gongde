param(
  [Parameter(Mandatory = $true)][string]$ExecutablePath,
  [Parameter(Mandatory = $true)][string]$ScreenshotPath
)

$ErrorActionPreference = 'Stop'

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
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")]
  public static extern int GetSystemMetrics(int index);
}
'@

$process = Start-Process -FilePath $ExecutablePath `
  -ArgumentList @('--isolated-acceptance', '--reminder-ui-preview') `
  -WorkingDirectory (Split-Path -Parent $ExecutablePath) -PassThru
try {
  $pet = [IntPtr]::Zero
  $bubble = [IntPtr]::Zero
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ([DateTime]::UtcNow -lt $deadline) {
    $process.Refresh()
    if ($process.HasExited) { throw "Preview process exited early with code $($process.ExitCode)" }
    $pet = [NiuMaReminderPreviewWindows]::FindWindow('NiuMaMeritWindow', $null)
    $bubble = [NiuMaReminderPreviewWindows]::FindWindow('NiuMaMeritReminder', $null)
    if ($pet -ne [IntPtr]::Zero -and $bubble -ne [IntPtr]::Zero -and
        [NiuMaReminderPreviewWindows]::IsWindowVisible($pet) -and
        [NiuMaReminderPreviewWindows]::IsWindowVisible($bubble)) { break }
    Start-Sleep -Milliseconds 200
  }
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

  Add-Type -AssemblyName System.Drawing
  $screenWidth = [NiuMaReminderPreviewWindows]::GetSystemMetrics(0)
  $screenHeight = [NiuMaReminderPreviewWindows]::GetSystemMetrics(1)
  if ($screenWidth -le 0 -or $screenHeight -le 0) { throw 'The runner has no capturable display.' }
  $bitmap = New-Object System.Drawing.Bitmap($screenWidth, $screenHeight)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen(0, 0, 0, 0, $bitmap.Size)
    $bitmap.Save($ScreenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }

  if (-not $process.WaitForExit(20000)) { throw 'The preview app did not exit on its bounded acceptance timer.' }
  if ($process.ExitCode -ne 0) { throw "Preview process exited with code $($process.ExitCode)" }
  $statePath = Join-Path $acceptanceRoot 'data.ini'
  if (-not (Test-Path $statePath)) { throw 'The preview did not save its isolated state.' }
  $stateText = Get-Content -Raw -Path $statePath
  if ($stateText -notmatch '(?m)^total=0\s*$') {
    throw 'The isolated UI preview changed the merit total.'
  }
  Write-Output "WINDOWS_REMINDER_UI_PREVIEW_PASSED pet=$($petRect.Right - $petRect.Left)x$($petRect.Bottom - $petRect.Top) bubble=$($bubbleRect.Right - $bubbleRect.Left)x$($bubbleRect.Bottom - $bubbleRect.Top)"
} finally {
  $process.Refresh()
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item -Path $acceptanceRoot -Recurse -Force -ErrorAction SilentlyContinue
}
