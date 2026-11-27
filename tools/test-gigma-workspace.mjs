import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEmptyProject } from '../src/js/model.js';

const require = createRequire(import.meta.url);
const { _electron: electron } = require(process.env.STORYFORGE_PLAYWRIGHT || 'playwright-core');
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'StoryForge-Gigma-'));
const story = path.join(scratch, 'polar.sfproj');
const legacyStory = path.join(scratch, 'legacy.sfproj');
const output = process.env.STORYFORGE_GIGMA_SHOTS;
const title = 'Полярная станция';
const secondTitle = 'План перехода';
const errors = [];
let app;

async function launch(theme) {
  const profile = path.join(scratch, theme);
  await fs.mkdir(profile);
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ lastPath:story, language:'ru', theme, autosave:true }));
  const env = { ...process.env, SF_USERDATA:profile };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: process.env.STORYFORGE_EXE || require('electron'),
    args: [...(process.env.STORYFORGE_EXE ? [] : ['.']), '--user-data-dir=' + profile],
    cwd: root, env, timeout: 35000,
  });
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(12000);
  await page.locator('#newWorkspaceTab').waitFor();
  await page.waitForFunction(() => document.querySelector('#projectTitle')?.value === 'Полярная станция');
  assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
  return page;
}

async function stopTestApp() {
  if (!app) return;
  const instance = app;
  app = null;
  if (!instance.windows().length) return;
  const process = instance.process();
  const closed = instance.waitForEvent('close', {timeout:7000}).catch(() => { if (process.exitCode === null) process.kill(); });
  // A failed UI assertion can leave an unsaved-change prompt in this temporary profile.
  await instance.evaluate(({app}) => { setImmediate(() => app.exit(0)); }).catch(() => {});
  await closed;
}

async function openDesign(page, name) {
  await page.locator('#newWorkspaceTab').click();
  if (name) {
    await page.locator('.wb-designs summary').click();
    await page.locator('.wb-designs').getByRole('button', { name, exact:true }).click();
  } else {
    await page.locator('[data-start="gigma"]').click();
  }
  const frame = page.frameLocator('.gigma-panel:not([hidden]) iframe');
  await frame.getByLabel('Холст', { exact:true }).waitFor();
  return frame;
}

async function openStory(page, file, expectedTitle) {
  // Exercise the regular Open command, choosing a fixture without an OS file picker.
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled:false, filePaths:[filePath] });
  }, file);
  await page.frameLocator('.gigma-panel:not([hidden]) iframe').locator('.pages .active-page').click();
  await page.keyboard.press('Control+o');
  await page.waitForFunction(expected => document.getElementById('projectTitle').value === expected, expectedTitle);
}

async function checkProjectMenu(frame, expectedTitle) {
  assert.equal((await frame.locator('.doc-title').textContent()).trim(), expectedTitle);
  assert.equal(await frame.locator('input.doc-title,[contenteditable="true"].doc-title').count(), 0);
  const menu = frame.getByRole('button', { name:'Главное меню', exact:true });
  await menu.click();
  await frame.getByRole('button', { name:/Импортировать страницы из \.gigma/ }).waitFor();
  const dropdown = frame.locator('.menu-anchor .dropdown');
  const trigger = await menu.boundingBox();
  const popup = await dropdown.boundingBox();
  assert.ok(popup && trigger && popup.width >= 180 && popup.width <= 360,
    'The Gigma menu should be a compact desktop popover, got width ' + popup?.width);
  const gap = popup.y - (trigger.y + trigger.height);
  assert.ok(Math.abs(popup.x - trigger.x) <= 12 && gap >= -1 && gap <= 20,
    'The Gigma menu should open directly below its toolbar button');
  assert.ok(await dropdown.locator('button').evaluateAll(rows => rows.every(row => row.scrollWidth <= row.clientWidth + 1)),
    'Menu commands and shortcuts should fit inside their rows');
  assert.equal(await frame.getByRole('button', {name:/Новый (дизайн|проект)|Новая доска/}).count(), 0);
  await menu.click();
}

async function importDesignFile(page, frame, design) {
  const chooserEvent = page.waitForEvent('filechooser');
  await frame.getByRole('button', {name:'Главное меню',exact:true}).click();
  await frame.getByRole('button', {name:/Импортировать страницы из \.gigma/}).click();
  const chooser = await chooserEvent;
  await chooser.setFiles({name:'station.gigma',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(design))});
}

