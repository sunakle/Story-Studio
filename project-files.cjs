'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID, createHash} = require('node:crypto');

const pending = new Map();
function inOrder(file, action) {
  const key = path.resolve(file).toLowerCase();
  const next = (pending.get(key) || Promise.resolve()).catch(() => {}).then(action);
  pending.set(key, next);
  return next.finally(() => { if (pending.get(key) === next) pending.delete(key); });
}

function atomicWrite(file, text) {
  return inOrder(file, async () => {
    await fs.mkdir(path.dirname(file), {recursive:true});
    const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
    try {
      const handle = await fs.open(temp, 'wx');
      try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temp, file);
    } finally { await fs.rm(temp, {force:true}); }
  });
}

function scopedFile(dir, kind, key) {
  const hash = createHash('sha256').update(String(key)).digest('hex');
  return path.join(dir, kind, hash + '.json');
}

// A draft has no chosen path yet. Keep a readable filename and a stable suffix
// so a retry can find it even after a restart or a change of the story's title.
function saveLocalProject(dir, { key, title, content }) {
  if (typeof key !== 'string' || !key || typeof content !== 'string') throw new Error('Missing project data');
  const project = JSON.parse(content);
  if (!Array.isArray(project?.nodes)) throw new Error('Invalid StoryForge project');
  const id = createHash('sha256').update(JSON.stringify([key, project.meta?.createdAt])).digest('hex').slice(0, 20);
  const suffix = ' — ' + id + '.sfproj';
  return inOrder(path.join(dir, '.draft-' + id), async () => {
    await fs.mkdir(dir, {recursive:true});
    const names = await fs.readdir(dir);
    const matches = names.filter(name => name.endsWith(suffix));
    if (matches.length > 1) throw new Error('Multiple local files match this draft');
    let name = matches[0];
    if (!name) {
      let base = String(title || '').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-').trim()
        .slice(0, 64).replace(/[. ]+$/u, '') || 'StoryForge';
      if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(base)) base = '_' + base;
      name = base + suffix;
    }
    const file = path.join(dir, name);
    await atomicWrite(file, content);
    return file;
  });
}

function recoveryFiles(userDir, skipDraft = () => false) {
  const legacy = path.join(userDir, 'autosave.sfproj');
  const pathFor = key => key ? scopedFile(userDir,'recovery',key) : legacy;
  return {
    async write(payload) {
      if (typeof payload === 'string') return atomicWrite(legacy, payload);
      const {key, filePath, content} = payload;
      if (!key || typeof content !== 'string') throw new Error('Нет данных для восстановления');
      return atomicWrite(pathFor(key), JSON.stringify({key,filePath,content}));
    },
    async read(key) {
      let candidates = [pathFor(key)];
      if (key == null) {
        const dir = path.join(userDir, 'recovery');
        const names = await fs.readdir(dir).catch(() => []);
        candidates.push(...names.filter(n => /^[0-9a-f]{64}\.json$/.test(n)).map(n => path.join(dir,n)));
      }
      const entries = await Promise.all(candidates.map(async file => {
        const stat = await fs.stat(file).catch(() => null);
        return stat && {file, time:stat.mtimeMs};
      }));
      for (const {file,time} of entries.filter(Boolean).sort((a,b)=>b.time-a.time)) {
        try {
          const raw = await fs.readFile(file,'utf8');
          const data = file === legacy ? {content:raw,key:null,filePath:null} : JSON.parse(raw);
          if (typeof data.content === 'string' && !skipDraft(data)) return {...data,ok:true,mtime:new Date(time).toISOString(),path:file};
        } catch { /* A different session may have cleared this recovery. */ }
      }
      return {ok:false};
    },
    clear(key) {
      const file = pathFor(key);
      return inOrder(file, () => fs.rm(file,{force:true}));
    }
  };
}
module.exports = {atomicWrite, scopedFile, recoveryFiles, saveLocalProject};
