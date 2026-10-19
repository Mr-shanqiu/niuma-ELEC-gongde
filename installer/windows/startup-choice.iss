; Shared by production and labelled acceptance installers.
#ifndef StartupArguments
  #define StartupArguments ""
#endif

[Setup]
DisableReadyPage=yes

[CustomMessages]
english.StartAtLogin=Start automatically when I sign in
chinesesimp.StartAtLogin=登录后自动启动
chinesetraditional.StartAtLogin=登录后自动启动
english.LocalOnly=Runs locally. No internet connection required.
chinesesimp.LocalOnly=本地运行，无需联网。
chinesetraditional.LocalOnly=本地运行，无需联网。
english.InstallerSize=Installer: %1 MB
chinesesimp.InstallerSize=安装包：%1 MB
chinesetraditional.InstallerSize=安装包：%1 MB

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "NiuMaMerit"; ValueData: """{app}\niuma-merit.exe""{#StartupArguments} --autostart"; Check: StartAtLoginSelected
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "NiuMaMerit"; Flags: deletevalue; Check: StartAtLoginNotSelected

[INI]
Filename: "{localappdata}\NiuMaMerit\data.ini"; Section: "state"; Key: "autostart_configured"; String: "1"
Filename: "{localappdata}\NiuMaMerit\data.ini"; Section: "state"; Key: "autostart_enabled"; String: "{code:StartAtLoginPreference}"

[Code]
var
  StartAtLoginCheckbox: TNewCheckBox;
  LocalOnlyLabel: TNewStaticText;
  RetainedRunCommand: String;

procedure InitializeWizard;
var
  PreferenceFile: String;
  PackageSize: Int64;
begin
  WizardForm.Font.Name := 'Segoe UI';
  WizardForm.Font.Size := 10;
  WizardForm.Color := $00F7F5F5;
  PreferenceFile := ExpandConstant('{localappdata}\NiuMaMerit\data.ini');
  StartAtLoginCheckbox := TNewCheckBox.Create(WizardForm);
  StartAtLoginCheckbox.Parent := WizardForm.SelectDirPage;
  StartAtLoginCheckbox.Left := WizardForm.DirEdit.Left;
  StartAtLoginCheckbox.Top := WizardForm.DirEdit.Top + WizardForm.DirEdit.Height + ScaleY(24);
  StartAtLoginCheckbox.Width := WizardForm.SelectDirPage.ClientWidth - StartAtLoginCheckbox.Left;
  StartAtLoginCheckbox.Height := ScaleY(22);
  StartAtLoginCheckbox.Caption := CustomMessage('StartAtLogin');
  { New installations default on; upgrades keep the user's saved choice. }
  StartAtLoginCheckbox.Checked := GetIniString('state', 'autostart_enabled', '1', PreferenceFile) <> '0';
  LocalOnlyLabel := TNewStaticText.Create(WizardForm);
  LocalOnlyLabel.Parent := WizardForm.SelectDirPage;
  LocalOnlyLabel.Left := StartAtLoginCheckbox.Left;
  LocalOnlyLabel.Top := StartAtLoginCheckbox.Top + StartAtLoginCheckbox.Height + ScaleY(12);
  LocalOnlyLabel.Font.Color := $0076766E;
  LocalOnlyLabel.Caption := CustomMessage('LocalOnly');
  if FileSize64(ExpandConstant('{srcexe}'), PackageSize) then
    LocalOnlyLabel.Caption := FmtMessage(CustomMessage('InstallerSize'), [Format('%.1f', [PackageSize / 1000000.0])]) + ' · ' + LocalOnlyLabel.Caption;
end;

function StartAtLoginSelected: Boolean;
begin
  Result := StartAtLoginCheckbox.Checked;
end;

function StartAtLoginNotSelected: Boolean;
begin
  Result := not StartAtLoginSelected;
end;

function StartAtLoginPreference(Param: String): String;
begin
  if StartAtLoginSelected then Result := '1' else Result := '0';
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  { The destination/startup page is the final choice before installation. }
  if CurPageID = wpSelectDir then
    WizardForm.NextButton.Caption := SetupMessage(msgButtonInstall);
end;


function CommandBelongsToApp(Command: String): Boolean;
var
  Executable: String;
  EndQuote: Integer;
begin
  Command := Trim(Command);
  Result := False;
  if Command = '' then exit;
  if Command[1] = '"' then begin
    Delete(Command, 1, 1);
    EndQuote := Pos('"', Command);
    if EndQuote = 0 then exit;
    Executable := Copy(Command, 1, EndQuote - 1);
  end else begin
    { The client always writes a quoted path. Also accept an exact bare path. }
    Executable := Command;
  end;
  Result := CompareText(Executable, ExpandConstant('{app}\niuma-merit.exe')) = 0;
end;

procedure RemoveOwnedAssociation(Extension, ProgID: String);
var
  Command, RegisteredID: String;
  Key: String;
begin
  Key := 'Software\Classes\' + ProgID;
  if RegQueryStringValue(HKCU, Key + '\shell\open\command', '', Command) and
      CommandBelongsToApp(Command) then begin
    if RegQueryStringValue(HKCU, 'Software\Classes\' + Extension, '', RegisteredID) and
        (CompareText(RegisteredID, ProgID) = 0) then begin
      RegDeleteValue(HKCU, 'Software\Classes\' + Extension, '');
      RegDeleteKeyIfEmpty(HKCU, 'Software\Classes\' + Extension);
    end;
    RegDeleteKeyIncludingSubkeys(HKCU, Key);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Command: String;
begin
  { Older installations may have appended an unconditional Run deletion to
    the uninstall log. Preserve a retained copy across that legacy action. }
  if CurUninstallStep = usPostUninstall then begin
    if (RetainedRunCommand <> '') and
        not RegValueExists(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'NiuMaMerit') then
      RegWriteStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run',
          'NiuMaMerit', RetainedRunCommand);
    exit;
  end;
  if CurUninstallStep <> usUninstall then exit;
  RetainedRunCommand := '';
  if RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run',
      'NiuMaMerit', Command) and not CommandBelongsToApp(Command) then
    RetainedRunCommand := Command;
  if RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run',
      'NiuMaMerit', Command) and CommandBelongsToApp(Command) then
    RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'NiuMaMerit');
  RemoveOwnedAssociation('.nmgpack', 'NiuMaMerit.AppearancePack');
  RemoveOwnedAssociation('.nmgpacks', 'NiuMaMerit.AppearanceBatch');
  RemoveOwnedAssociation('.nmgtext', 'NiuMaMerit.MessageCatalog');
end;