async function field(frame, label, value) {
  const input = frame.getByLabel(label, { exact:true });
  await input.fill(value);
  await input.press('Enter');
}

async function drawPoster(page, frame) {
  const area = await frame.getByLabel('Холст', { exact:true }).boundingBox();
  const scale = Math.min((area.width - 48) / 420, (area.height - 56) / 280, 1.3);
  assert.ok(scale > .55, 'Canvas must have enough room for drawing');
  const x = a => Math.round(area.x + (area.width - 420 * scale) / 2 + a * scale);
  const y = a => Math.round(area.y + (area.height - 280 * scale) / 2 + a * scale);
  async function tool(name) { await frame.getByRole('button', { name, exact:true }).click(); }
  async function shape(kind, name, color, left, top, width, height) {
    await tool(kind);
    await page.mouse.move(x(left), y(top));
    await page.mouse.down();
    await page.mouse.move(x(left + width), y(top + height), { steps:5 });
    await page.mouse.up();
    await field(frame, 'Имя слоя', name);
    await field(frame, 'Заливка HEX', color);
    await frame.getByRole('button', { name:'Выбрать слой ' + name, exact:true }).waitFor();
  }
  async function text(line, size, color, left, top) {
    await tool('Текст');
    await page.mouse.click(x(left), y(top));
    const edit = frame.getByLabel('Текст на холсте');
    await edit.fill(line);
    await edit.press('Control+Enter');
    await field(frame, 'Размер', String(Math.round(size * scale)));
    await field(frame, 'Заливка HEX', color);
  }
  await shape('Прямоугольник', 'Сумерки', 'A9564D', 0, 0, 420, 280);
  await shape('Эллипс', 'Солнце', 'F2C67B', 244, 24, 108, 108);
  await shape('Прямоугольник', 'Дальний берег', '475067', 0, 139, 420, 141);
  await shape('Прямоугольник', 'Маяк', '252F46', 284, 70, 18, 95);
  await shape('Прямоугольник', 'Фонарь маяка', '263048', 280, 68, 26, 7);
  await shape('Прямоугольник', 'Свет', 'F2C67B', 289, 80, 8, 14);
  await shape('Прямоугольник', 'Передний план', '232D40', 0, 162, 420, 118);
  await text('ГЛАВА 02', 15, 'EDB67C', 25, 178);
  await text('ПОЛЯРНАЯ СТАНЦИЯ', 32, 'F6EADA', 25, 205);
  await tool('Выделение');
  await frame.getByTitle('Вписать страницу', { exact:true }).click();
  await frame.getByRole('button', { name:'Выбрать слой Солнце', exact:true }).click();
}

async function screenshot(page, theme) {
  if (!output) return;
  await fs.mkdir(output, { recursive:true });
  await page.mouse.move(10, 10);
  await page.waitForFunction(() => !document.querySelector('#toastRoot .toast'));
  await page.screenshot({ path:path.join(output, 'gigma-' + theme + '.png') });
}

