#ifndef ClientExecutable
  #error A verified frozen ClientExecutable must be supplied
#endif
#ifndef AcceptanceOutputDir
  #error AcceptanceOutputDir must be supplied
#endif

[Setup]
AppId=NiuMaMeritUnifiedAcceptance-20261018-R1
AppName=牛马电子功德【综合验收·R1】
AppVersion=0.9.4
AppPublisher=NiuMa Merit
DefaultDirName={localappdata}\Programs\NiuMaMeritUnifiedAcceptance-20261018-R1
DefaultGroupName=牛马电子功德【综合验收·R1】
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#AcceptanceOutputDir}
OutputBaseFilename=牛马电子功德-Windows-0.9.4-综合验收-20261018-R1-安装包
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\niuma-merit.exe
VersionInfoVersion=0.9.4.0
VersionInfoDescription=牛马电子功德综合验收R1安装程序
ShowLanguageDialog=no
LanguageDetectionMethod=uilanguage

[Languages]
Name: "chinesesimp"; MessagesFile: "languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; Flags: checkedonce

[Files]
Source: "{#ClientExecutable}"; DestDir: "{app}"; DestName: "niuma-merit.exe"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\牛马电子功德【综合验收·R1】"; Filename: "{app}\niuma-merit.exe"; Parameters: "--listener-acceptance --diagnostics"
Name: "{autodesktop}\牛马电子功德【综合验收·R1】"; Filename: "{app}\niuma-merit.exe"; Parameters: "--listener-acceptance --diagnostics"; Tasks: desktopicon

[Run]
Filename: "{app}\niuma-merit.exe"; Parameters: "--listener-acceptance --diagnostics"; Description: "{cm:LaunchProgram,牛马电子功德【综合验收·R1】}"; Flags: nowait postinstall skipifsilent
