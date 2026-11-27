import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEmptyProject } from '../src/js/model.js';

const require = createRequire(import.meta.url);
const { _electron: electron } = require(process.env.STORYFORGE_PLAYWRIGHT || 'playwright-core');
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'StoryForge-Gigma-'));
const story = path.join(scratch, 'polar.sfproj');
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
  const closed = instance.waitForEvent('close', {timeout:7000}).catch(() => instance.process().kill());
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

async function readProject(check) {
  for (let i = 0; i < 120; i++) {
    const disk = JSON.parse(await fs.readFile(story, 'utf8'));
    if (check(disk)) return disk;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error('Save from the focused Gigma editor did not reach the .sfproj');
}

try {
  await fs.writeFile(story, JSON.stringify(createEmptyProject({ meta:{title:'Полярная станция'}, screenplay:'Рассвет на полярной станции.' })));
  const page = await launch('dark');
  console.log('Creating a Gigma workspace and drawing through its native controls');
  let frame = await openDesign(page);
  const isolation = await frame.locator('html').evaluate(() => {
    let parentBlocked = false;
    try { void parent.document; } catch { parentBlocked = true; }
    return { parentBlocked, node:typeof window.require, host:typeof window.sf };
  });
  assert.deepEqual(isolation, { parentBlocked:true, node:'undefined', host:'undefined' });
  await field(frame, 'Название документа', title);
  await drawPoster(page, frame);
  const zoom = frame.getByTitle('Масштаб 100%', { exact:true });
  const fitted = await zoom.textContent();
  await frame.getByTitle('Увеличить', { exact:true }).click();
  assert.notEqual(await zoom.textContent(), fitted);
  await frame.getByTitle('Вписать страницу', { exact:true }).click();
  await page.keyboard.press('Control+s');
  await readProject(p => p.gigmaWorkspaces?.some(w => w.name === title && w.document.pages[0].nodes.length === 9));
  await screenshot(page, 'dark');
  frame = await openDesign(page);
  await field(frame, 'Название документа', secondTitle);
  await frame.getByRole('button', {name:'Эллипс', exact:true}).click();
  const canvas = await frame.getByLabel('Холст', { exact:true }).boundingBox();
  await page.mouse.move(canvas.x + 70, canvas.y + 80);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 120, canvas.y + 130, {steps:4});
  await page.mouse.up();
  const secondLayer = frame.getByRole('button', {name:'Выбрать слой Эллипс', exact:true});
  await secondLayer.waitFor();
  await page.keyboard.press('Control+z');
  await secondLayer.waitFor({state:'detached'});
  await page.keyboard.press('Control+Shift+z');
  await secondLayer.waitFor();
  await page.keyboard.press('Control+s');
  const saved = await readProject(p => p.gigmaWorkspaces?.length === 2 && p.gigmaWorkspaces[1].name === secondTitle);
  assert.equal(saved.screenplay, 'Рассвет на полярной станции.');
  assert.deepEqual(saved.gigmaWorkspaces[1].document.pages[0].nodes.map(n => n.kind), ['ellipse']);
  const layers = saved.gigmaWorkspaces[0].document.pages[0].nodes;
  assert.ok(layers.some(n => n.name === 'Солнце' && n.fill.toUpperCase() === '#F2C67B'));
  assert.ok(layers.some(n => n.text === 'ПОЛЯРНАЯ СТАНЦИЯ'));
  await page.locator('[data-tab-kind="gigma"]').getByText(title, { exact:true }).click();
  const close = page.locator('.wb-tab.active [data-close-tab]');
  await close.click();
  await page.locator('[data-tab-kind="gigma"]', { hasText:title }).waitFor({state:'detached'});
  frame = await openDesign(page, title);
  await frame.getByRole('button', {name:'Выбрать слой Солнце', exact:true}).waitFor();
  await stopTestApp();
  console.log('Reopening both saved designs in a clean profile and the light theme');
  const reopened = await launch('light');
  frame = await openDesign(reopened, secondTitle);
  assert.equal(await frame.getByLabel('Название документа').inputValue(), secondTitle);
  await frame.getByRole('button', {name:'Выбрать слой Эллипс', exact:true}).waitFor();
  frame = await openDesign(reopened, title);
  assert.equal(await frame.getByLabel('Название документа').inputValue(), title);
  await frame.getByRole('button', {name:'Выбрать слой Солнце', exact:true}).click();
  assert.equal(await frame.locator('html').getAttribute('data-theme'), 'light');
  await screenshot(reopened, 'light');
  assert.deepEqual(errors, []);
  console.log('Passed Gigma editing, zoom, isolated tabs, save, reopen, themes and renderer isolation.');
} catch (error) {
  console.error(error.message);
  if (output && app) {
    await fs.mkdir(output, { recursive:true });
    await (await app.firstWindow()).screenshot({path:path.join(output, 'failure.png')}).catch(() => {});
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
