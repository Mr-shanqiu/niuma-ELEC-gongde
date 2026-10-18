; Shared by the production installer and the explicitly labelled R2 candidate.
#ifndef StartupArguments
  #define StartupArguments ""
#endif

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
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "NiuMaMerit"; ValueData: """{app}\niuma-merit.exe""{#StartupArguments} --autostart"; Flags: uninsdeletevalue; Check: StartAtLoginSelected
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "NiuMaMerit"; Flags: deletevalue; Check: StartAtLoginNotSelected

[INI]
Filename: "{localappdata}\NiuMaMerit\data.ini"; Section: "state"; Key: "autostart_configured"; String: "1"
Filename: "{localappdata}\NiuMaMerit\data.ini"; Section: "state"; Key: "autostart_enabled"; String: "{code:StartAtLoginPreference}"

[Code]
var
  StartAtLoginCheckbox: TNewCheckBox;
  LocalOnlyLabel: TNewStaticText;

procedure InitializeWizard;
var
  PreferenceFile: String;
  PackageSize: Int64;
begin
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
