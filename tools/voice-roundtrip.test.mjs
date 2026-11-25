import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { atomicWrite } from '../project-files.cjs';
import { createEmptyProject, migrateProject, Store } from '../src/js/model.js';
import { createVoice } from '../src/js/voice.js';
import { clearSampleCache, effectiveVoice, LINE_TARGET, packSample, sampleAudio, takeSeed } from '../src/js/voice/profile.js';
import { encodeWav } from '../src/js/voice/wav.js';

function tone(hz) {
  const frame = Float32Array.from({ length: 2205 }, (_, i) => 0.7 * Math.sin(2 * Math.PI * hz * i / 22050));
  return new Uint8Array(encodeWav([frame], 22050));
}

function edit(store, ...ops) {
  const result = store.apply(ops);
  assert.equal(result.ok, true, result.error);
}

test('A moved project replays its own character and line recordings, with no original WAV or cached voice', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storyforge-voice-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const original = path.join(dir, 'Голос.wav');
  const bytes = tone(330);
  await fs.writeFile(original, bytes);
  // fs.readFile may return a slice of a larger Node buffer.
  const sample = packSample(await fs.readFile(original), path.basename(original));
  assert.deepEqual(Buffer.from(sample.data, 'base64'), Buffer.from(bytes));
  const speaker = { preset: 2, params: { source: 1, speed: 24, start: 4, end: 90 }, sample };
  const line = { preset: 1, params: { source: 1, pitch: -3 }, sample: packSample(tone(730), 'take.wav'),
    output: { rate: 44100, channels: 1, bits: 24 } };
  const store = new Store();
  edit(store,
    { op: 'createCharacter', character: { id: 'actor', name: 'Аня' } },
    { op: 'createNode', node: { id: 'a', type: 'line', speakerId: 'actor', text: 'Привет!', next: 'b', position: { x: 18, y: 32 } } },
    { op: 'createNode', node: { id: 'b', type: 'line', speakerId: 'actor', text: 'Привет!', tags: ['финал'] } },
    { op: 'setVoice', id: 'actor', voice: speaker },
    { op: 'setVoice', nodeId: 'b', voice: line },
    { op: 'updateNode', id: 'b', patch: { voiceSeed: 41025 } },
    { op: 'addMedia', media: { id: 'pic', name: 'foto', data: 'data:image/png;base64,AA==' } },
    { op: 'setNodeMedia', id: 'a', media: ['pic'], previewId: 'pic' });
  const file = path.join(dir, 'project.sfproj');
  await atomicWrite(file, JSON.stringify(store.project));
  const moved = path.join(dir, 'moved.sfproj');
  await fs.rename(file, moved);
  await fs.unlink(original);
  let output;
  const previous = globalThis.window;
  t.after(() => previous === undefined ? delete globalThis.window : globalThis.window = previous);
  globalThis.window = { sf: { voice: { writeWav: async (_dir, _name, wav) => {
    output = Buffer.from(wav);
    return { ok: true };
  } } } };
  const ui = { settings: { voiceDir: dir }, toast(message, kind) { assert.notEqual(kind, 'bad', message); } };
  const panel = createVoice({ store, ui, root: null });
  const render = async id => { output = null; await panel.exportNode(id); assert.ok(output?.length > 44); return output; };
  const a = await render('a'), b = await render('b');
  assert.notDeepEqual(a, b);
  assert.equal(b.readUInt32LE(24), 44100);
  assert.equal(b.readUInt16LE(22), 1);
  assert.equal(b.readUInt16LE(34), 24);
  const before = store.snapshot();
  store.setProject(createEmptyProject());
  clearSampleCache();
  const reopened = migrateProject(JSON.parse(await fs.readFile(moved, 'utf8'))).project;
  store.setProject(reopened);
  assert.deepEqual(store.project, before);
  assert.deepEqual(await render('a'), a);
  assert.deepEqual(await render('b'), b);
  assert.equal(sampleAudio(store.project.characters[0].voice.sample).rate, 22050);
  edit(store, { op: 'setVoice', id: 'actor', voice: { ...speaker, sample: line.sample } });
  assert.notDeepEqual(await render('a'), a);
  assert.deepEqual(await render('b'), b);
  assert.equal(store.undo().ok, true);

  edit(store, { op: 'setVoice', nodeId: 'b', voice: null });
  assert.deepEqual(effectiveVoice(store.project, LINE_TARGET, store.project.nodes[1]), speaker);
  assert.notDeepEqual(await render('b'), b);
  assert.equal(store.undo().ok, true);
  assert.deepEqual(await render('b'), b);
  assert.equal(store.redo().ok, true);
  edit(store, { op: 'setVoice', id: 'actor', voice: null });
  assert.deepEqual(effectiveVoice(store.project, LINE_TARGET, store.project.nodes[1]), store.project.voice);
  assert.equal(takeSeed(store.project.nodes[1], store.project.voice), 41025);
});

test('Older projects keep factory voices, line defaults and repeatable takes', () => {
  const p = migrateProject({ characters: [{ id: 'old', voice: { preset: 1, params: { speed: 19 } } }],
    nodes: [{ id: 'n', type: 'line', text: 'Строка', speakerId: 'old' }] }).project;
  assert.deepEqual(effectiveVoice(p, LINE_TARGET, p.nodes[0]), { preset: 1, params: { speed: 19 } });
  assert.equal(takeSeed(p.nodes[0], p.characters[0].voice), takeSeed({ ...p.nodes[0] }, p.characters[0].voice));
  assert.equal(takeSeed(p.nodes[0], { seed: 42 }), 42);
  assert.equal(takeSeed({ ...p.nodes[0], voiceSeed: 11 }, { seed: 42 }), 11);
});
