// Isolated desktop acceptance. The application, mock and exported files use real IPC.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parent = process.platform === 'win32'
  ? path.join(os.homedir(), 'AppData', 'LocalLow') : os.tmpdir();
const output = fs.mkdtempSync(path.join(parent, 'StoryForge-Test-'));
const profile = path.join(output, 'profile');
fs.mkdirSync(profile);
const mock = spawn(process.execPath, ['tools/mock-ai-server.mjs', '--port=0'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit']
});
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Локальная AI-заглушка не запустилась')), 10000);
    let log = '';
    mock.stdout.on('data', chunk => {
      log += chunk;
      const match = log.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(match[0] + '/v1'); log = ''; }
    });
    mock.once('error', err => { clearTimeout(timer); reject(err); });
    mock.once('exit', () => { clearTimeout(timer); reject(Error('Локальная AI-заглушка завершилась')); });
  });
  const executable = process.platform === 'win32' ? 'electron.exe' : 'electron';
  const electron = path.join(root, 'node_modules', 'electron', 'dist', executable);
  const env = { ...process.env, SF_USERDATA: profile, SF_TEST_OUTPUT: output };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electron, ['--no-sandbox', '--user-data-dir=' + profile, '.', '--selftest', '--ai-base=' + url], {
    cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 180000
  });
  if (run.error || run.status !== 0) throw Error(run.error?.message || run.stderr || 'Electron: ' + run.status);
  const report = JSON.parse(fs.readFileSync(path.join(output, 'selftest.json'), 'utf8'));
  console.log(JSON.stringify({output, summary:report.summary, failed:report.failed, jsErrors:report.jsErrors}, null, 2));
  if (!report.summary || report.summary.failed || report.jsErrors?.length) process.exitCode = 1;
} finally {
  if (mock.exitCode === null && mock.signalCode === null) {
    const stopped = once(mock, 'exit');
    mock.kill();
    await stopped;
  }
}
