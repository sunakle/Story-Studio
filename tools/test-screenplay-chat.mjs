import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmptyProject } from '../src/js/model.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const original = 'НАТ. ПРИЧАЛ — РАННЕЕ УТРО\n\nНа причале туман. Вода едва различима за деревянными сваями. Ира останавливается у последнего фонаря.\n\nИра (негромко): Ты здесь?\n\nОтвета нет. Она ставит сумку на доски.\n\nИра: Подожду.';
const revised = original.replace('туман', 'рассвет');
const done = 'Готово. Сцена на причале связана с репликами.';
const internal = 'qa-private-continuation';
const model = 'fixture-vision';
const calls = [
  ['get_screenplay', { offset: 0 }],
  ['edit_screenplay', { mode: 'replace', find: 'туман', text: 'рассвет' }],
  ['build_story_graph', { nodes: [
    { key: 'dock', type: 'scene', location: 'Причал', text: 'На причале рассвет.' },
    { key: 'call', type: 'line', speaker: 'Ира', location: 'Причал', text: 'Ты здесь?' },
    { key: 'reply', type: 'line', speaker: 'Ира', location: 'Причал', text: 'Подожду.' },
    { key: 'finish', type: 'end', title: 'Конец' },
  ] }],
];

let rounds = 0;
let mockError;
const server = http.createServer(async (request, response) => {
  try {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: model }] }));
      return;
    }
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    const chunks = [];
    for await (const part of request) chunks.push(part);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.model, model);
    assert.equal(body.stream, true);
    assert.ok(calls.every(([name]) => body.tools.some(tool => tool.function.name === name)));
    const user = body.messages.find(message => message.role === 'user');
    assert.ok(user.content.some(part => part.type === 'text' && part.text.includes('Сценарий')));
    const image = user.content.find(part => part.type === 'image_url');
    assert.match(image?.image_url?.url || '', /^data:image\/(png|jpeg|webp);base64,\S+$/);
    const previous = body.messages.filter(message => message.role === 'assistant' && message.tool_calls);
    assert.equal(previous.length, rounds);
    assert.ok(previous.every((message, i) => message.reasoning_content === internal + i));
    const results = body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
    assert.equal(results.length, rounds);
    if (results[0]) assert.equal(results[0].text, original);
    if (results[1]) assert.equal(results[1].length, revised.length);
    if (results[2]) assert.equal(results[2].count, 4);
    assert.ok(rounds <= calls.length);
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    function chunk(delta, finish_reason = null) {
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    }
    if (rounds < calls.length) {
      const [name, args] = calls[rounds];
      chunk({ role: 'assistant', reasoning_content: internal });
      chunk({ reasoning_content: String(rounds), tool_calls: [{ index: 0, id: 'fixture_' + rounds, type: 'function', function: { name, arguments: '' } }] });
      chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] });
      chunk({}, 'tool_calls');
    } else {
      chunk({ role: 'assistant', content: done });
      chunk({}, 'stop');
    }
    rounds++;
    response.end('data: [DONE]\n\n');
  } catch (error) {
    mockError = error;
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});

// These functions run inside the real StoryForge renderer through its existing self-test hook.
async function writeInApp({ original, revised, done, internal, capture }) {
  const { store } = window.__sfTest;
  const query = selector => document.querySelector(selector);
  const key = (letter, shiftKey = false) => document.dispatchEvent(new KeyboardEvent('keydown', { key: letter, ctrlKey: true, shiftKey, bubbles: true, cancelable: true }));
  async function waitFor(check, label) {
    const until = Date.now() + 16000;
    while (Date.now() < until) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw Error(label + ': ' + JSON.stringify({
      view: query('#workspacePage')?.dataset.view, text: store.project.screenplay,
      editor: query('#screenplayText')?.value, status: query('.chat-status')?.textContent,
    }));
  }
  query('[data-tab-kind="screenplay"]').click();
  const input = query('#screenplayText');
  if (document.activeElement !== input) throw Error('Notebook did not receive focus');
  input.value = original;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  // Ctrl+S during the debounce interval must write the current characters.
  key('s');
  await waitFor(() => !store.dirty && store.project.screenplay === original, 'Immediate save');
  const loaded = await window.sf.file.openPath(store.filePath);
  if (!loaded.ok || loaded.project.screenplay !== original) throw Error('Save omitted pending text');
  query('[data-screenplay-chat]').click();
  const chat = query('#aiInput');
  if (!chat.value.includes('Сценарий')) throw Error('Screenplay action did not prepare the chat request');
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  const sky = ctx.createLinearGradient(0, 0, 0, 86);
  sky.addColorStop(0, '#526780');
  sky.addColorStop(0.58, '#d6b29b');
  sky.addColorStop(0.61, '#778a90');
  sky.addColorStop(1, '#496573');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 160, 96);
  ctx.fillStyle = '#303f49';
  ctx.beginPath();
  ctx.moveTo(0, 92); ctx.lineTo(87, 59); ctx.lineTo(103, 59); ctx.lineTo(26, 96); ctx.lineTo(0, 96); ctx.fill();
  ctx.fillRect(86, 41, 2, 24);
  ctx.fillStyle = '#f8d89b';
  ctx.fillRect(84, 39, 6, 4);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  const transfer = new DataTransfer();
  transfer.items.add(new File([blob], 'reference.png', { type: 'image/png' }));
  chat.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  await waitFor(() => query('.chat-input-wrap .chat-image img'), 'Pasted photo preview');
  query('[data-ai-act="send"]').click();
  await waitFor(() => store.project.nodes.some(node => node.id === 'n_script_finish') && query('#aiLog')?.textContent.includes(done), 'Chat completion');
  if (query('#aiBody').textContent.includes(internal)) throw Error('Provider continuation leaked into chat');
  if (!query('.msg-user .chat-image img')) throw Error('Sent photo missing from history');
  await waitFor(() => input.value === revised, 'Assistant edit in the currently open notebook');
  if (Object.keys(store.project.media).length) throw Error('Pasting in chat attached media to a story node');
  const edited = JSON.stringify(store.project);
  key('z');
  await waitFor(() => input.value === original && store.project.nodes.length === 1 && store.project.characters.length === 0 && store.project.locations.length === 0, 'Undo the whole chat edit');
  key('z', true);
  await waitFor(() => JSON.stringify(store.project) === edited, 'Redo the entire conversion');
  await waitFor(async () => {
    const recovery = await window.sf.autosave.read(store.documentKey);
    return recovery.ok && JSON.parse(recovery.content).screenplay === revised;
  }, 'Notebook content in project recovery');
  key('s');
  await waitFor(() => !store.dirty, 'Save converted screenplay');
  if (capture) await waitFor(() => !query('#toastRoot .toast'), 'Capture after save notifications close');
  return { project: store.project, errors: window.__sfErrors || [] };
}

