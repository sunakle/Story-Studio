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
module.exports = {atomicWrite, scopedFile, recoveryFiles};
