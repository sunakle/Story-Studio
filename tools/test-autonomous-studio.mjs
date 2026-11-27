import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { createEmptyProject } from '../src/js/model.js';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright-core');
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'StoryForge-Autonomy-'));
const profile = path.join(scratch, 'profile');
const bootstrap = path.join(scratch, 'fixture.cjs');
const first = path.join(scratch, 'first.sfproj'), second = path.join(scratch, 'second.sfproj');
const actions = [];
const failures = [];
const pending = [];
let phase = 'first', app, page;
const names = { first:'Starter panel', second:'Dock elevation', interrupt:'Uncommitted draft', switch:'Discard on switch' };
const manual = 'Create the manual revision';
const server = http.createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, undefined);
    const chunks = [];
    for await (const data of req) chunks.push(data);
    const { model, tools, messages } = JSON.parse(Buffer.concat(chunks));
    assert.equal(model, 'local-studio-fixture');
    const user = messages.findLast(m => m.role === 'user').content;
    const origin = JSON.parse(user.split('\n')[0].slice('[StoryForge] '.length));
    assert.equal(origin.project, phase === 'second' ? 'Seeded harbour' : 'Empty workshop');
    const autonomous = origin.mode === 'autonomous';
    if (autonomous) {
      assert.equal(origin.workspaceId, 'gg_assistant');
      assert.ok(tools.some(tool => tool.function.name === 'edit_artwork'));
      assert.ok(!tools.some(tool => ['edit_screenplay','generate_project_image'].includes(tool.function.name)));
    } else assert.ok(user.endsWith(manual));
    const report = { phase, autonomous, project:origin.project, tool:messages.at(-1).role === 'tool' };
    actions.push(report);
    const name = autonomous ? names[phase] : 'Manual revision';
    assert.ok(name, 'Unexpected model request in phase ' + phase);
    const message = { role:'assistant' };
    if (report.tool) {
      const result = JSON.parse(messages.at(-1).content);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.workspaceId, 'gg_assistant');
      if (autonomous && ['interrupt','switch'].includes(phase)) {
        // Hold the last provider response after its edit is staged but before commit.
        const entry = { phase, closed:false };
        pending.push(entry);
        res.on('close', () => { entry.closed = true; });
        return;
      }
      message.content = 'Finished ' + name;
    } else {
      message.tool_calls = [{ id:'fixture_' + actions.length, type:'function',
        function:{name:'edit_artwork', arguments:JSON.stringify({action:'create',kind:'text',name,text:name})} }];
    }
    res.writeHead(200, { 'Content-Type':'application/json' });
    res.end(JSON.stringify({ choices:[{ message }] }));
  } catch (error) {
    failures.push(error);
    res.writeHead(500); res.end(String(error));
  }
});

async function until(fn, description) {
  const end = Date.now() + 14000;
  do {
    if (failures.length) throw failures[0];
    if (await fn()) return;
    await pause(30);
  } while (Date.now() < end);
  throw Error(description + ' timed out. Requests: ' + JSON.stringify(actions));
}
const read = file => fs.readFile(file,'utf8').then(JSON.parse);
const layers = p => p.gigmaWorkspaces?.find(w => w.id === 'gg_assistant')?.document?.pages.flatMap(pg => pg.nodes.map(n => n.name)) || [];
const toggle = () => page.locator('[data-ai-act="autonomy"]');
const button = selector => page.locator(selector).evaluate(el => {
  if (el.disabled) throw Error('Disabled button ' + el.textContent);
  el.click();
});
async function menu(action) {
  await app.evaluate(({BrowserWindow}, name) => BrowserWindow.getAllWindows()[0].webContents.send('sf:menu',{action:name}), action);
}
async function openStudio() {
  await button('#newWorkspaceTab');
  await button('[data-start="assistant"]');
  await until(async () => await toggle().getAttribute('aria-pressed') === 'false', 'Explicit opt-in');
}
async function launch(file) {
  const env = { ...process.env, SF_USERDATA:profile };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath:require('electron'), cwd:root, env,
    args:[bootstrap,'--disable-background-networking','--user-data-dir=' + profile], timeout:30000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  const title = (await read(file)).meta.title;
  await page.waitForFunction(t => document.querySelector('#projectTitle')?.value === t, title, {polling:50});
  assert.equal(await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().some(win => win.isVisible())), false);
  await page.clock.install();
}
async function shutdown() {
  if (!app) return;
  const closed = app.waitForEvent('close', {timeout:12000});
  await app.evaluate(({app}) => { setImmediate(() => app.exit(0)); });
  await closed;
  app = null;
}
async function saved(file, expected) {
  await menu('file:save');
  await until(async () => JSON.stringify(layers(await read(file))) === JSON.stringify(expected), 'Project save ' + expected);
}
async function switchTo(file) {
  await app.evaluate(({dialog}, chosen) => { dialog.showOpenDialog = async () => ({canceled:false,filePaths:[chosen]}); }, file);
  await menu('file:open');
  await page.waitForFunction(title => document.querySelector('#projectTitle')?.value === title, (await read(file)).meta.title, {polling:50});
}
async function finished(name) {
  await until(async () => (await page.locator('#aiLog').textContent()).includes('Finished ' + name)
    && !await page.locator('[data-ai-act="stop"]').count(), 'Finished ' + name);
}
async function assertQuiet() {
  const count = actions.length;
  await page.clock.fastForward(150000);
  await pause(120);
  assert.equal(actions.length, count, 'Stopped scheduler made another request');
  assert.equal(await toggle().getAttribute('aria-pressed'), 'false');
}