async function readProject(check, file = story) {
  for (let i = 0; i < 120; i++) {
    try {
      const disk = JSON.parse(await fs.readFile(file, 'utf8'));
      if (check(disk)) return disk;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error('Expected edit was not saved to ' + path.basename(file));
}

try {
  const project = createEmptyProject({ meta:{title}, screenplay:'Рассвет на полярной станции.' });
  // Projects created before Gigma was integrated have no workspace property.
  delete project.gigmaWorkspaces;
  await fs.writeFile(story, JSON.stringify(project));
  const page = await launch('dark');
  console.log('Opening the current story canvas and drawing through its native controls');
  let frame = await openDesign(page);
  const isolation = await frame.locator('html').evaluate(() => {
    let parentBlocked = false;
    try { void parent.document; } catch { parentBlocked = true; }
    return { parentBlocked, node:typeof window.require, host:typeof window.sf };
  });
  assert.deepEqual(isolation, { parentBlocked:true, node:'undefined', host:'undefined' });
  await checkProjectMenu(frame, title);
  await page.keyboard.press('Control+s');
  await readProject(p => Array.isArray(p.gigmaWorkspaces) && p.gigmaWorkspaces.length === 0);
  await frame.getByTitle('Добавить страницу', {exact:true}).click();
  await frame.getByRole('button', {name:'Страница 2', exact:true}).waitFor();
  await page.keyboard.press('Control+z');
  await frame.getByRole('button', {name:'Страница 2', exact:true}).waitFor({state:'detached'});
  await drawPoster(page, frame);
  const zoom = frame.getByTitle('Масштаб 100%', { exact:true });
  const fitted = await zoom.textContent();
  await frame.getByTitle('Увеличить', { exact:true }).click();
  assert.notEqual(await zoom.textContent(), fitted);
  await frame.getByTitle('Вписать страницу', { exact:true }).click();
  await page.keyboard.press('Control+s');
  const saved = await readProject(p => p.gigmaWorkspaces?.length === 1 && p.gigmaWorkspaces[0].document?.pages[0].nodes.length === 9);
  assert.equal(saved.screenplay, project.screenplay);
  const workspace = saved.gigmaWorkspaces[0];
  const poster = workspace.document.pages[0];
  assert.ok(poster.nodes.some(n => n.name === 'Солнце' && n.fill.toUpperCase() === '#F2C67B'));
  assert.ok(poster.nodes.some(n => n.text === 'ПОЛЯРНАЯ СТАНЦИЯ'));
  await screenshot(page, 'dark');

  // A second entry through + reuses both the tab and its live canvas.
  console.log('Reentering the canvas and importing into the same project');
  frame = await openDesign(page);
  await frame.getByRole('button', {name:'Выбрать слой Солнце', exact:true}).waitFor();
  assert.equal(await page.locator('[data-tab-kind="gigma"]').count(), 1);
  const source = structuredClone(workspace.document);
  const importedPage = source.pages[0];
  importedPage.name = 'План маяка';
  importedPage.nodes = importedPage.nodes.slice(0, 2);
  const [targetFrame, linkedLayer] = importedPage.nodes;
  targetFrame.kind = 'frame';
  linkedLayer.parentId = linkedLayer.linkTo = targetFrame.id;
  // Import a file derived from the active document, including colliding IDs.
  await importDesignFile(page, frame, source);
  const imported = frame.locator('.pages').getByRole('button', {name:importedPage.name,exact:true});
  await imported.waitFor();
  await page.keyboard.press('Control+z');
  await imported.waitFor({state:'detached'});
  await page.keyboard.press('Control+Shift+z');
  await imported.waitFor();
  await page.keyboard.press('Control+s');
  const merged = await readProject(p => p.gigmaWorkspaces?.length === 1 && p.gigmaWorkspaces[0].document.pages.length === 2);
  assert.equal(merged.gigmaWorkspaces[0].id, workspace.id);
  const document = merged.gigmaWorkspaces[0].document;
  const [original, copy] = document.pages;
  assert.deepEqual(original.nodes, poster.nodes);
  assert.notEqual(original.id, copy.id);
  assert.equal(document.activePageId, copy.id);
  const [newFrame, newLayer] = copy.nodes;
  assert.notEqual(newFrame.id, targetFrame.id);
  assert.notEqual(newLayer.id, linkedLayer.id);
  assert.equal(newLayer.parentId, newFrame.id);
  assert.equal(newLayer.linkTo, newFrame.id);
  await page.locator('.wb-tab.active [data-close-tab]').click();
  await page.locator('[data-tab-kind="gigma"]').waitFor({state:'detached'});
  frame = await openDesign(page);
  await frame.locator('.pages').getByRole('button', {name:copy.name,exact:true}).waitFor();

  // Switch to a legacy story with multiple designs; reuse the primary ID to catch stale iframe messages.
  const primary = structuredClone(workspace);
  primary.name = 'Старый макет';
  primary.document.pages[0].nodes[1].name = 'Луна';
  const legacy = createEmptyProject({meta:{title:'Обратный рейс'},screenplay:'Глава о возвращении.',
    gigmaWorkspaces:[primary,{id:'legacy-extra', name:secondTitle, document:{...source,name:secondTitle}}]});
  await fs.writeFile(legacyStory, JSON.stringify(legacy));
  const storyBeforeSwitch = await fs.readFile(story, 'utf8');
  console.log('Switching projects from the focused Gigma tab');
  await openStory(page, legacyStory, legacy.meta.title);
  frame = await openDesign(page);
  await checkProjectMenu(frame, legacy.meta.title);
  await frame.getByRole('button', {name:'Выбрать слой Луна',exact:true}).waitFor();
  frame = await openDesign(page, secondTitle);
  await frame.locator('.pages').getByRole('button', {name:copy.name,exact:true}).waitFor();
  await frame.getByTitle('Добавить страницу', {exact:true}).click();
  await page.keyboard.press('Control+s');
  const editedLegacy = await readProject(p => p.gigmaWorkspaces[1]?.document.pages.length === 2, legacyStory);
  assert.deepEqual(editedLegacy.gigmaWorkspaces[0].document.pages[0].nodes, primary.document.pages[0].nodes);
  assert.equal(editedLegacy.gigmaWorkspaces.length, 2);
  assert.equal(editedLegacy.screenplay, legacy.screenplay);
  assert.equal(await fs.readFile(story, 'utf8'), storyBeforeSwitch);

  // Save As from the canvas forks the complete story and routes subsequent edits to its copy.
  console.log('Saving an independent copy, then starting a new story from the canvas');
  const fork = path.join(scratch, 'return-trip-copy.sfproj');
  await app.evaluate(({dialog}, filePath) => {
    dialog.showSaveDialog = async () => ({canceled:false, filePath});
  }, fork);
  await page.keyboard.press('Control+Shift+s');
  const forked = await readProject(p => p.gigmaWorkspaces?.length === 2, fork);
  assert.equal(forked.screenplay, legacy.screenplay);
  await page.locator('[data-tab-kind="graph"]').click();
  const renamed = 'Обратный рейс — редакция';
  await page.locator('#projectTitle').fill(renamed);
  await page.locator('#projectTitle').press('Enter');
  await page.locator('[data-tab-kind="gigma"]').getByText(secondTitle, {exact:true}).click();
  await checkProjectMenu(frame, renamed);
  await frame.getByTitle('Добавить страницу', {exact:true}).click();
  await page.keyboard.press('Control+s');
  await readProject(p => p.meta.title === renamed && p.gigmaWorkspaces[1]?.document.pages.length === 3, fork);
  assert.deepEqual(JSON.parse(await fs.readFile(legacyStory, 'utf8')), editedLegacy);
  await page.keyboard.press('Control+n');
  await page.waitForFunction(() => document.getElementById('projectTitle').value === 'Новый проект');
  frame = await openDesign(page);
  await checkProjectMenu(frame, 'Новый проект');
  const fullDesign = structuredClone(source);
  fullDesign.pages = Array.from({length:32}, (_, i) => ({
    ...importedPage, id:randomUUID(), name:'Страница файла ' + (i + 1), nodes:[],
  }));
  fullDesign.activePageId = fullDesign.pages[31].id;
  await importDesignFile(page, frame, fullDesign);
  await frame.locator('.pages .active-page', {hasText:'Страница файла 32'}).waitFor();
  assert.equal(await frame.locator('.pages button').count(), 32);
  assert.equal(await frame.getByTitle('Добавить страницу', {exact:true}).isDisabled(), true);
  await stopTestApp();
  console.log('Reopening the original project in a clean profile and the light theme');
  const reopened = await launch('light');
  frame = await openDesign(reopened);
  await checkProjectMenu(frame, title);
  await frame.locator('.pages').getByRole('button', {name:original.name,exact:true}).click();
  await frame.getByRole('button', {name:'Выбрать слой Солнце', exact:true}).click();
  assert.equal(await frame.locator('html').getAttribute('data-theme'), 'light');
  await screenshot(reopened, 'light');
  assert.deepEqual(errors, []);
  console.log('Passed shared StoryForge canvas, page import and undo, legacy designs, project isolation, persistence and themes.');
} catch (error) {
  console.error(error.stack || error.message);
  if (errors.length) console.error('Renderer errors:', errors);
  if (output && app?.windows().length) {
    await fs.mkdir(output, { recursive:true });
    const failedPage = await app.firstWindow();
    await failedPage.screenshot({path:path.join(output, 'failure.png')}).catch(() => {});
    const accessibility = await failedPage.locator('body').ariaSnapshot().catch(() => '');
    await fs.writeFile(path.join(output, 'failure.txt'), errors.join('\n') + '\n' + accessibility);
  }
  throw error;
} finally {
  await stopTestApp();
  const parent = await fs.realpath(os.tmpdir());
  const verified = await fs.realpath(scratch);
  assert.equal(path.dirname(verified), parent);
  assert.match(path.basename(verified), /^StoryForge-Gigma-/);
  await fs.rm(verified, {recursive:true, force:true});
}
