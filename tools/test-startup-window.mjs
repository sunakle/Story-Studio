// Regression for a Windows launch which kept the instance lock with no visible editor.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const { _electron: electron } = require(process.env.STORYFORGE_PLAYWRIGHT || 'playwright-core');
const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = require('electron');
const installed = process.env.STORYFORGE_EXE;
const main = installed ? path.join(path.dirname(installed), 'resources', 'app', 'main.js') : path.join(root, 'main.js');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'StoryForge-StartupTest-'));
const run = promisify(execFile);

async function eventually(read, message) {
  const deadline = Date.now() + 10000;
  do {
    if (await read()) return;
    await delay(70);
  } while (Date.now() < deadline);
  assert.fail(message);
}

async function scenario(name, executablePath, args, verify) {
  const profile = path.join(temp, name);
  await fs.mkdir(profile);
  const env = { ...process.env, SF_USERDATA:profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const launchArgs = [...args, '--user-data-dir=' + profile];
  const app = await electron.launch({ executablePath, args:launchArgs, cwd:root, env, timeout:30000 });
  try {
    const page = await app.firstWindow();
    await page.locator('#projectTitle').waitFor({state:'attached', timeout:12000});
    await verify(app, page, () => run(executablePath, launchArgs, {cwd:root, env, timeout:12000, windowsHide:true}));
  } finally {
    const child = app.process();
    const closed = app.waitForEvent('close', {timeout:6000}).catch(() => { if (child.exitCode === null) child.kill(); });
    await app.evaluate(({app}) => { setImmediate(() => app.exit(0)); }).catch(() => {});
    await closed;
  }
}

const visible = app => app.evaluate(({BrowserWindow}) => {
  const windows = BrowserWindow.getAllWindows();
  return windows.length === 1 && windows[0].isVisible() && !windows[0].isMinimized();
});

try {
  const bootstrap = path.join(temp, 'no-paint.cjs');
  // Withhold Electron's first-paint notification without changing application source.
  await fs.writeFile(bootstrap, [
    "require('electron').app.on('browser-window-created', (_, win) => {",
    '  const emit = win.emit;',
    '  win.emit = function (event, ...args) {',
    "    if (event === 'ready-to-show') return false;",
    '    return emit.call(this, event, ...args);',
    '  };',
    '});',
    'require(' + JSON.stringify(main) + ');',
  ].join('\n'));
  await scenario('cold', runtime, [bootstrap], async app => {
    await eventually(() => visible(app), 'The loaded editor stayed hidden without ready-to-show');
  });
  await scenario('warm', installed || runtime, installed ? [] : ['.'], async (app, page, launchAgain) => {
    await eventually(() => visible(app), 'Initial window never became visible');
    const id = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].id);
    await page.evaluate(() => { window.storyForgeStartupMarker = 'same editor'; });
    for (const command of ['hide', 'minimize']) {
      await app.evaluate(({BrowserWindow}, action) => { BrowserWindow.getAllWindows()[0][action](); }, command);
      await eventually(() => app.evaluate(({BrowserWindow}, action) => {
        const win = BrowserWindow.getAllWindows()[0];
        return action === 'hide' ? !win.isVisible() : win.isMinimized();
      }, command), 'Precondition failed for ' + command);
      await launchAgain();
      await eventually(() => visible(app), 'Second launch did not restore the ' + command + ' window');
      assert.equal(await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].id), id);
      assert.equal(await page.evaluate(() => window.storyForgeStartupMarker), 'same editor');
    }
  });
  console.log('PASS: visible editor without first-paint signal, second launch restores hidden and minimized editor in place');
} finally {
  const target = await fs.realpath(temp);
  assert.equal(path.dirname(target), await fs.realpath(os.tmpdir()));
  assert.match(path.basename(target), /^StoryForge-StartupTest-/);
  await fs.rm(target, {recursive:true, force:true, maxRetries:3, retryDelay:150});
}