try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const addr = 'http://127.0.0.1:' + server.address().port;
  await fs.mkdir(profile);
  await fs.writeFile(bootstrap, [
    'const {app, session} = require("electron");',
    'app.on("browser-window-created", (_, win) => { win.show = () => {}; win.showInactive = () => {}; });',
    'app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({urls:["http://*/*","https://*/*"]}, (details, next) => next({cancel:new URL(details.url).origin !== ' + JSON.stringify(addr) + '})));',
    'require(' + JSON.stringify(path.join(root, 'main.js')) + ');',
  ].join('\n'));
  await fs.writeFile(first, JSON.stringify(createEmptyProject({meta:{title:'Empty workshop',createdAt:'2025-02-01T00:00:00Z'}})));
  await fs.writeFile(second, JSON.stringify(createEmptyProject({meta:{title:'Seeded harbour',createdAt:'2025-02-02T00:00:00Z'},screenplay:'A ferry arrives at the dock.'})));
  await fs.writeFile(path.join(profile,'settings.json'), JSON.stringify({lastPath:first,resumeLastProject:true,language:'en',
    ai:{preset:'custom',baseUrl:addr + '/v1',apiKey:'',model:'local-studio-fixture'}}));
  await launch(first);
  await openStudio();
  await assertQuiet();
  await button('[data-ai-act="autonomy"]');
  await finished(names.first);
  await saved(first,[names.first]);

  phase = 'interrupt';
  await page.clock.fastForward(31000);
  await until(() => pending.some(p => p.phase === phase), 'Held automatic draft');
  await page.locator('#aiInput').fill(manual);
  await button('[data-ai-act="send"]');
  await finished('Manual revision');
  await until(() => pending[0].closed, 'Cancelled provider request');
  await button('[data-ai-act="autonomy"]');
  await assertQuiet();
  await saved(first,[names.first,'Manual revision']);

  phase = 'switch';
  await button('[data-ai-act="autonomy"]');
  await until(() => pending.some(p => p.phase === phase), 'Second held draft');
  await switchTo(second);
  await until(() => pending[1].closed, 'Old project request cancellation');
  await openStudio();
  await assertQuiet();
  phase = 'second';
  await button('[data-ai-act="autonomy"]');
  await finished(names.second);
  await button('[data-ai-act="autonomy"]');
  await saved(second,[names.second]);
  assert.deepEqual(layers(await read(first)),[names.first,'Manual revision']);
  assert.equal((await read(second)).screenplay,'A ferry arrives at the dock.');
  await shutdown();
  await launch(second);
  await openStudio();
  await assertQuiet();
  assert.deepEqual(layers(await read(second)),[names.second]);
  if (failures.length) throw failures[0];
  console.log('Passed: opt-in, editable workshop layer, in-flight cancellation, manual priority, stop, project switch and saved-project relaunch (' + actions.length + ' loopback requests).');
} finally {
  await shutdown();
  server.closeAllConnections();
  server.close();
  const dir = await fs.realpath(scratch);
  if (path.dirname(dir) === await fs.realpath(os.tmpdir()) && path.basename(dir).startsWith('StoryForge-Autonomy-')) {
    await fs.rm(dir,{recursive:true,force:true,maxRetries:4,retryDelay:80});
  }
}
