'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { atomicWrite } = require('../../project-files.cjs');

const validId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
const idFor = name => createHash('sha256').update(name.normalize('NFKC').toLowerCase()).digest('hex');

function libraryError(code) {
  return Object.assign(new Error(code), { code });
}

function checkedVoice(voice) {
  if (!voice || !Number.isInteger(voice.preset) || !voice.params || typeof voice.params !== 'object' ||
      Array.isArray(voice.params) || !Object.values(voice.params).every(Number.isFinite)) {
    throw libraryError('INVALID_VOICE');
  }
  if (voice.sample != null) {
    const { name, data } = voice.sample;
    if (typeof name !== 'string' || typeof data !== 'string') throw libraryError('INVALID_VOICE');
    const header = Buffer.from(data.slice(0, 16), 'base64');
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw libraryError('INVALID_VOICE');
    }
  }
  return voice;
}

// A small name file lets the picker list a library without loading its WAV samples.
function createVoiceLibrary(profileDir) {
  const root = path.join(profileDir, 'voice-library');

  async function readName(id) {
    const name = JSON.parse(await fs.readFile(path.join(root, id, 'name.json'), 'utf8'));
    if (typeof name !== 'string' || idFor(name) !== id) throw libraryError('INVALID_ENTRY');
    return { id, name };
  }

  async function list() {
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const voices = await Promise.all(entries.filter(entry => entry.isDirectory() && validId(entry.name))
      .map(entry => readName(entry.name)));
    return voices.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function load(id) {
    if (!validId(id)) throw libraryError('INVALID_ENTRY');
    const data = await fs.readFile(path.join(root, id, 'voice.json'), 'utf8');
    return checkedVoice(JSON.parse(data));
  }

  async function save(inputName, descriptor, replaceId) {
    const name = typeof inputName === 'string' ? inputName.trim().normalize('NFC') : '';
    if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/u.test(name)) throw libraryError('INVALID_NAME');
    const id = idFor(name);
    const content = JSON.stringify(checkedVoice(descriptor));
    const destination = path.join(root, id);
    let existing;
    try { existing = await readName(id); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      if (replaceId !== id) return { ok: false, code: 'DUPLICATE', ...existing };
      await atomicWrite(path.join(destination, 'voice.json'), content);
      return { ok: true, ...existing };
    }
    if (replaceId) throw libraryError('INVALID_ENTRY');

    await fs.mkdir(root, { recursive: true });
    const temp = await fs.mkdtemp(path.join(root, '.pending-'));
    try {
      await fs.writeFile(path.join(temp, 'name.json'), JSON.stringify(name), 'utf8');
      await fs.writeFile(path.join(temp, 'voice.json'), content, 'utf8');
      // Publish both files together. An existing, non-empty directory cannot be replaced.
      try { await fs.rename(temp, destination); }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        const winner = await readName(id);
        return { ok: false, code: 'DUPLICATE', ...winner };
      }
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
    return { ok: true, id, name };
  }

  return { list, load, save };
}

module.exports = { createVoiceLibrary };
