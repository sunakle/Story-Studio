import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStoryFixture } from './test-fixtures.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { Store, migrateProject } from '../src/js/model.js';
import { planProjectEdits } from '../src/js/ai-transaction.js';
import { createAI } from '../src/js/ai.js';
import { renderLine } from '../src/js/voice/render.js';
import { synthesize } from '../src/js/voice/job.js';

const sample = makeStoryFixture();
const makeStore = () => {
  const s = new Store();
  s.setProject(migrateProject(sample).project, { filePath: 'A.sfproj' });
  return s;
};

test('AI conflicting author edit is retained without a partial commit', () => {
  const store = makeStore();
  const plan = planProjectEdits(store);
  const id = store.project.startNodeId;
  plan.apply([{ op: 'updateNode', id, patch: { text: 'AI' } }]);
  store.apply([{ op: 'updateNode', id, patch: { text: 'Автор' } }]);
  assert.throws(() => plan.commit('AI'), /вручную/);
  assert.equal(store.project.nodes.find(n => n.id === id).text, 'Автор');
});

test('manual media and voice changes survive applying and undoing a pending AI text edit', () => {
  const store = makeStore();
  const id = store.project.startNodeId;
  const original = store.project.nodes.find(n => n.id === id).text;
  const plan = planProjectEdits(store);
  plan.apply([{ op: 'updateNode', id, patch: { text: 'AI' } }]);
  const image = { id: 'm_manual', data: 'data:image/png;base64,AA==', name: 'manual.png', w: 1, h: 1 };
  const manualVoice = { preset: 3, params: { pitch: 1 } };
  const res = store.apply([
    { op: 'addMedia', media: image },
    { op: 'setNodeMedia', id, media: [image.id], previewId: image.id },
    { op: 'setVoice', voice: manualVoice },
  ]);
  assert.ok(res.ok, res.error);
  const manual = store.snapshot();
  plan.commit('AI');
  assert.equal(store.project.nodes.find(n => n.id === id).text, 'AI');
  assert.equal(store.project.nodes.find(n => n.id === id).previewId, image.id);
  store.undo();
  assert.equal(store.project.nodes.find(n => n.id === id).text, original);
  assert.deepEqual(store.project, manual);
});

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

function chatApp(store, chat) {
  const history = new Map();
  globalThis.window = { sf: { ai: { chat, abort: () => {} }, history: {
    write: (items, key) => history.set(key, structuredClone(items)),
    read: key => history.get(key) || [],
  } } };
  const app = createAI({ root: null, store, ui: {
    escapeHTML: String, settings: { ai: { baseUrl: 'http://127.0.0.1/v1', model: 'mock' } },
  } });
  return { app, history };
}

test('late response cannot edit or write the history of another project', async () => {
  const store = makeStore();
  const pending = deferred();
  const entered = deferred();
  const { app, history } = chatApp(store, () => { entered.resolve(); return pending.promise; });
  const sending = app.send('Создай узел');
  await entered.promise;
  store.setProject(migrateProject(sample).project, { filePath: 'B.sfproj' });
  const before = store.snapshot();
  pending.resolve({ ok: true, toolCalls: [{ id: 'old', name: 'create_node', arguments: '{"type":"note"}' }] });
  await sending;
  assert.deepEqual(store.project, before);
  assert.equal(store.canUndo(), false);
  assert.equal(history.has('B.sfproj'), false);
});

