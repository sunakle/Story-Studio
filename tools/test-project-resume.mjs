// A real desktop session, including native title-bar close. Every file belongs to the test profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { _electron: electron } = require(process.env.STORYFORGE_PLAYWRIGHT || 'playwright-core');
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'StoryForge-Resume-'));
const name = 'История у моря';
const firstScript = 'На берегу загорается маяк.';
const secondScript = 'На другом берегу выключают радио.';
const forkScript = 'Новый финал отдельной копии.';
let profile = path.join(scratch, 'author');
let app;
let page;

const settings = async () => JSON.parse(await fs.readFile(path.join(profile, 'settings.json'), 'utf8'));
const project = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function launch(expectedTitle = 'Новый проект') {
  const env = { ...process.env, SF_USERDATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: process.env.STORYFORGE_EXE || require('electron'),
    args: [...(process.env.STORYFORGE_EXE ? [] : ['.']), '--user-data-dir=' + profile],
    cwd: root, env, timeout: 30000,
  });
  await app.evaluate(({dialog}) => {
    dialog.showOpenDialog = dialog.showSaveDialog = async () => {
      throw new Error('Unexpected native file picker during automatic save or resume');
    };
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  await page.locator('[data-tab-kind="screenplay"]').waitFor();
  try {
    await page.waitForFunction(title => document.querySelector('#projectTitle')?.value === title, expectedTitle);
  } catch (error) {
    const {lastPath, resumeLastProject} = await settings();
    throw new Error(`Expected "${expectedTitle}", found "${await page.locator('#projectTitle').inputValue()}"; lastPath=${lastPath}, resume=${resumeLastProject}`, {cause:error});
  }
}

async function requestClose() {
  await app.evaluate(({BrowserWindow}) => { setImmediate(() => BrowserWindow.getAllWindows()[0].close()); });
}

async function close() {
  await Promise.all([app.waitForEvent('close', {timeout:12000}), requestClose()]);
  app = null;
}

async function screenplay() {
  await page.locator('[data-tab-kind="screenplay"]').click();
  return page.locator('#screenplayText');
}

async function title(value) {
  const box = page.locator('#projectTitle');
  await box.fill(value);
  await box.press('Enter');
}

async function drawing() {
  await page.locator('#newWorkspaceTab').click();
  await page.locator('[data-start="gigma"]').click();
  const frame = page.frameLocator('.gigma-panel:not([hidden]) iframe');
  await frame.getByLabel('Холст', {exact:true}).waitFor();
  return frame;
}

async function preference(value) {
  await page.locator('#btnSettings').click();
  await page.locator('[data-pref="save"]').click();
  await page.locator('#setResumeLastProject').setChecked(value);
  await page.getByRole('button', {name:'Готово', exact:true}).click();
}

async function waitForFile(file, check) {
  const until = Date.now() + 10000;
  do {
    try {
      const content = await project(file);
      if (check(content)) return content;
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < until);
  throw Error('Expected project contents were not saved: ' + file);
}

try {
  await fs.mkdir(profile);
  const directory = path.join(profile, 'Projects');
  await launch();
  await close();
  assert.equal((await fs.readdir(directory).catch(e => {
    if (e.code !== 'ENOENT') throw e;
    return [];
  })).length, 0, 'Opening an untouched editor should not generate a project');

  await launch();
  await title(name);
  let canvas = await drawing();
  await canvas.getByTitle('Добавить страницу', {exact:true}).click();
  await canvas.getByRole('button', {name:'Страница 2', exact:true}).waitFor();
  await (await screenplay()).fill(firstScript);
  await close();  // Close while screenplay input is still debounced.
  const first = (await settings()).lastPath;
  assert.equal(path.dirname(first), directory);
  assert.equal(path.extname(first), '.sfproj');
  assert.equal((await project(first)).screenplay, firstScript);
  assert.equal((await project(first)).gigmaWorkspaces[0].document.pages.length, 2);

  await launch(name);
  assert.equal(await (await screenplay()).inputValue(), firstScript);
  canvas = await drawing();
  await canvas.getByRole('button', {name:'Страница 2', exact:true}).waitFor();
  await page.locator('[data-tab-kind="graph"]').click();
  await page.keyboard.press('Control+n');
  await page.waitForFunction(() => document.getElementById('projectTitle').value === 'Новый проект');
  await title(name);  // Two independent stories may have exactly the same title.
  await (await screenplay()).fill(secondScript);
  const second = (await waitForFile(path.join(profile, 'settings.json'), s => s.lastPath && s.lastPath !== first)).lastPath;
  await waitForFile(second, p => p.screenplay === secondScript); // The real local file is up to date before closing.
  await close();
  assert.notEqual(first, second);
  assert.equal(path.dirname(second), directory);
  assert.equal((await project(first)).screenplay, firstScript);
  assert.equal((await project(second)).screenplay, secondScript);
  assert.equal((await fs.readdir(directory)).filter(file => file.endsWith('.sfproj')).length, 2);

  await launch(name);
  assert.equal(await (await screenplay()).inputValue(), secondScript);
  const copy = path.join(scratch, 'writer-copy.sfproj');
  await app.evaluate(({dialog}, chosen) => {
    dialog.showSaveDialog = async () => ({canceled:false, filePath:chosen});
  }, copy);
  await page.keyboard.press('Control+Shift+s');
  await waitForFile(copy, p => p.screenplay === secondScript);
  await (await screenplay()).fill(forkScript);
  await close();
  assert.equal((await settings()).lastPath, copy);
  assert.equal((await project(copy)).screenplay, forkScript);
  assert.equal((await project(second)).screenplay, secondScript);

  await launch(name);
  assert.equal(await (await screenplay()).inputValue(), forkScript);
  await preference(false);
  await close();
  await launch();
  assert.equal(await (await screenplay()).inputValue(), '');
  assert.ok((await settings()).recent.includes(copy));
  await preference(true);
  await close();
  await launch(name);
  assert.equal(await (await screenplay()).inputValue(), forkScript);
  await page.locator('[data-tab-kind="graph"]').click();
  await page.keyboard.press('Control+n');
  await page.waitForFunction(() => document.getElementById('projectTitle').value === 'Новый проект');
  await close();  // Deliberately choosing New makes this empty story the next session's project.
  const empty = (await settings()).lastPath;
  assert.equal(path.dirname(empty), directory);
  assert.ok(![first, second, copy].includes(empty));
  assert.equal((await project(empty)).screenplay, '');
  await launch();
  assert.equal(await (await screenplay()).inputValue(), '');
  await close();

  // A regular file blocking the managed directory makes the actual filesystem write fail.
  profile = path.join(scratch, 'disk-error');
  await fs.mkdir(profile);
  const obstruction = path.join(profile, 'Projects');
  await fs.writeFile(obstruction, 'temporary test obstruction');
  await launch();
  await (await screenplay()).fill(firstScript);
  await requestClose();
  await page.locator('#toastRoot .toast.bad, #toastRoot .toast.warn').first().waitFor();
  assert.equal(await page.locator('#screenplayText').inputValue(), firstScript);
  assert.ok(await page.locator('#stDirty').isVisible());
  await fs.unlink(obstruction);
  await close();
  assert.equal((await project((await settings()).lastPath)).screenplay, firstScript);
  console.log('Passed local saves, repeated native close and relaunch, Gigma, colliding titles, Save As, resume preferences and disk-error retry.');
} catch (error) {
  const {resumeLastProject, lastPath, recent} = await settings().catch(() => ({}));
  console.error('Session', {resumeLastProject, lastPath, recent});
  if (lastPath) {
    const saved = await project(lastPath).catch(() => null);
    console.error('Last stored project', saved?.meta?.title, saved?.screenplay);
  }
  if (page && !page.isClosed()) console.error('Visible notices', await page.locator('#toastRoot').innerText());
  throw error;
} finally {
  if (app) {
    const closed = app.waitForEvent('close', {timeout:5000}).catch(() => app.process().kill());
    await app.evaluate(({app}) => { setImmediate(() => app.exit(0)); }).catch(() => {});
    await closed;
  }
  const real = await fs.realpath(scratch);
  assert.equal(path.dirname(real), await fs.realpath(os.tmpdir()));
  assert.match(path.basename(real), /^StoryForge-Resume-/);
  await fs.rm(real, {recursive:true, force:true, maxRetries:3, retryDelay:100});
}
