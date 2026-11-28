// Exercise the shipped renderer, local save file and player in an isolated Electron profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createEmptyProject } from '../src/js/model.js';
import { rpgDefaults } from '../src/js/rpg-assets.js';
import { getMapTile, isMapBlocked } from '../src/js/rpg-model.js';

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

async function viewport() {
  const canvas = editor.locator('[data-rpg-canvas][data-cell-size]');
  return canvas.evaluate(async el => {
    await new Promise(resolve => requestAnimationFrame(resolve));
    const r = el.getBoundingClientRect();
    return {left:Number(el.dataset.worldLeft),top:Number(el.dataset.worldTop),unit:Number(el.dataset.cellSize),
      x:r.left,y:r.top,width:r.width,height:r.height};
  });
}

async function cell(x, y) {
  const v = await viewport();
  const target = {x:(x + .5 - v.left)*v.unit, y:(y + .5 - v.top)*v.unit};
  assert.ok(target.x>=0 && target.x<v.width && target.y>=0 && target.y<v.height,
    'Cell is outside viewport: ' + JSON.stringify({x,y,v,target}));
  await page.mouse.click(v.x + target.x, v.y + target.y);
}

async function pan(button = 'middle', modifier) {
  const v = await viewport();
  await editor.locator('[data-rpg-canvas]').focus();
  if (modifier) await page.keyboard.down(modifier);
  try {
    await page.mouse.move(v.x + v.width * .15, v.y + v.height * .3);
    await page.mouse.down({button});
    await page.mouse.move(v.x + v.width * .78, v.y + v.height * .65, {steps:8});
    await page.mouse.up({button});
  } finally {
    if (modifier) await page.keyboard.up(modifier);
  }
  const after = await viewport();
  assert.ok(after.left < v.left - 2 && after.top < v.top - 2, 'Panning exposes cells to the north-west');
}

async function zoomAtCursor() {
  const v = await viewport();
  const mx = Math.round(v.width*.67), my = Math.round(v.height*.42);
  await page.mouse.move(v.x+mx,v.y+my);
  await page.mouse.wheel(0,-100);
  await page.waitForFunction(prior => Number(document.querySelector('[data-rpg-canvas]').dataset.cellSize)>prior,v.unit);
  const z = await viewport();
  assert.ok(Math.abs(v.left+mx/v.unit-z.left-mx/z.unit)<.2, 'Wheel zoom keeps cursor world X');
  assert.ok(Math.abs(v.top+my/v.unit-z.top-my/z.unit)<.2, 'Wheel zoom keeps cursor world Y');
}

