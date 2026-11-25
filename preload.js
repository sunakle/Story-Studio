'use strict';
// Мост между рендерером и main-процессом. Никакого прямого доступа к fs/сети у рендерера нет.

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

const chunkListeners = new Set();
ipcRenderer.on('sf:ai:chunk', (_e, data) => {
  for (const cb of chunkListeners) {
    try {
      cb(data);
    } catch (err) {
      console.error('ai chunk listener error', err);
    }
  }
});

const menuListeners = new Set();
ipcRenderer.on('sf:menu', (_e, data) => {
  for (const cb of menuListeners) {
    try {
      cb(data);
    } catch (err) {
      console.error('menu listener error', err);
    }
  }
});

contextBridge.exposeInMainWorld('sf', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },

  file: {
    openDialog: () => invoke('sf:file:openDialog'),
    openPath: (p) => invoke('sf:file:openPath', p),
    save: (path, content) => invoke('sf:file:save', { path, content }),
    saveAs: (suggestedName, content) => invoke('sf:file:saveAs', { suggestedName, content }),
    recent: () => invoke('sf:file:recent'),
    recentAdd: (p) => invoke('sf:file:recentAdd', p),
    recentClear: () => invoke('sf:file:recentClear'),
  },

  settings: {
    get: () => invoke('sf:settings:get'),
    set: (patch) => invoke('sf:settings:set', patch),
  },

  autosave: {
    write: (content) => invoke('sf:autosave:write', content),
    read: (key) => invoke('sf:autosave:read', key),
    clear: (key) => invoke('sf:autosave:clear', key),
  },

  history: {
    read: (key) => invoke('sf:history:read', key),
    write: (messages, key) => invoke('sf:history:write', { messages, key }),
  },

  exportFiles: {
    chooseDir: (suggested) => invoke('sf:export:chooseDir', suggested),
    write: (dir, files) => invoke('sf:export:writeFiles', { dir, files }),
  },

  media: {
    pick: () => invoke('sf:media:pick'),
  },
  voiceLibrary: {
    list: () => invoke('sf:voiceLibrary:list'),
    load: id => invoke('sf:voiceLibrary:load', id),
    save: (name, voice, replaceId) => invoke('sf:voiceLibrary:save', { name, voice, replaceId }),
  },
  voice: {
    chooseDir: (suggested) => invoke('sf:voice:chooseDir', suggested),
    writeWav: (dir, name, bytes) => invoke('sf:voice:writeWav', { dir, name, bytes }),
    pickSample: () => invoke('sf:voice:pickSample'),
    reveal: (target) => invoke('sf:voice:reveal', target),
    saveWave: (name, bytes) => invoke('sf:voice:saveWave', { name, bytes }),
    makeDir: (dir, name) => invoke('sf:voice:makeDir', { dir, name }),
    savePreset: (name, text) => invoke('sf:voice:savePreset', { name, text }),
    openPreset: () => invoke('sf:voice:openPreset'),
  },

  ai: {
    chat: (payload) => invoke('sf:ai:chat', payload),
    abort: (requestId) => invoke('sf:ai:abort', requestId),
    test: (payload) => invoke('sf:ai:test', payload),
    onChunk: (cb) => {
      chunkListeners.add(cb);
      return () => chunkListeners.delete(cb);
    },
  },

  clipboard: {
    write: (text) => invoke('sf:clipboard:write', text),
    read: () => invoke('sf:clipboard:read'),
  },

  dialog: {
    message: (opts) => invoke('sf:dialog:message', opts),
  },

  app: {
    setDirty: (value) => invoke('sf:app:setDirty', value),
    info: () => invoke('sf:app:info'),
    closeReady: () => invoke('sf:app:closeReady'),
    quit: () => invoke('sf:app:quit'),
    showItem: (p) => invoke('sf:shell:showItem', p),
    openExternal: (url) => invoke('sf:shell:openExternal', url),
  },

  onMenu: (cb) => {
    menuListeners.add(cb);
    return () => menuListeners.delete(cb);
  },
});