async function readInApp() {
  const { store } = window.__sfTest;
  document.querySelector('[data-tab-kind="screenplay"]').click();
  return { project: store.project, text: document.querySelector('#screenplayText').value, errors: window.__sfErrors || [] };
}

async function startApp(output, profileName, projectFile, url, renderer) {
  const profile = path.join(output, profileName);
  await fs.mkdir(profile);
  const settings = { lastPath: projectFile, language: 'ru', autosave: true,
    ai: { preset: 'custom', baseUrl: url, model, apiKey: '' } };
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify(settings));
  const script = path.join(profile, 'probe.mjs');
  const screenshot = renderer === writeInApp && process.env.STORYFORGE_SCREENSHOT;
  await fs.writeFile(script, '__sfOut = await (' + renderer.toString() + ')(' + JSON.stringify({ original, revised, done, internal, capture: !!screenshot }) + ');');
  const configured = process.env.STORYFORGE_EXE;
  const runtime = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const args = ['--no-sandbox', '--user-data-dir=' + profile, ...(configured ? [] : ['.']), '--selftest', '--selftest-file=' + script];
  if (screenshot) args.push('--selftest-shot=screenplay');
  const env = { ...process.env, SF_USERDATA: profile, SF_TEST_OUTPUT: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(configured || runtime, args, { cwd: root, env, windowsHide: true, stdio: 'ignore' });
  const timeout = setTimeout(() => child.kill(), 50000);
  let result;
  try { result = await once(child, 'exit'); }
  finally { clearTimeout(timeout); }
  if (mockError) throw mockError;
  assert.equal(result[0], 0, 'Electron did not exit cleanly');
  const report = JSON.parse(await fs.readFile(path.join(profile, 'selftest.json'), 'utf8'));
  if (report.fatal) throw Error(report.fatal);
  assert.deepEqual(report.errors, []);
  if (screenshot) await fs.copyFile(path.join(profile, 'screenplay.png'), screenshot);
  return report;
}

server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const url = 'http://127.0.0.1:' + server.address().port + '/v1';
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'StoryForge-Screenplay-'));
  const first = path.join(output, 'story.sfproj');
  const copied = path.join(output, 'portable.sfproj');
  await fs.writeFile(first, JSON.stringify(createEmptyProject({
    meta: { title: 'Последний фонарь' },
    nodes: [{ id: 'author-note', type: 'note', title: 'Шум волн', text: 'Шорох воды под настилом.', position: { x: 100, y: 190 } }],
  })));
  const saved = await startApp(output, 'author-profile', first, url, writeInApp);
  assert.equal(rounds, 4);
  await fs.copyFile(first, copied);
  const fresh = await startApp(output, 'fresh-profile', copied, url, readInApp);
  assert.deepEqual(fresh.project, saved.project);
  assert.equal(fresh.text, revised);
  const { nodes, characters, locations } = fresh.project;
  assert.equal(characters.length, 1);
  assert.equal(locations.length, 1);
  assert.equal(nodes.length, 5);
  const byId = id => nodes.find(node => node.id === 'n_script_' + id);
  assert.equal(byId('dock').next, byId('call').id);
  assert.equal(byId('call').next, byId('reply').id);
  assert.equal(byId('reply').next, byId('finish').id);
  assert.equal(byId('reply').speakerId, characters[0].id);
  assert.equal(byId('call').speakerId, characters[0].id);
  assert.equal(byId('dock').locationId, locations[0].id);
  assert.equal(characters[0].name, 'Ира');
  assert.equal(locations[0].name, 'Причал');
  assert.equal(byId('reply').text, 'Подожду.');
  assert.deepEqual(nodes.find(node => node.id === 'author-note').position, { x: 100, y: 190 });
  assert.equal(new Set(nodes.map(node => node.position.x + ',' + node.position.y)).size, nodes.length);
  console.log('Passed: notebook, photo paste, API payloads, private continuation, atomic graph edits, undo/redo, autosave, Ctrl+S and fresh-profile reopen.');
  const tempRoot = await fs.realpath(os.tmpdir());
  const finished = await fs.realpath(output);
  assert.equal(path.dirname(finished), tempRoot);
  assert.ok(path.basename(finished).startsWith('StoryForge-Screenplay-'));
  await fs.rm(finished, { recursive: true });
} finally {
  server.close();
}
