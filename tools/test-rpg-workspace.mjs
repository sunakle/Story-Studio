// Exercise the shipped renderer, local save file and player in an isolated Electron profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createEmptyProject } from '../src/js/model.js';
import { rpgDefaults } from '../src/js/rpg-assets.js';

const require = createRequire(import.meta.url);
const { _electron: electron } = require(process.env.STORYFORGE_PLAYWRIGHT || 'playwright-core');
const root = fileURLToPath(new URL('../', import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'StoryForge-RPG-'));
const story = path.join(profile, 'garden.sfproj');
const screenshotPath = process.env.STORYFORGE_RPG_SHOT || (process.argv.includes('--screenshot') && path.join(root, 'docs', 'gallery', 'rpg-engine.png'));
const name = 'Мастерская у пруда';
const revised = 'Вход заперт. Поговорите со смотрителем.';
const errors = [];
let app, page, editor;

async function launch() {
  const env = {...process.env, SF_USERDATA: profile};
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: process.env.STORYFORGE_EXE || require('electron'),
    args: [...(process.env.STORYFORGE_EXE ? [] : ['.']), '--user-data-dir=' + profile],
    cwd: root, env, timeout: 35000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', err => errors.push(err.message));
  await app.evaluate(({BrowserWindow}) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.unmaximize();
    win.setContentSize(1320, 870);
  });
  await page.waitForFunction(title => document.querySelector('#projectTitle')?.value === title, name);
  await page.locator('#newWorkspaceTab').click();
  await page.locator('[data-start="rpg"]').click();
  editor = page.locator('.rpg-editor');
  await editor.locator('[data-rpg-canvas]').waitFor();
}

async function quit() {
  if (!app) return;
  const instance = app;
  app = null;
  const proc = instance.process();
  const closed = instance.waitForEvent('close', {timeout:7000}).catch(() => { if (proc.exitCode === null) proc.kill(); });
  await instance.evaluate(({app}) => { setImmediate(() => app.exit(0)); }).catch(() => {});
  await closed;
}

function command(name) { return editor.locator('[data-cmd="' + name + '"]').click(); }

async function cell(x, y) {
  const canvas = editor.locator('[data-rpg-canvas]');
  const position = await canvas.evaluate((el, [x, y]) => {
    const r = el.getBoundingClientRect();
    return {x:(x + 0.5) * 16 * r.width / el.width, y:(y + 0.5) * 16 * r.height / el.height};
  }, [x, y]);
  await canvas.click({position});
}

async function saveAndRead(check) {
  await page.keyboard.press('Control+s');
  const until = Date.now() + 10000;
  do {
    const project = JSON.parse(await fs.readFile(story, 'utf8'));
    if (check(project)) return project;
    await new Promise(resolve => setTimeout(resolve, 70));
  } while (Date.now() < until);
  throw new Error('Local project does not contain the expected edit.');
}

async function play() {
  await command('play');
  const dialog = page.locator('dialog.rpg-player');
  const at = (map, x, y) => dialog.locator('canvas[data-map="' + map + '"][data-x="' + x + '"][data-y="' + y + '"]').waitFor();
  async function steps(key, n = 1) {
    for (let i = 0; i < n; i++) await page.keyboard.press(key);
  }
  await at('garden', 5, 6);
  await steps('ArrowRight', 5);
  await steps('ArrowUp');
  await steps('Space');
  await dialog.getByText(revised, {exact:true}).waitFor();
  await steps('Space');
  await steps('ArrowLeft', 5);
  await steps('ArrowUp');
  await steps('KeyE');
  await dialog.locator('.rpg-play-dialogue p').filter({hasText:'ключ'}).waitFor();
  await steps('Space');
  await steps('ArrowRight', 5);
  await steps('ArrowUp');
  await steps('Space');
  await at('workshop', 5, 6);
  await steps('ArrowDown');
  await at('garden', 10, 6);
  await dialog.locator('[data-player="restart"]').click();
  await at('garden', 5, 6);
  await steps('Escape');
  await dialog.waitFor({state:'detached'});
}

