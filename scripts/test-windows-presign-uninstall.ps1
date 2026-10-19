param([string]$Installer, [string]$Helper, [string]$Output)
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This integration test requires a disposable GitHub runner profile' }
$Installer=(Resolve-Path $Installer).Path
$Helper=(Resolve-Path $Helper).Path
New-Item -ItemType Directory -Force $Output | Out-Null
$Output=(Resolve-Path $Output).Path
$data=Join-Path $env:LOCALAPPDATA 'NiuMaMerit'
if(Test-Path $data){throw 'Unexpected existing product profile; refusing to overwrite'}
New-Item -ItemType Directory $data | Out-Null
$ini=Join-Path $data 'data.ini'
$run=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
$classes=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Classes')
$types=@{'.nmgpack'='NiuMaMerit.AppearancePack';'.nmgpacks'='NiuMaMerit.AppearanceBatch';'.nmgtext'='NiuMaMerit.MessageCatalog'}
# Reproduce an older installer's unconditional startup uninstall-log entry.
$iscc="${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
$legacySource=Join-Path $Output 'legacy-startup.iss'
$client=(Resolve-Path 'final-output/niuma-merit.exe').Path
$shared=Get-Content -Raw -Encoding UTF8 'installer/windows/startup-choice.iss'
$shared=$shared.Substring(0,$shared.IndexOf('function CommandBelongsToApp'))
$shared=$shared.Replace('; Check: StartAtLoginSelected','; Flags: uninsdeletevalue; Check: StartAtLoginSelected')
$legacyShared=Join-Path $Output 'legacy-startup-choice.iss'
$shared | Set-Content -Encoding UTF8 $legacyShared
# Use the production architecture, identity and languages. A 32-bit stub
# creates a separate uninstaller and does not model the real upgrade path.
$template=Get-Content -Raw -Encoding UTF8 'installer/windows/niuma-merit.iss'
$template=$template.Replace('..\..\dist\{#MyAppExeName}',$client)
$template=$template.Replace('languages\ChineseSimplified.isl',(Resolve-Path 'installer/windows/languages/ChineseSimplified.isl').Path)
$template=$template.Replace('#include "startup-choice.iss"',('#include "'+$legacyShared+'"'))
$template | Set-Content -Encoding UTF8 $legacySource
& $iscc '/DMyAppVersion=0.9.3' "/O$Output" '/Flegacy-startup' $legacySource
if($LASTEXITCODE -ne 0){throw 'Legacy uninstall-log fixture did not compile'}
$results=@()
function Check($condition,$reason){if(-not $condition){throw $reason}}
for($scenario=1;$scenario -le 3;$scenario++){
  $choice=if($scenario -eq 2){'0'}else{'1'}
  Set-Content -LiteralPath $ini -Value "[state]`nautostart_enabled=$choice`n[ daily-preserved ]`nsentinel=617" -Encoding ascii
  $sentinel=Join-Path $data 'history-preserved.txt'
  Set-Content $sentinel 'Do not remove user records or packs'
  $dir=Join-Path $Output "installed-$scenario"
  if($scenario -eq 3){
    $p=Start-Process (Join-Path $Output 'legacy-startup.exe') -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',"/DIR=`"$dir`"") -PassThru -Wait
    Check ($p.ExitCode -eq 0) 'Legacy install failed'
  }
  $p=Start-Process $Installer -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',"/DIR=`"$dir`"","/LOG=`"$Output\install-$scenario.log`"") -PassThru -Wait
  Check ($p.ExitCode -eq 0) 'Install failed'
  $exe=Join-Path $dir 'niuma-merit.exe'
  & $Helper --register $exe
  Check ($LASTEXITCODE -eq 0) 'Production association registration failed'
  if($scenario -eq 2){
    Check ($null -eq $run.GetValue('NiuMaMerit')) 'Unchecked startup choice was ignored'
    # State produced by subsequently enabling startup in the application.
    $run.SetValue('NiuMaMerit',"`"$exe`" --autostart")
    $key=$classes.CreateSubKey('.nmgtext');$key.SetValue('','Foreign.MessageCatalog');$key.Close()
  }
  if($scenario -eq 3){
    $foreign='C:\RetainedCopy\niuma-merit.exe'
    $run.SetValue('NiuMaMerit',"`"$foreign`" --autostart")
    & $Helper --register $foreign
    Check ($LASTEXITCODE -eq 0) 'Retained-copy fixture failed'
  }
  $iniBefore=(Get-FileHash $ini).Hash
  $registration=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall\{D1B9D81E-13A1-45E2-9B8F-33C9C7A06F27}_is1')
  Check ($null -ne $registration) 'Installed application uninstall registration is missing'
  $uninstaller=$registration.GetValue('UninstallString').Trim('"')
  $registration.Close()
  Check ((Test-Path $uninstaller) -and $uninstaller.StartsWith($dir)) 'Unexpected registered uninstaller'
  $p=Start-Process $uninstaller -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',"/LOG=`"$Output\uninstall-$scenario.log`"") -PassThru -Wait
  Check ($p.ExitCode -eq 0) 'Uninstall failed'
  Check (-not (Test-Path $exe)) 'Installed executable survived uninstall'
  Check ((Test-Path $sentinel) -and ((Get-FileHash $ini).Hash -eq $iniBefore)) 'User data was changed by uninstall'
  if($scenario -eq 3){
    Check ($run.GetValue('NiuMaMerit') -eq "`"$foreign`" --autostart") 'Another copy startup was removed'
  }else{Check ($null -eq $run.GetValue('NiuMaMerit')) 'Owned startup survived uninstall'}
  foreach($ext in $types.Keys){
    $id=$types[$ext]
    $key=$classes.OpenSubKey($id+'\shell\open\command')
    if($scenario -eq 3){
      Check ($null -ne $key) 'Retained-copy ProgID removed'
      Check ($key.GetValue('') -eq "`"$foreign`" `"%1`"") 'Retained-copy command changed'
    }else{Check ($null -eq $key) 'Owned ProgID survived'}
    if($key){$key.Close()}
    $key=$classes.OpenSubKey($ext)
    $value=if($key){$key.GetValue('')}else{$null}
    if($scenario -eq 3){Check ($value -eq $id) 'Retained-copy extension removed'}
    elseif($scenario -eq 2 -and $ext -eq '.nmgtext'){Check ($value -eq 'Foreign.MessageCatalog') 'Foreign extension owner removed'}
    else{Check ($null -eq $value) 'Owned extension survived'}
    if($key){$key.Close()}
  }
  $results+=@{scenario=$scenario;status='passed';data_preserved=$true;client_launched=$false;legacy_upgrade=($scenario -eq 3)}
  $run.DeleteValue('NiuMaMerit',$false)
  foreach($ext in $types.Keys){$classes.DeleteSubKeyTree($ext,$false);$classes.DeleteSubKeyTree($types[$ext],$false)}
}
$run.Close();$classes.Close()
$results | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $Output 'UNINSTALL_RESULT.json')
Write-Output 'PASS: actual final installer/uninstaller: startup on, off-then-enabled, foreign copy ownership, all three associations, user data preserved. No client launched.'