// Extend the garden through its eastern edge using the shipped brushes. The
// capture shows both connected terrain and empty space for the next stroke.
async function captureFreeMap() {
  await command('close-event');
  await editor.locator('[data-mode="paint"]').click();
  await editor.locator('[data-group]').selectOption('');
  await editor.locator('[data-zoom]').selectOption({label:'150%'});
  const brush = id => editor.locator('[data-tile="'+id+'"]').click();
  const segment = async (x1,y1,x2,y2) => {
    const v = await viewport();
    const sx = x => v.x+(x+.5-v.left)*v.unit, sy = y => v.y+(y+.5-v.top)*v.unit;
    assert.ok(sx(x1)>=v.x && sx(x2)<v.x+v.width && sy(y1)>=v.y && sy(y2)<v.y+v.height, 'Screenshot stroke in viewport');
    await page.mouse.move(sx(x1),sy(y1));
    await page.mouse.down(); await page.mouse.move(sx(x2),sy(y2),{steps:4}); await page.mouse.up();
  };
  await brush(rpgDefaults.ground);
  const widths = [[17,19],[16,20],[16,21],[16,22],[16,23],[16,23],[16,22],[16,21],[17,21],[17,20],[18,20]];
  for (let i=0;i<widths.length;i++) await segment(widths[i][0],i+3,widths[i][1],i+3);
  await brush(rpgDefaults.path);
  await segment(11,6,19,6);
  await segment(19,6,19,10);
  const details = [[3,17,4],[5,16,5],[4,18,3],[3,21,7],[4,22,8],[5,21,9],[4,20,11],[3,18,12],[1,17,7],[2,17,8],[83,20,6]];
  for (const [id,x,y] of details) { await brush(id); await cell(x,y); }
  await brush(rpgDefaults.path);
  await editor.locator('[data-group]').selectOption('terrain');
  await command('fit');
  await page.mouse.move(12,12);
  await page.waitForFunction(() => !document.querySelector('#toastRoot .toast'));
  await page.screenshot({path:screenshotPath});
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
  const originalTile = getMapTile(original,6,7);
  const tile = originalTile === rpgDefaults.path ? rpgDefaults.ground : rpgDefaults.path;
  await editor.locator('[data-tile="' + tile + '"]').click();
  await cell(6, 7);
  const matches = value => p => getMapTile(p.rpgGame.maps[0],6,7) === value;
  await saveAndRead(matches(tile));
  await page.keyboard.press('Control+z');
  await saveAndRead(matches(originalTile));
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
  assert.equal(getMapTile(saved.rpgGame.maps[0],6,7), tile);
  if (screenshotPath) await captureFreeMap();
  await play();
  await quit();
  await launch();
  assert.equal(await editor.locator('[data-map-id]').count(), 2);
  assert.equal(await editor.locator('[data-cmd="example"]').count(), 0);
  await play();
  await command('add-map');
  await editor.locator('[data-map-name]').fill('Библиотека');
  assert.equal(await editor.locator('[data-map-width],[data-map-height]').count(),0);
  await editor.locator('[data-map-form] [type="submit"]').click();
  await editor.locator('[data-mode="paint"]').click();
  await editor.locator('[data-tile="' + rpgDefaults.ground + '"]').click();
  await cell(2,2);
  await editor.locator('[data-mode="event"]').click();
  await cell(2, 2);
  await editor.locator('[data-event-name]').fill('Книга');
  await editor.locator('[data-event-name]').press('Tab');
  await editor.locator('[data-add=""]').selectOption('if');
  await editor.locator('[data-add="1.then"]').selectOption('say');
  await command('code');
  assert.match(await editor.locator('[data-event-code]').inputValue(), /if has_key == true\s+say/);
  await saveAndRead(p => p.rpgGame?.maps.some(m => m.name === 'Библиотека' &&
    m.events.some(e => e.name === 'Книга' && e.code.includes('if has_key == true'))));

  await command('close-event');
  await editor.locator('[data-mode="paint"]').click();
  const library = p => p.rpgGame.maps.find(m => m.name === 'Библиотека');
  const beforePan = await saveAndRead(p => !!library(p));
  const v = await viewport();
  assert.ok(v.width>700 && v.height>380, 'The map canvas fills the available editing pane on a blank map.');
  await editor.locator('[data-zoom]').selectOption({label:'50%'});
  await zoomAtCursor();
  await editor.locator('[data-zoom]').selectOption({label:'50%'});
  await pan();
  await pan('left','Space');
  await pan();
  const moved = await viewport();
  const x = Math.floor(moved.left + moved.width/(2*moved.unit));
  const y = Math.floor(moved.top + moved.height/(2*moved.unit));
  assert.ok(x < -128 && y < 0, 'Reached outside every old map boundary.');
  const afterPan = await saveAndRead(p => !!library(p));
  assert.deepEqual(library(afterPan),library(beforePan),'Camera gestures must not paint or allocate map cells');
  await editor.locator('[data-tile="' + rpgDefaults.path + '"]').click();
  await cell(x,y);
  const remoteTile = value => p => getMapTile(library(p),x,y) === value;
  await saveAndRead(remoteTile(rpgDefaults.path));
  await page.keyboard.press('Control+z');
  await saveAndRead(remoteTile(null));
  await page.keyboard.press('Control+y');
  await saveAndRead(remoteTile(rpgDefaults.path));
  await editor.locator('[data-mode="erase"]').click();
  await cell(x,y);
  await saveAndRead(remoteTile(null));
  await page.keyboard.press('Control+z');
  await saveAndRead(remoteTile(rpgDefaults.path));
  await editor.locator('[data-mode="paint"]').click();
  for (const offset of [-1,1,2]) await cell(x+offset,y);
  await editor.locator('[data-mode="block"]').click();
  await cell(x-1,y);
  await editor.locator('[data-mode="start"]').click();
  await cell(x,y);
  const expanded = await saveAndRead(p => p.rpgGame.start.x === x && p.rpgGame.start.y === y && isMapBlocked(library(p),x-1,y));
  assert.ok(JSON.stringify(library(expanded)).length<20000,'Distant strokes should allocate only painted cells.');
  await zoomAtCursor();
  await pan();
  const parked = await viewport();
  await quit();
  await launch();
  const mapId = library(expanded).id;
  assert.equal(await editor.locator('[data-map-id][aria-current="true"]').getAttribute('data-map-id'),mapId);
  const restored = await viewport();
  const centerX = v => v.left + v.width/(v.unit*2);
  const centerY = v => v.top + v.height/(v.unit*2);
  assert.ok(Math.abs(centerX(restored)-centerX(parked))<.1 && Math.abs(centerY(restored)-centerY(parked))<.1,
    'Reopening the local project restores its map camera');
  assert.equal(restored.unit,parked.unit);
  await command('home');
  await editor.locator('[data-mode="event"]').click();
  await cell(x+2,y);
  await editor.locator('[data-event-name]').fill('Архив');
  await command('code');
  await editor.locator('[data-event-code]').fill('say "Здесь архив."\ngoto '+mapId+' '+x+' '+y);
  await command('apply-code');
  await command('blocks');
  assert.equal(await editor.locator('[data-field="x"]').inputValue(), String(x));
  assert.equal(await editor.locator('[data-field="y"]').inputValue(), String(y));
  await saveAndRead(p => library(p).events.some(e => e.name === 'Архив' && e.x === x+2 && e.y === y));
  await command('play');
  const dialog = page.locator('dialog.rpg-player');
  const playerAt = (xx, yy) => dialog.locator('canvas[data-map="'+mapId+'"][data-x="'+xx+'"][data-y="'+yy+'"]').waitFor();
  await playerAt(x,y);
  await page.keyboard.press('ArrowLeft');
  await playerAt(x,y);
  await page.keyboard.press('ArrowRight');
  await playerAt(x+1,y);
  await page.keyboard.press('Space');
  await dialog.getByText('Здесь архив.',{exact:true}).waitFor();
  await page.keyboard.press('Space');
  await playerAt(x,y);
  await page.keyboard.press('Escape');
  assert.equal(JSON.parse(await fs.readFile(story, 'utf8')).screenplay, oldProject.screenplay);
  assert.deepEqual(errors, []);
  console.log('PASS: free map viewport, anchored zoom, pan, distant negative tiles, sparse save/undo/reopen, wall, character, key and door');
} finally {
  await quit();
  const verified = await fs.realpath(profile);
  assert.equal(path.dirname(verified), await fs.realpath(os.tmpdir()));
  assert.match(path.basename(verified), /^StoryForge-RPG-/);
  await fs.rm(verified, {recursive:true,force:true,maxRetries:4,retryDelay:100});
}
