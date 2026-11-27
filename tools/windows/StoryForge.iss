#ifndef AppVersion
  #error Build with npm run dist:win
#endif
#if Ver < EncodeVer(6, 7, 0)
  #error This wizard requires Inno Setup 6.7 or later.
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
WizardStyle=modern dark
WizardBackColor=#201f23
WizardImageFile=branding\wizard-cover.png
WizardSmallImageFile=..\..\src\assets\storyforge-mark.png
WizardSmallImageBackColor=none
OutputDir=..\..\dist
OutputBaseFilename=StoryForge-Setup-x64
VersionInfoVersion={#AppVersion}
VersionInfoDescription=StoryForge Setup
VersionInfoProductName=StoryForge
VersionInfoProductVersion={#AppVersion}
SetupIconFile=..\..\src\assets\storyforge.ico
UninstallDisplayIcon={app}\StoryForge.exe
Compression=lzma2/fast
SolidCompression=yes
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Messages]
english.WelcomeLabel1=Install StoryForge
english.WelcomeLabel2=Write your script, connect scenes and design layouts in Gigma Studio.%n%nVersion {#AppVersion} will be installed for your Windows account.
english.FinishedHeadingLabel=StoryForge is ready
english.FinishedLabel=Open StoryForge to create a project or continue an existing one.
english.FinishedLabelNoIcons=Open StoryForge to create a project or continue an existing one.
russian.WelcomeLabel1=Установка StoryForge
russian.WelcomeLabel2=Пишите сценарии, связывайте сцены и создавайте макеты в Gigma Studio.%n%nВерсия {#AppVersion} будет установлена для вашей учётной записи Windows.
russian.FinishedHeadingLabel=StoryForge готов к работе
russian.FinishedLabel=Откройте StoryForge, чтобы создать проект или продолжить работу над существующим.
russian.FinishedLabelNoIcons=Откройте StoryForge, чтобы создать проект или продолжить работу над существующим.

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\..\dist\win-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\StoryForge"; Filename: "{app}\StoryForge.exe"; WorkingDir: "{app}"; AppUserModelID: "sunakle.StoryForge"
Name: "{userdesktop}\StoryForge"; Filename: "{app}\StoryForge.exe"; WorkingDir: "{app}"; AppUserModelID: "sunakle.StoryForge"; Tasks: desktopicon

[Run]
Filename: "{app}\StoryForge.exe"; Description: "{cm:LaunchProgram,StoryForge}"; Flags: nowait postinstall skipifsilent

[Code]
procedure RemoveFactoryFile(const Name, ExpectedHash, AlternateHash: String);
var
  FileName, ActualHash: String;
begin
  FileName := ExpandConstant('{app}\resources\app\demo\') + Name;
  if FileExists(FileName) then begin
    ActualHash := GetSHA256OfFile(FileName);
    if (CompareText(ActualHash, ExpectedHash) = 0) or (CompareText(ActualHash, AlternateHash) = 0) then
      DeleteFile(FileName);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    RemoveFactoryFile('demo-project.json', 'f22ff9bf9c922c78e8899299e747503c721fb56ce5468d1b8cb2e7fb367d4586', '6b1ff695e3516218ef6a4967adf348c1ae4fbc42c985469c2e3c0ec459ac5c8d');
    RemoveFactoryFile('stress-overview.sfproj', '9aa17c50ecaef5083f26052e3cca36e28f988ad3e9762ba5ee4e49e499f47d94', '843c6eb2fec336b5bb2c3886819fc3ca1e23504f49fbbb7423576190ed5f0177');
    RemoveDir(ExpandConstant('{app}\resources\app\demo'));
  end;
end;
