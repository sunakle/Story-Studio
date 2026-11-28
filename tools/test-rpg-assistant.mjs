import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createEmptyProject } from '../src/js/model.js';
import { createRpgExample } from '../src/js/rpg-example.js';

const require = createRequire(import.meta.url);
const { _electron: electron } = require(process.env.STORYFORGE_PLAYWRIGHT || 'playwright-core');
const root = fileURLToPath(new URL('../', import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'StoryForge-RpgAssistant-'));
const files = [path.join(profile, 'first.sfproj'), path.join(profile, 'second.sfproj')];
const titles = ['First QA project', 'Second QA project'];
const gamePane = '#rpgAiBody';
const generalPane = '#rightPanel #aiBody';
const workshopPane = '.assistant-chat-pane';
const gameEdit = 'QA-GAME-EDIT-A';
const generalNote = 'QA-GENERAL-NOTE-A';
const workshopNote = 'QA-WORKSHOP-NOTE-A';
const otherNote = 'QA-GAME-NOTE-B';
const delayedNote = 'QA-GAME-DELAYED-A';
const parallelNote = 'QA-WORKSHOP-CONCURRENT-A';
const newGameNote = 'QA-UNSAVED-GAME';
const newStoryNote = 'QA-UNSAVED-GENERAL';
const draft = 'Unsent game direction';
const generalDraft = 'Unsent general direction';
const requests = [];
const errors = [];
let app, page;
let finishGameReply;
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  requests.push(body);
  const latest = body.messages.findLast(message => message.role === 'user');
  const marker = [gameEdit, generalNote, workshopNote, otherNote, delayedNote, parallelNote, newGameNote, newStoryNote]
    .find(token => JSON.stringify(latest.content).includes(token));
  const rename = marker === gameEdit && body.messages.at(-1).role === 'user';
  const delta = rename ? {
    tool_calls: [{index:0, id:'rename_game_map', type:'function', function:{
      name:'edit_rpg_game', arguments:JSON.stringify({actions:[{action:'renameMap', mapId:'garden', name:'QA courtyard'}]}),
    }}],
  } : {content:'Reply to ' + marker};
  function finish() {
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    res.end('data: ' + JSON.stringify({choices:[{index:0, delta, finish_reason:rename ? 'tool_calls' : 'stop'}]}) + '\n\ndata: [DONE]\n\n');
  }
  if (marker === delayedNote) finishGameReply = finish;
  else finish();
});