try {
  const oldProject = createEmptyProject({meta:{title:name}, screenplay:'У пруда стоит мастерская.'});
  delete oldProject.rpgGame;
  await fs.writeFile(story, JSON.stringify(oldProject));
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({
    lastPath:story, language:'ru', theme:'dark', resumeLastProject:true, autosave:true,
  }));
  await launch();
  await command('example');
  const disk = await saveAndRead(p => p.rpgGame?.maps.length === 2);
  const original = disk.rpgGame.maps[0];
  const idx = 7 * original.width + 6;
  const tile = original.tiles[idx] === rpgDefaults.path ? rpgDefaults.ground : rpgDefaults.path;
  await editor.locator('[data-tile="' + tile + '"]').click();
  await cell(6, 7);
  const matches = value => p => p.rpgGame?.maps[0]?.tiles[idx] === value;
  await saveAndRead(matches(tile));
  await page.keyboard.press('Control+z');
  await saveAndRead(matches(original.tiles[idx]));
  await page.keyboard.press('Control+y');
  await saveAndRead(matches(tile));

  await editor.locator('[data-mode="event"]').click();
  await cell(10, 5);
  await editor.locator('.rpg-block.kind-if').waitFor();
  await command('code');
  const box = editor.locator('[data-event-code]');
  const source = await box.inputValue();
  const locked = source.match(/say (".*")/);
  assert.ok(locked, 'Door contains a locked dialogue line');
  const next = source.replace(locked[0], 'say ' + JSON.stringify(revised));
  await box.fill('if has_key == true');
  await command('apply-code');
  assert.match(await editor.locator('.rpg-status').innerText(), /end/);
  assert.equal(await box.inputValue(), 'if has_key == true');
  await command('discard-code');
  assert.equal(await box.inputValue(), source);
  await box.fill(next);
  await command('apply-code');
  await command('blocks');
  const say = editor.locator('[data-field="text"]');
  assert.equal(await say.inputValue(), revised);
  await say.fill(revised + '!');
  await saveAndRead(p => p.rpgGame?.maps[0].events.find(e => e.id === 'locked_door')?.code.includes(revised + '!'));
  await command('code');
  assert.ok((await box.inputValue()).includes(revised + '!'), 'Block changes update source');
  await box.fill(next);
  await command('apply-code');
  await command('blocks');
  const saved = await saveAndRead(p => p.rpgGame?.maps[0].events.find(e => e.id === 'locked_door')?.code === next);
  assert.equal(saved.rpgGame.maps[0].tiles[idx], tile);
  if (screenshotPath) {
    await editor.locator('[data-zoom]').selectOption('1.5');
    await page.mouse.move(10, 10);
    await page.waitForFunction(() => !document.querySelector('#toastRoot .toast'));
    await page.screenshot({path:screenshotPath});
  }
  await play();
  await quit();
  await launch();
  assert.equal(await editor.locator('[data-map-id]').count(), 2);
  assert.equal(await editor.locator('[data-cmd="example"]').count(), 0);
  await play();
  await command('add-map');
  await editor.locator('[data-map-name]').fill('Библиотека');
  await editor.locator('[data-map-width]').fill('8');
  await editor.locator('[data-map-height]').fill('6');
  await editor.locator('[data-map-form] [type="submit"]').click();
  await editor.locator('[data-mode="event"]').click();
  await cell(2, 2);
  await editor.locator('[data-event-name]').fill('Книга');
  await editor.locator('[data-event-name]').press('Tab');
  await editor.locator('[data-add=""]').selectOption('if');
  await editor.locator('[data-add="1.then"]').selectOption('say');
  await command('code');
  assert.match(await editor.locator('[data-event-code]').inputValue(), /if has_key == true\s+say/);
  await saveAndRead(p => p.rpgGame?.maps.some(m => m.name === 'Библиотека' && m.width === 8 && m.height === 6 &&
    m.events.some(e => e.name === 'Книга' && e.code.includes('if has_key == true'))));
  assert.equal(JSON.parse(await fs.readFile(story, 'utf8')).screenplay, oldProject.screenplay);
  assert.deepEqual(errors, []);
  console.log('PASS: RPG workspace, tile/undo/redo, code ↔ blocks, key/door and return, save and reopen');
} finally {
  await quit();
  const verified = await fs.realpath(profile);
  assert.equal(path.dirname(verified), await fs.realpath(os.tmpdir()));
  assert.match(path.basename(verified), /^StoryForge-RPG-/);
  await fs.rm(verified, {recursive:true,force:true,maxRetries:4,retryDelay:100});
}
