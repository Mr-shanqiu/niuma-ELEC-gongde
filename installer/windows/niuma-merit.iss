#ifndef MyAppVersion
  #error MyAppVersion must be supplied from the repository VERSION file
#endif

#define MyAppName "牛马电子功德"
#define MyAppPublisher "牛马电子功德"
#define MyAppURL "https://gongde.zqscreen.cn/"
#define MyAppExeName "niuma-merit.exe"

[Setup]
AppId={{D1B9D81E-13A1-45E2-9B8F-33C9C7A06F27}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}contact.html
AppUpdatesURL={#MyAppURL}
DefaultDirName={localappdata}\Programs\NiumaMerit
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableFinishedPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\..\dist
OutputBaseFilename=niuma-merit-windows-{#MyAppVersion}-setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}
VersionInfoVersion={#MyAppVersion}.0
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} Windows 安装程序
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion}

ShowLanguageDialog=no
LanguageDetectionMethod=uilanguage

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimp"; MessagesFile: "languages\ChineseSimplified.isl"

[CustomMessages]
chinesesimp.LaunchApp=启动%1
english.LaunchApp=Launch %1

[Files]
Source: "..\..\dist\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"

[Run]
Filename: "{app}\{#MyAppExeName}"; Flags: nowait skipifsilent

#include "startup-choice.iss"
