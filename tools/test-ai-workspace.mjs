import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmptyProject } from '../src/js/model.js';

const require = createRequire(import.meta.url);
const { _electron: electron } = require(process.env.STORYFORGE_PLAYWRIGHT || 'playwright-core');
const root = fileURLToPath(new URL('../', import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'StoryForge-AI-studio-'));
const file = path.join(profile, 'studio.sfproj');
const requests = [], errors = [];
let pendingResponse;
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  requests.push(body.messages);
  const last = body.messages.at(-1);
  const isDraft = JSON.stringify(body.messages.findLast(message => message.role === 'user')?.content).includes('Draw a draft');
  if (last.role === 'tool' && isDraft) {
    pendingResponse = res;
    return;
  }
  const delta = last.role === 'user' && (isDraft || JSON.stringify(last.content).includes('Draw the lamp'))
    ? {tool_calls:[{index:0,id:isDraft ? 'draft' : 'create_lamp',type:'function',function:{name:'edit_artwork',
        arguments:JSON.stringify({action:'create',kind:'rect',name:isDraft ? 'Cancelled artwork' : 'Lamp',x:20,y:24,width:45,height:60})}}]}
    : {content:'Complete ' + requests.length};
  res.writeHead(200, {'Content-Type':'text/event-stream'});
  res.end('data: ' + JSON.stringify({choices:[{index:0,delta,finish_reason:delta.tool_calls ? 'tool_calls' : 'stop'}]}) + '\n\ndata: [DONE]\n\n');
});
let app;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const project = createEmptyProject({meta:{title:'Workshop fixture'},screenplay:'A light in the window.'});
  await fs.writeFile(file, JSON.stringify(project));
  await fs.writeFile(path.join(profile, 'settings.json'),JSON.stringify({lastPath:file,language:'ru',autosave:true,
    ai:{preset:'custom',baseUrl:'http://127.0.0.1:' + server.address().port + '/v1',model:'local-test'}}));
  const env = {...process.env,SF_USERDATA:profile};
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({executablePath:process.env.STORYFORGE_EXE || require('electron'),
    args:[...(process.env.STORYFORGE_EXE ? [] : ['.']), '--user-data-dir=' + profile],cwd:root,env});
  await app.evaluate(({BrowserWindow}) => { const win = BrowserWindow.getAllWindows()[0]; win.unmaximize(); win.setContentSize(1430,850); });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', err => errors.push(err.message));
  await page.waitForFunction(() => document.querySelector('#projectTitle')?.value === 'Workshop fixture');
  await page.locator('[data-tab-kind="screenplay"]').click();
  await page.locator('#screenplayText').evaluate(el => { el.focus(); el.setSelectionRange(2,7); });
  await page.keyboard.press('Control+Shift+a');
  await page.locator('.assistant-chat-pane #aiInput').fill('Draft');
  await page.locator('[data-ai-act="reference"]').click();
  const ref = (await page.locator('#aiInput').inputValue()).slice('Draft '.length);
  assert.ok(ref.startsWith('storyforge://screenplay?project=') && ref.endsWith('&start=2&end=7'));
  await page.locator('[data-tab-kind="screenplay"]').click();
  await page.locator('#rightTabs [data-tab="ai"]').click();
  assert.equal(await page.locator('#rightPanel #aiInput').inputValue(), 'Draft ' + ref);
  await page.locator('[data-ai-act="send"]').click();
  await page.getByText('Complete 1', {exact:true}).waitFor();
  const priorUser = requests[0].findLast(message => message.role === 'user');
  assert.match(JSON.stringify(priorUser.content), /sidebar/);
  assert.match(JSON.stringify(priorUser.content), /screenplay/);
  await page.locator('.chat-ref').click();
  assert.deepEqual(await page.locator('#screenplayText').evaluate(el => [el.selectionStart, el.selectionEnd]), [2,7]);

  await page.locator('#newWorkspaceTab').click();
  await page.locator('[data-start="assistant"]').click();
  assert.equal(await page.locator('#aiInput').count(), 1);
  assert.equal(await page.locator('[data-tab-kind="assistant"]').count(), 1);
  const frame = page.frameLocator('.gigma-panel:not([hidden]) iframe');
  await frame.getByRole('button', {name:'Главное меню',exact:true}).waitFor();
  await page.locator('#aiInput').fill('Draw the lamp');
  await page.locator('[data-ai-act="send"]').click();
  await page.getByText('Complete 3', {exact:true}).waitFor();
  assert.match(JSON.stringify(requests[1].findLast(message => message.role === 'user').content), /workshop/);
  assert.match(JSON.stringify(requests[1].findLast(message => message.role === 'user').content), /gg_assistant/);
  assert.deepEqual(requests[1].filter(message => message.role === 'user')[0].content, priorUser.content);
  await frame.getByRole('button', {name:'Выбрать слой Lamp',exact:true}).click();
  await page.locator('[data-ai-act="reference"]').click();
  assert.match(await page.locator('#aiInput').inputValue(), /^storyforge:\/\/gigma\/gg_assistant\//);
  const bounds = await page.locator('.assistant-chat-pane').boundingBox();
  const canvas = await frame.getByLabel('Холст', {exact:true}).boundingBox();
  assert.ok(canvas.width > 150 && canvas.x + canvas.width <= bounds.x + 2, 'Editable canvas next to chat');
  await frame.getByLabel('Имя слоя', {exact:true}).fill('Manual lamp');
  await frame.getByLabel('Имя слоя', {exact:true}).press('Enter');
  await frame.getByRole('button', {name:'Выбрать слой Manual lamp',exact:true}).waitFor();
  await page.locator('#aiInput').focus();
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !document.querySelector('#projectTitle')?.classList.contains('dirty'));
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(955,740));
  await page.locator('.assistant-pane-tabs [data-pane="canvas"]').click();
  assert.equal(await page.locator('#aiInput').isVisible(), false);
  await page.locator('.assistant-pane-tabs [data-pane="chat"]').click();
  await page.locator('#aiInput').waitFor();
  assert.equal(await page.locator('.msg-user').count(), 2);
  await page.locator('#aiInput').fill('Draw a draft');
  await page.locator('[data-ai-act="send"]').click();
  const preview = page.locator('.assistant-draft-preview img');
  await preview.waitFor();
  await page.waitForFunction(() => document.querySelector('.assistant-draft-preview img').naturalWidth > 0);
  await page.locator('[data-ai-act="stop"]').click();
  await preview.waitFor({state:'hidden'});
  if (pendingResponse) pendingResponse.destroy();
  await page.locator('.assistant-pane-tabs [data-pane="canvas"]').click();
  assert.equal(await frame.getByRole('button', {name:'Выбрать слой Cancelled artwork',exact:true}).count(), 0);
  const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.ok(persisted.gigmaWorkspaces.find(item => item.id === 'gg_assistant').document.pages[0].nodes
    .some(node => node.name === 'Manual lamp'));
  assert.deepEqual(errors, []);
  console.log('PASS: shared draft/history, source metadata, excerpt and layer links, editable AI output, live preview and cancel, responsive panes and saved project');
} finally {
  await app?.evaluate(({app}) => { setImmediate(() => app.exit(0)); }).catch(() => {});
  await app?.close().catch(() => {});
  pendingResponse?.destroy();
  server.close();
  await fs.rm(profile, {recursive:true,force:true,maxRetries:3,retryDelay:100});
}