async function launch(title = titles[0]) {
  const env = {...process.env, SF_USERDATA:profile};
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({executablePath:process.env.STORYFORGE_EXE || require('electron'),
    args:[...(process.env.STORYFORGE_EXE ? [] : ['.']), '--user-data-dir=' + profile], cwd:root, env});
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', err => errors.push(err.message));
  await app.evaluate(({BrowserWindow}) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.unmaximize();
    win.setContentSize(1480, 880);
  });
  await waitProject(title);
}
async function quit() {
  if (!app) return;
  const instance = app;
  app = null;
  const proc = instance.process();
  const closed = instance.waitForEvent('close', {timeout:8000}).catch(() => { if (proc.exitCode === null) proc.kill(); });
  await instance.evaluate(({app}) => { setImmediate(() => app.exit(0)); }).catch(() => {});
  await closed;
}
async function waitProject(title) {
  await page.waitForFunction(expected => document.querySelector('#projectTitle')?.value === expected, title);
}
async function switchProject(index) {
  await app.evaluate(({dialog}, file) => { dialog.showOpenDialog = async () => ({canceled:false, filePaths:[file]}); }, files[index]);
  await page.keyboard.press('Control+o');
  await waitProject(titles[index]);
}
async function tab(kind) {
  const existing = page.locator('[data-tab-kind="' + kind + '"]');
  if (await existing.count()) await existing.first().click();
  else {
    await page.locator('#newWorkspaceTab').click();
    await page.locator('[data-start="' + kind + '"]').click();
  }
}
async function gameChat() {
  await tab('rpg');
  if (!await page.locator('#rpgAiInput').isVisible()) await page.locator('.rpg-editor [data-cmd="ai"]').click();
  await page.locator('#rpgAiInput').waitFor();
}
async function sidebar() {
  await tab('screenplay');
  if (!await page.locator(generalPane + ' .chat-input').isVisible()) await page.locator('#rightTabs [data-tab="ai"]').click();
  await page.locator(generalPane + ' .chat-input').waitFor();
}
async function send(pane, marker) {
  const host = page.locator(pane);
  await host.locator('.chat-input').fill(marker);
  await host.locator('[data-ai-act="send"]').click();
  await host.getByText('Reply to ' + marker, {exact:true}).waitFor();
  const request = requests.findLast(body => JSON.stringify(body.messages.findLast(m => m.role === 'user')?.content).includes(marker));
  assert.ok(request, 'Model received ' + marker);
  return request;
}
async function expectDraft(pane, expected) {
  await page.waitForFunction(({pane, expected}) => document.querySelector(pane + ' .chat-input')?.value === expected, {pane, expected});
}
function userHistory(request) {
  return request.messages.filter(item => item.role === 'user').map(item => JSON.stringify(item.content)).join('\n');
}

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  for (const [index, file] of files.entries()) {
    const project = createEmptyProject({meta:{title:titles[index]}, rpgGame:createRpgExample()});
    await fs.writeFile(file, JSON.stringify(project));
  }
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({lastPath:files[0], language:'ru', resumeLastProject:true,
    ai:{preset:'custom', baseUrl:'http://127.0.0.1:' + server.address().port + '/v1', model:'local-test'}}));
  await launch();
  await sidebar();
  await send(generalPane, generalNote);
  await page.locator(generalPane + ' .chat-input').fill(generalDraft);
  await gameChat();
  await expectDraft(gamePane, '');
  assert.equal(await page.locator(gamePane + ' .msg-user').count(), 0);
  const game = await send(gamePane, gameEdit);
  assert.ok(!JSON.stringify(game.messages).includes(generalNote), 'General memory absent from game API request');
  assert.match(userHistory(game), /garden/);
  assert.match(userHistory(game), /rpg/i);
  await page.locator('.rpg-maps [data-map-id="garden"]').getByText('QA courtyard').waitFor();
  await page.locator('#rpgAiInput').fill(draft);
  await page.keyboard.press('Control+s');
  for (let attempt = 0; attempt < 100; attempt++) {
    if (JSON.parse(await fs.readFile(files[0], 'utf8')).rpgGame.maps[0].name === 'QA courtyard') break;
    await delay(50);
  }
  assert.equal(JSON.parse(await fs.readFile(files[0], 'utf8')).rpgGame.maps[0].name, 'QA courtyard');
  await tab('assistant');
  await expectDraft(workshopPane, generalDraft);
  const workshop = await send(workshopPane, workshopNote);
  assert.ok(userHistory(workshop).includes(generalNote), 'Sidebar and workshop still share general memory');
  assert.ok(!JSON.stringify(workshop.messages).includes(gameEdit), 'Game memory absent from workshop API request');
  await gameChat();
  await expectDraft(gamePane, draft);
  await page.locator('#rpgAiInput').fill(delayedNote);
  await page.locator(gamePane + ' [data-ai-act="send"]').click();
  for (let attempt = 0; !finishGameReply && attempt < 100; attempt++) await delay(50);
  assert.ok(finishGameReply, 'Game model request in progress');
  await tab('assistant');
  const parallel = await send(workshopPane, parallelNote);
  assert.ok(!JSON.stringify(parallel.messages).includes(delayedNote), 'Concurrent requests have separate model histories');
  finishGameReply();
  await gameChat();
  await page.locator(gamePane).getByText('Reply to ' + delayedNote, {exact:true}).waitFor();
  assert.equal(await page.locator(gamePane).getByText('Reply to ' + parallelNote, {exact:true}).count(), 0);
  await page.locator('#rpgAiInput').fill(draft);
  await switchProject(1);
  await gameChat();
  await expectDraft(gamePane, '');
  assert.equal(await page.locator(gamePane + ' .msg-user').count(), 0);
  const other = await send(gamePane, otherNote);
  assert.ok(!JSON.stringify(other.messages).includes(gameEdit), 'First project absent from second project game request');
  await switchProject(0);
  await gameChat();
  await expectDraft(gamePane, draft);
  await page.locator(gamePane).getByText('Reply to ' + gameEdit, {exact:true}).waitFor();
  await quit();
  await launch();
  await gameChat();
  await expectDraft(gamePane, draft);
  await page.locator(gamePane).getByText('Reply to ' + gameEdit, {exact:true}).waitFor();
  await page.locator(gamePane + ' [data-ai-act="clear"]').click();
  assert.equal(await page.locator(gamePane + ' .msg-user').count(), 0);
  await sidebar();
  await page.locator(generalPane).getByText('Reply to ' + workshopNote, {exact:true}).waitFor();
  await switchProject(1);
  await gameChat();
  await page.locator(gamePane).getByText('Reply to ' + otherNote, {exact:true}).waitFor();
  await switchProject(0);
  await gameChat();
  await expectDraft(gamePane, draft);
  assert.equal(await page.locator(gamePane + ' .msg-user').count(), 0, 'Clear persisted for the selected game thread');

  await page.keyboard.press('Control+n');
  const newTitle = 'Новый проект';
  await waitProject(newTitle);
  await sidebar();
  const newStory = await send(generalPane, newStoryNote);
  assert.ok(!userHistory(newStory).includes(generalNote));
  await page.locator(generalPane + ' .chat-input').fill(generalDraft);
  await gameChat();
  const newGame = await send(gamePane, newGameNote);
  assert.ok(!userHistory(newGame).includes(newStoryNote));
  await page.locator('#rpgAiInput').fill(draft);
  const png = await page.evaluate(() => document.createElement('canvas').toDataURL().split(',')[1]);
  await page.locator('#rpgAiImageFiles').setInputFiles({name:'game-only.png', mimeType:'image/png', buffer:Buffer.from(png,'base64')});
  const preview = gamePane + ' .chat-input-wrap .chat-image img';
  await page.locator(preview).waitFor();
  const savedNew = path.join(profile, 'first-save.sfproj');
  await app.evaluate(({dialog}, file) => { dialog.showSaveDialog = async () => ({canceled:false, filePath:file}); }, savedNew);
  const savedToasts = page.locator('#toastRoot').getByText('Сохранено', {exact:true});
  await savedToasts.first().waitFor({state:'hidden'});
  await page.keyboard.press('Control+Shift+s');
  await savedToasts.first().waitFor();
  await quit();
  await launch(newTitle);
  assert.equal(JSON.parse(await fs.readFile(savedNew, 'utf8')).meta.title, newTitle);
  await sidebar();
  await page.locator(generalPane).getByText('Reply to ' + newStoryNote, {exact:true}).waitFor();
  await expectDraft(generalPane, generalDraft);
  assert.equal(await page.locator(generalPane + ' .chat-input-wrap .chat-image img').count(), 0);
  await gameChat();
  await page.locator(gamePane).getByText('Reply to ' + newGameNote, {exact:true}).waitFor();
  await expectDraft(gamePane, draft);
  await page.locator(preview).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: isolated and concurrent game/general requests, actual map edit, sidebar/workshop, drafts and photos, project switching, scoped clear and first save/relaunch');
} finally {
  await quit();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(profile, {recursive:true, force:true, maxRetries:3, retryDelay:100});
}
