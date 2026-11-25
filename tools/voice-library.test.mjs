import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVoiceLibrary } from '../src/native/voice-library.cjs';
import { atomicWrite } from '../project-files.cjs';
import { createEmptyProject, migrateProject, Store } from '../src/js/model.js';
import { encodeWave } from '../src/js/voice/wav.js';

async function profile(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storyforge-voice-library-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const wav = encodeWave({ left: new Float32Array([0, .2, -.1, 0]), channels: 1, rate: 22050 });
const voice = {
  preset: 2, params: { source: 1, pitch: -4.5 }, seed: 402145,
  sample: { name: 'Актёр.wav', data: Buffer.from(wav).toString('base64') },
  output: { rate: 44100, channels: 1, bits: 16 },
};

test('a character voice is available after restart and an independent copy reopens in a different project', async t => {
  const dir = await profile(t);
  const library = createVoiceLibrary(dir);
  const a = new Store();
  a.setProject(createEmptyProject());
  assert.equal(a.apply([{ op: 'createCharacter', character: { id: 'actor', name: 'Актёр', voice } }]).ok, true);
  const entry = await library.save('Тихий голос', a.project.characters[0].voice);
  assert.equal(entry.ok, true);

  const reopenedLibrary = createVoiceLibrary(dir);
  assert.deepEqual(await reopenedLibrary.list(), [{ id: entry.id, name: 'Тихий голос' }]);
  const b = new Store();
  b.setProject(createEmptyProject());
  const copy = await reopenedLibrary.load(entry.id);
  assert.deepEqual(copy, voice);
  assert.equal(b.apply([
    { op: 'createNode', node: { id: 'line', type: 'line', text: 'Привет' } },
    { op: 'setVoice', nodeId: 'line', voice: copy },
  ]).ok, true);
  const projectPath = path.join(dir, 'second.sfproj');
  await atomicWrite(projectPath, JSON.stringify(b.project));
  assert.equal((await reopenedLibrary.save('Тихий голос', { preset: 0, params: {} }, entry.id)).ok, true);
  assert.equal((await reopenedLibrary.load(entry.id)).preset, 0);
  const reopened = migrateProject(JSON.parse(await fs.readFile(projectPath, 'utf8'))).project;
  assert.deepEqual(reopened.nodes[0].voice, voice);
  assert.equal(reopened.nodes[0].text, 'Привет');
  assert.deepEqual(Buffer.from(reopened.nodes[0].voice.sample.data, 'base64'), Buffer.from(wav));
});

test('simultaneous saves publish one complete voice; duplicates require explicit replacement', async t => {
  const library = createVoiceLibrary(await profile(t));
  assert.deepEqual(await library.list(), []);
  const old = { preset: 0, params: {} };
  const results = await Promise.all([library.save(' Echo ', old), library.save('ＥＣＨＯ', voice)]);
  const winner = results.find(i => i.ok), duplicate = results.find(i => !i.ok);
  assert.equal(duplicate.code, 'DUPLICATE');
  assert.deepEqual(Object.keys(duplicate).sort(), ['code', 'id', 'name', 'ok']);
  assert.equal(duplicate.id, winner.id);
  const original = results[0].ok ? old : voice;
  const replacement = results[0].ok ? voice : old;
  assert.deepEqual(await library.list(), [{ id: winner.id, name: winner.name }]);
  assert.deepEqual(await library.load(winner.id), original);
  assert.equal((await library.save('echo', replacement, 'wrong id')).code, 'DUPLICATE');
  assert.deepEqual(await library.load(winner.id), original);
  assert.equal((await library.save('echo', replacement, winner.id)).ok, true);
  assert.deepEqual(await library.load(winner.id), replacement);
});

test('invalid descriptors and names preserve existing voices; listing needs only their names', async t => {
  const dir = await profile(t), library = createVoiceLibrary(dir);
  const saved = await library.save('Первый', voice);
  await assert.rejects(library.save('  ', voice), { code: 'INVALID_NAME' });
  await assert.rejects(library.save('x'.repeat(121), voice), { code: 'INVALID_NAME' });
  await assert.rejects(library.load('../another-file'), { code: 'INVALID_ENTRY' });
  await assert.rejects(library.save('Первый', { ...voice, sample: { name: 'x', data: 'broken' } }, saved.id), { code: 'INVALID_VOICE' });
  assert.deepEqual(await library.load(saved.id), voice);
  await fs.unlink(path.join(dir, 'voice-library', saved.id, 'voice.json'));
  assert.deepEqual(await library.list(), [{ id: saved.id, name: saved.name }]);
  await assert.rejects(library.load(saved.id), { code: 'ENOENT' });
});