test('9-round HTTP mock conversation: coherent tool history, one undo, independent manual edit', async t => {
  const portProbe = net.createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./mock-ai-server.mjs', import.meta.url)), '--port=' + port],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => child.kill());
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(([code]) => { throw new Error('mock exited ' + code); }),
  ]);
  const store = makeStore();
  const before = store.snapshot();
  const sent = [];
  const { app, history } = chatApp(store, async ({ body }) => {
    const pending = new Set();
    for (const m of body.messages) {
      if (m.role === 'tool') assert.ok(pending.delete(m.tool_call_id), 'orphaned tool result');
      else {
        assert.equal(pending.size, 0, 'missing tool responses');
        for (const tc of m.tool_calls || []) pending.add(tc.id);
      }
    }
    assert.equal(pending.size, 0);
    if (sent.length === 1) {
      store.apply([{ op: 'updateNode', id: before.startNodeId, patch: { title: 'Ручное название' } }]);
    }
    sent.push(body);
    const response = await fetch('http://127.0.0.1:' + port + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-mock-script': 'e2e', 'x-mock-delay': '10' },
      body: JSON.stringify({ ...body, stream: false }),
    });
    const m = (await response.json()).choices[0].message;
    return { ok: true, content: m.content, toolCalls: m.tool_calls?.map(call => ({ id: call.id, ...call.function })) };
  });
  await app.send('Создай персонажа и три узла, измени старт и проверь сюжет');
  assert.equal(sent.length, 9);
  assert.equal(store.project.characters.length, before.characters.length + 1);
  assert.equal(store.project.nodes.length, before.nodes.length + 3);
  assert.equal(store.project.nodes.find(n => n.id === before.startNodeId).title, 'Ручное название');
  assert.equal(store.undo().ok, true);
  const expected = structuredClone(before);
  expected.nodes.find(n => n.id === before.startNodeId).title = 'Ручное название';
  assert.deepEqual(store.project, expected);
  assert.equal(history.get('A.sfproj').filter(m => m.role === 'assistant' && m.toolCalls?.length).length, 8);
});

test('cooperative fallback has identical seeded PCM and yields during long synthesis', async () => {
  const options = { text: 'Ты всё ещё здесь? Ответь мне. '.repeat(18), seed: 123, mode: 'line' };
  const reference = renderLine(options);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    const take = await synthesize(options);
    assert.deepEqual(take.left, reference.left);
    assert.deepEqual(take.right, reference.right);
    assert.ok(ticks > 1, 'event loop responded while rendering');
  } finally {
    clearInterval(timer);
  }
});

test('export preserves text beyond the 600-character preview boundary and can be cancelled', async () => {
  const options = { text: 'б'.repeat(601), params: { speed: 22 }, seed: 1, mode: 'line' };
  const rendered = await synthesize(options);
  assert.equal(rendered.text, options.text);
  const abort = new AbortController();
  const job = synthesize(options, { signal: abort.signal });
  abort.abort();
  await assert.rejects(job, { name: 'AbortError' });
});

test('switching languages refreshes voice metadata and preserves story text and saved type queries', async () => {
  const { setLanguage } = await import('../src/js/i18n.js');
  const { TYPE_LABELS, plural } = await import('../src/js/model.js');
  const { compileNodeQuery, jumpCandidates } = await import('../src/js/story-search.js');
  const voice = await import('../src/js/voice/params.js');
  const { formatSeconds } = await import('../src/js/voice/wav.js');
  const doc = makeStore().project;
  doc.nodes[0].title = 'Настройки';
  const snapshot = JSON.stringify(doc);
  const matching = lang => {
    setLanguage(lang);
    return doc.nodes.filter(compileNodeQuery(doc, 'type:реплика').matches).map(n => n.id);
  };
  const labels = () => [voice.TABS[0], voice.SPECS.find(s => s.id === 'osc1wave').label,
    voice.SPECS.find(s => s.id === 'b3gain').label, TYPE_LABELS.line];
  try {
    const ids = matching('ru'), russian = labels();
    assert.ok(ids.length > 0);
    assert.deepEqual(matching('en'), ids);
    assert.deepEqual(labels(), ['Voice', 'Oscillator 1 · waveform', 'Midrange 2 · gain', 'Line']);
    assert.equal(plural(21, ['node', 'nodes', 'nodes']), 'nodes');
    assert.equal(formatSeconds(1.5), '1.5 s');
    assert.equal(jumpCandidates(doc).find(row => row.id === doc.nodes[0].id).title, 'Настройки');
    assert.deepEqual(matching('ru'), ids);
    assert.deepEqual(labels(), russian);
    assert.equal(JSON.stringify(doc), snapshot);
  } finally { setLanguage('ru'); }
});
