import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Data, NtExecutable, NtExecutableResource, Resource} from 'resedit';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dist = path.join(root, 'dist');
const runtime = path.join(root, 'node_modules', 'electron', 'dist');

function executableWithBranding() {
  const exe = NtExecutable.from(fs.readFileSync(path.join(runtime, 'electron.exe')), {ignoreCert: true});
  if (exe.newHeader.fileHeader.machine !== 0x8664) throw Error('An x64 Electron runtime is required.');
  const res = NtExecutableResource.from(exe);
  const icon = Data.IconFile.from(fs.readFileSync(path.join(root, 'src/assets/storyforge.ico')));
  const groups = Resource.IconGroupEntry.fromEntries(res.entries);
  const versions = Resource.VersionInfo.fromEntries(res.entries);
  if (!groups.length || !versions.length) throw Error('Electron branding resources are missing.');
  for (const {id, lang} of groups) {
    Resource.IconGroupEntry.replaceIconsForResource(res.entries, id, lang, icon.icons.map(item => item.data));
  }
  for (const info of versions) {
    for (const locale of info.getAvailableLanguages()) {
      info.setFileVersion(metadata.version, locale.lang);
      info.setProductVersion(metadata.version, locale.lang);
      info.setStringValues(locale, {
        CompanyName: 'sunakle', ProductName: metadata.productName, FileDescription: metadata.productName,
        InternalName: metadata.productName, OriginalFilename: 'StoryForge.exe',
      });
    }
    info.outputToResourceEntries(res.entries);
  }
  res.outputResource(exe);
  return Buffer.from(exe.generate());
}

function buildRuntime() {
  fs.mkdirSync(dist, {recursive: true});
  const output = fs.realpathSync(dist);
  const appDir = path.join(output, 'win-x64');
  const temp = fs.mkdtempSync(path.join(output, '.pack-'));
  const backup = temp + '-previous';
  function removeBuildDirectory(dir) {
    if (!fs.existsSync(dir)) return;
    if (path.dirname(fs.realpathSync(dir)) !== output || ![temp, backup].includes(dir)) {
      throw Error('Unexpected build output: ' + dir);
    }
    fs.rmSync(dir, {recursive: true});
  }
  const payload = path.join(temp, 'resources', 'app');
  try {
    fs.cpSync(runtime, temp, {
      recursive: true,
      filter: src => path.basename(src) !== 'electron.exe' && path.basename(src) !== 'default_app.asar',
    });
    fs.writeFileSync(path.join(temp, 'StoryForge.exe'), executableWithBranding());
    fs.mkdirSync(payload, {recursive: true});
    const {name, productName, version, description, main, license} = metadata;
    fs.writeFileSync(path.join(payload, 'package.json'),
      JSON.stringify({name, productName, version, description, main, license}, null, 2) + '\n');
    for (const file of ['main.js', 'preload.js', 'project-files.cjs', 'src', 'demo']) {
      fs.cpSync(path.join(root, file), path.join(payload, file), {recursive: true});
    }
    if (fs.existsSync(path.join(root, 'LICENSE'))) {
      fs.copyFileSync(path.join(root, 'LICENSE'), path.join(payload, 'LICENSE'));
    }
    // Keep the last usable build in place if Windows has it open.
    if (fs.existsSync(appDir)) {
      if (fs.realpathSync(appDir) !== appDir) throw Error('The old application directory is a link.');
      fs.renameSync(appDir, backup);
    }
    try { fs.renameSync(temp, appDir); }
    catch (err) {
      if (fs.existsSync(backup)) fs.renameSync(backup, appDir);
      throw err;
    }
    removeBuildDirectory(backup);
  } finally {
    removeBuildDirectory(temp);
  }
  console.log(path.join(appDir, 'StoryForge.exe'));
}

function buildInstaller() {
  const candidates = [process.env.ISCC, 'ISCC.exe', ...[
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
    process.env['ProgramFiles(x86)'], process.env.ProgramFiles,
  ].filter(Boolean).map(base => path.join(base, 'Inno Setup 6', 'ISCC.exe'))].filter(Boolean);
  for (const compiler of candidates) {
    const run = spawnSync(compiler, ['/Qp', '/DAppVersion=' + metadata.version, path.join(here, 'StoryForge.iss')],
      {cwd: root, stdio: 'inherit', windowsHide: true});
    if (run.error?.code === 'ENOENT') continue;
    if (run.error) throw run.error;
    if (run.status !== 0) throw Error('Inno Setup returned ' + run.status);
    console.log(path.join(dist, 'StoryForge-Setup-' + metadata.version + '-x64.exe'));
    return;
  }
  throw Error('Install Inno Setup 6.3+ or set ISCC to the path of ISCC.exe.');
}

if (process.platform !== 'win32') throw Error('Build the Windows package on Windows.');
buildRuntime();
if (process.argv.includes('--installer')) buildInstaller();
