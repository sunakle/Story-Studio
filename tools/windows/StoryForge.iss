#ifndef AppVersion
  #error Build with npm run dist:win
#endif

[Setup]
AppId={{9DBBB0F5-FB14-4458-8D51-C134636C8743}
AppName=StoryForge
AppVersion={#AppVersion}
AppPublisher=sunakle
AppPublisherURL=https://github.com/sunakle/Story-Studio
AppSupportURL=https://github.com/sunakle/Story-Studio/issues
DefaultDirName={localappdata}\Programs\StoryForge
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableProgramGroupPage=yes
DisableWelcomePage=no
WizardStyle=modern
OutputDir=..\..\dist
OutputBaseFilename=StoryForge-Setup-{#AppVersion}-x64
VersionInfoVersion={#AppVersion}
VersionInfoDescription=StoryForge Setup
SetupIconFile=..\..\src\assets\storyforge.ico
UninstallDisplayIcon={app}\StoryForge.exe
Compression=lzma2/fast
SolidCompression=yes
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\..\dist\win-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\StoryForge"; Filename: "{app}\StoryForge.exe"; WorkingDir: "{app}"; AppUserModelID: "sunakle.StoryForge"
Name: "{userdesktop}\StoryForge"; Filename: "{app}\StoryForge.exe"; WorkingDir: "{app}"; AppUserModelID: "sunakle.StoryForge"; Tasks: desktopicon

[Run]
Filename: "{app}\StoryForge.exe"; Description: "{cm:LaunchProgram,StoryForge}"; Flags: nowait postinstall skipifsilent
