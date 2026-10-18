#ifndef ClientExecutable
  #error A verified frozen ClientExecutable must be supplied
#endif
#ifndef AcceptanceOutputDir
  #error AcceptanceOutputDir must be supplied
#endif

[Setup]
AppId=NiuMaMeritUnifiedAcceptance-20261018-R2
AppName=牛马电子功德【综合验收·R2】
AppVersion=0.9.4
AppPublisher=NiuMa Merit
DefaultDirName={localappdata}\Programs\NiuMaMeritUnifiedAcceptance-20261018-R2
DefaultGroupName=牛马电子功德【综合验收·R2】
DisableProgramGroupPage=yes
DisableDirPage=no
DisableFinishedPage=yes
PrivilegesRequired=lowest
OutputDir={#AcceptanceOutputDir}
OutputBaseFilename=牛马电子功德-Windows-0.9.4-综合验收-20261018-R2-语言修订-安装包
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\niuma-merit.exe
VersionInfoVersion=0.9.4.0
VersionInfoDescription=牛马电子功德综合验收R2安装程序
ShowLanguageDialog=no
LanguageDetectionMethod=uilanguage
UsePreviousLanguage=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimp"; MessagesFile: "languages\ChineseSimplified.isl"
Name: "chinesetraditional"; MessagesFile: "languages\ChineseSimplified.isl"

[LangOptions]
chinesetraditional.LanguageID=$0404
chinesetraditional.LanguageName=中文

[Files]
Source: "{#ClientExecutable}"; DestDir: "{app}"; DestName: "niuma-merit.exe"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\牛马电子功德【综合验收·R2】"; Filename: "{app}\niuma-merit.exe"; Parameters: "--listener-acceptance --diagnostics"

[Run]
Filename: "{app}\niuma-merit.exe"; Parameters: "--listener-acceptance --diagnostics"; Flags: nowait skipifsilent

#define StartupArguments " --listener-acceptance --diagnostics"
#include "startup-choice.iss"
