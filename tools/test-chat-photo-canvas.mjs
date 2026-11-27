import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createEmptyProject } from '../src/js/model.js';

const require = createRequire(import.meta.url);
const { _electron: electron } = require(process.env.STORYFORGE_PLAYWRIGHT || 'playwright-core');
const root = fileURLToPath(new URL('../', import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'StoryForge-Photo-'));
const file = path.join(profile, 'strip.sfproj');
const name = 'Polaroid.png', title = 'Photo placement', prompt = 'Положи снимок на холст с отскоком.';
const calls = [], errors = [];
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  calls.push(JSON.parse(Buffer.concat(chunks)));
  response.writeHead(502, {'Content-Type':'text/html'});
  response.end('<html><title>502 Bad Gateway</title><body>TEST_PROXY_INTERNAL_MARKUP</body></html>');
});
let app, page;
async function launch() {
  const env = {...process.env, SF_USERDATA:profile};
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({executablePath:process.env.STORYFORGE_EXE || require('electron'),
    args:[...(process.env.STORYFORGE_EXE ? [] : ['.']), '--user-data-dir=' + profile], cwd:root, env});
  page = await app.firstWindow();
  page.on('pageerror', err => errors.push(err.message));
  page.setDefaultTimeout(12000);
  await app.evaluate(({BrowserWindow}) => { const win = BrowserWindow.getAllWindows()[0]; win.unmaximize(); win.setContentSize(1420,820); });
  await page.waitForFunction(value => document.querySelector('#projectTitle')?.value === value, title);
  await page.locator('#newWorkspaceTab').click();
  await page.locator('[data-start="assistant"]').click();
}
async function quit() {
  const closed = app.waitForEvent('close',{timeout:15000});
  await app.evaluate(({BrowserWindow}) => { setImmediate(() => BrowserWindow.getAllWindows()[0].close()); });
  await closed;
  app = null;
}
async function saved(check) {
  const until = Date.now() + 10000;
  do {
    const p = JSON.parse(await fs.readFile(file, 'utf8'));
    const nodes = p.gigmaWorkspaces.find(w => w.id === 'gg_assistant')?.document?.pages[0].nodes || [];
    if (check(nodes)) return nodes;
    await new Promise(resolve => setTimeout(resolve,60));
  } while (Date.now() < until);
  throw Error('Expected project state was not saved');
}
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await fs.writeFile(file, JSON.stringify(createEmptyProject({meta:{title}})));
  await fs.writeFile(path.join(profile,'settings.json'),JSON.stringify({resumeLastProject:true,lastPath:file,language:'ru',
    ai:{preset:'custom',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',model:'fixture'}}));
  await launch();
  await page.locator('#aiInput').fill(prompt);
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 32;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#955713'; ctx.fillRect(0,0,64,32);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.locator('#aiImageFiles').setInputFiles({name,mimeType:'image/png',buffer:Buffer.from(data,'base64')});
  await page.locator('[data-photo-options]').waitFor();
  await page.locator('[data-ai-act="send"]').click();
  await page.locator('.chat-status').filter({hasText:/502/}).waitFor();
  assert.doesNotMatch(await page.locator('.chat-status').textContent(), /TEST_PROXY_INTERNAL_MARKUP/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].messages.at(-1).content.some(part => part.type === 'image_url'));
  assert.equal(await page.locator('#aiInput').inputValue(), prompt);
  await page.locator('[data-local-attachments]').check();
  await quit();
  await launch();
  console.log('Reopened the failed request in the isolated project');
  assert.equal(await page.locator('#aiInput').inputValue(), prompt);
  assert.equal(await page.locator('[data-local-attachments]').isChecked(), true);
  await page.locator('[data-photo-options]').click();
  await page.locator('[data-place="bounce"]').click();
  const frame = page.frameLocator('.gigma-panel:not([hidden]) iframe');
  const layer = frame.getByRole('button',{name:'Выбрать слой '+name,exact:true});
  await layer.waitFor();
  await frame.locator('[data-object][style*="gigma-bounce"]').waitFor();
  assert.equal(await frame.getByLabel('Имя слоя',{exact:true}).inputValue(), name);
  assert.equal(await frame.getByTitle('Остановить анимацию',{exact:true}).getAttribute('aria-pressed'), 'true');
  await page.locator('#aiInput').focus();
  await page.keyboard.press('Control+s');
  const [photo] = await saved(nodes => nodes.length === 1);
  assert.equal(photo.kind, 'image');
  assert.deepEqual([photo.width,photo.height],[64,32]);
  assert.deepEqual(photo.animation,{type:'bounce',durationMs:1100,loop:true});
  assert.match(photo.image,/^data:image\/(?:png|jpeg|webp);base64,/);
  console.log('Verified the stored photo and the live bounce');
  assert.equal(await page.locator('#aiInput').inputValue(),prompt);
  await page.locator('[data-photo-options]').waitFor();
  assert.equal(calls.length,1,'The local action made no provider requests');
  await layer.click();
  await page.keyboard.press('Control+z');
  await layer.waitFor({state:'detached'});
  await page.locator('#aiInput').focus();
  await page.keyboard.press('Control+s');
  await saved(nodes => !nodes.length);
  await quit();
  await launch();
  const reopenedFrame = page.frameLocator('.gigma-panel:not([hidden]) iframe');
  await reopenedFrame.getByLabel('Холст',{exact:true}).waitFor();
  assert.equal(await reopenedFrame.locator('[data-object]').count(),0,'Undo survives closing and reopening the project');
  await page.locator('[data-ai-act="send"]').click();
  await page.locator('.chat-status').filter({hasText:/502/}).waitFor();
  const input = calls.at(-1).messages.at(-1).content;
  assert.equal(calls.length,2);
  assert.equal(typeof input, 'string');
  assert.ok(input.includes(name) && !input.includes('base64,'));
  assert.deepEqual(errors, []);
  console.log('PASS: 502 draft survives restart, local photo + bounce is selected/playing, project persistence, single focused undo, filenames-only retry');
} finally {
  await app?.evaluate(({app}) => { setImmediate(() => app.exit(0)); }).catch(() => {});
  await app?.close().catch(() => {});
  server.close();
  await fs.rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
