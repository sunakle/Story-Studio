import { getLanguage, t } from './i18n.js';
import { projectDesigns } from './model.js';

const prefix = 'storyforge:gigma-';
const preferencesKey = 'storyforge/gigma/preferences/1';
const theme = () => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

function preferences() {
  try { return JSON.parse(localStorage.getItem(preferencesKey)); } catch { return null; }
}

/** Keep each open document's canvas, selection and undo history alive while switching tabs. */
export function createGigmaHost(store, ui, stage) {
  const surface = document.createElement('div');
  surface.className = 'gigma-surface';
  surface.hidden = true;
  stage.append(surface);
  const frames = new Map();
  let visible = null;
  const workspace = id => projectDesigns(store.project).find(item => item.id === id);
  const active = entry => visible === entry.id && !surface.hidden;
  const projectName = () => store.project.meta.title || t('Новый проект', 'New project');
  let lastName = projectName();

  function post(entry, type, payload = {}) {
    entry.frame.contentWindow?.postMessage({type: prefix + type, session: entry.session, ...payload}, '*');
  }

  function dispose(entry) {
    if (frames.get(entry.id) !== entry) return;
    frames.delete(entry.id);
    clearTimeout(entry.loadTimer);
    entry.pending?.finish(false);
    entry.panel.remove();
  }

  function mount(item) {
    const panel = document.createElement('div');
    panel.className = 'gigma-panel';
    const frame = document.createElement('iframe');
    frame.className = 'gigma-frame';
    frame.title = 'Gigma Studio — ' + projectName();
    frame.setAttribute('sandbox', 'allow-scripts allow-downloads');
    frame.src = location.protocol === 'file:' ? 'sf-gigma://studio/index.html'
      : new URL('gigma/index.html', document.baseURI).href;
    const entry = {id:item.id, generation:store.generation, frame, panel, session:crypto.randomUUID(),
      model:item.document, ready:false, loaded:false, applying:false, pending:null};
    frames.set(item.id, entry);
    panel.hidden = !active(entry);
    panel.append(frame);
    const feedback = document.createElement('div');
    feedback.className = 'gigma-feedback';
    feedback.setAttribute('role', 'status');
    feedback.textContent = t('Открываем макет…', 'Opening design…');
    panel.append(feedback);
    entry.feedback = feedback;
    entry.loadTimer = setTimeout(() => showFailure(entry, t('Редактор Gigma не ответил.', 'The Gigma editor did not respond.')), 12000);
    surface.append(panel);
    return entry;
  }

  function showFailure(entry, reason) {
    clearTimeout(entry.loadTimer);
    entry.feedback.hidden = false;
    entry.feedback.textContent = reason;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-sm';
    retry.textContent = t('Повторить', 'Retry');
    retry.onclick = () => {
      const item = workspace(entry.id);
      dispose(entry);
      if (item && visible === item.id) mount(item);
    };
    entry.feedback.append(retry);
  }

  function capture(entry, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    // A null design represents a pristine canvas. Opening or saving it must not
    // manufacture an edit and destroy the user's redo stack after undo.
    if (entry.model === null && entry.pristine && value.revision === 0 && JSON.stringify(value) === entry.pristine) return true;
    entry.applying = true;
    try {
      const existing = store.project.gigmaWorkspaces.some(item => item.id === entry.id);
      const op = existing ? {op:'updateGigmaWorkspace', id:entry.id, document:value}
        : {op:'createGigmaWorkspace', id:entry.id, name:'Gigma Studio', document:value};
      const result = store.apply(op, {label:t('Правка макета Gigma', 'Edit Gigma design')});
      if (!result.ok) ui.toast(result.error, 'bad');
      entry.model = workspace(entry.id)?.document;
      return result.ok;
    } finally { entry.applying = false; }
  }

  function flush(entry) {
    if (!entry.loaded) return Promise.resolve(true);
    if (entry.pending) return entry.pending.promise;
    const requestId = crypto.randomUUID();
    let finish;
    const promise = new Promise(resolve => { finish = resolve; });
    const timer = setTimeout(() => entry.pending?.finish(false), 8000);
    entry.pending = {requestId, promise, finish(ok) {
      clearTimeout(timer);
      entry.pending = null;
      finish(ok);
    }};
    post(entry, 'flush', {requestId});
    return promise;
  }

  async function illustrator(entry, data) {
    if (typeof data.requestId !== 'string' || data.requestId.length > 128) return;
    let result = null, error;
    try {
      if (!active(entry) || document.activeElement !== entry.frame || entry.nativeBusy) {
        throw new Error(t('Сначала откройте нужный макет.', 'Focus this design first.'));
      }
      entry.nativeBusy = true;
      try {
        if (data.action === 'open') result = await window.sf.gigma.openIllustrator();
        else if (data.action === 'export' && data.job?.mode === 'export') result = await window.sf.gigma.exportIllustrator(data.job);
        else throw new Error(t('Неизвестная команда Illustrator.', 'Unknown Illustrator action.'));
      } finally { entry.nativeBusy = false; }
    } catch (err) { error = String(err?.message || err); }
    if (frames.get(entry.id) === entry) post(entry, 'illustrator-result', {requestId:data.requestId, result, error});
  }

  window.addEventListener('message', event => {
    const data = event.data;
    if (event.origin !== 'null' || typeof data?.type !== 'string' || !data.type.startsWith(prefix)) return;
    const entry = [...frames.values()].find(item => item.frame.contentWindow === event.source);
    const item = entry && workspace(entry.id);
    if (!item || entry.generation !== store.generation) return;
    const action = data.type.slice(prefix.length);
    if (action === 'ready') {
      if (!entry.ready) {
        entry.ready = true;
        post(entry, 'load', {document:item.document, name:item.name, projectName:projectName(), language:getLanguage(), theme:theme(), preferences:preferences()});
      }
      return;
    }
    if (!entry.ready || data.session !== entry.session) return;
    switch (action) {
      case 'loaded':
        clearTimeout(entry.loadTimer);
        entry.feedback.hidden = true;
        entry.loaded = true;
        if (entry.model === null && data.document) entry.pristine = JSON.stringify(data.document);
        if (entry.reveal) {
          post(entry, 'reveal', entry.reveal);
          entry.reveal = null;
        }
        break;
      case 'selection':
      case 'copy-reference': {
        if (!active(entry) || typeof data.pageId !== 'string' || !Array.isArray(data.objectIds)) break;
        entry.pageId = data.pageId;
        entry.references = data.objectIds.filter(id => typeof id === 'string' && id.length > 0)
          .map(objectId => ({kind:'gigma', workspaceId:entry.id, pageId:data.pageId, objectId}));
        if (action === 'copy-reference' && entry.references.length && document.activeElement === entry.frame) {
          void ui.workbench?.copyReferences(entry.references);
        }
        break;
      }
      case 'change':
        capture(entry, data.document);
        break;
      case 'flushed':
        if (entry.pending && entry.pending.requestId === data.requestId) entry.pending.finish(capture(entry, data.document));
        break;
      case 'save':
        if (active(entry)) ui.saveProject(data.saveAs === true);
        break;
      case 'project-command':
        if (!active(entry) || document.activeElement !== entry.frame) break;
        if (data.command === 'new') ui.newProject();
        else if (data.command === 'open') ui.openProject();
        else if (data.command === 'undo' || data.command === 'redo') store.stepDesignHistory(data.command, entry.id);
        break;
      case 'preferences':
        if (active(entry) && data.preferences && typeof data.preferences === 'object' && !Array.isArray(data.preferences)) {
          try {
            const json = JSON.stringify(data.preferences);
            if (json.length <= 3 * 1024 * 1024) localStorage.setItem(preferencesKey, json);
          } catch { ui.toast(t('Не удалось сохранить настройки Gigma.', 'Could not save Gigma preferences.'), 'warn'); }
        }
        break;
      case 'illustrator':
        void illustrator(entry, data);
        break;
      case 'error':
        if (entry.pending && entry.pending.requestId === data.requestId) entry.pending.finish(false);
        {
          const reason = String(data.message || t('Не удалось открыть макет.', 'Could not open the design.'));
          if (!entry.loaded) showFailure(entry, reason);
          else ui.toast(reason, 'bad');
        }
        break;
    }
  });

  function show(id) {
    if (visible !== id) {
      const previous = frames.get(visible);
      if (previous) {
        previous.panel.hidden = true;
        void flush(previous);
      }
    }
    visible = id;
    surface.hidden = !id;
    if (!id) return;
    const item = workspace(id);
    if (!item) return;
    const entry = frames.get(id) || mount(item);
    entry.panel.hidden = false;
  }

  function sync() {
    for (const entry of [...frames.values()]) {
      const item = workspace(entry.id);
      if (!item) dispose(entry);
      else if (!entry.applying && entry.model !== item.document) {
        // A host undo or redo replaced this document. Discard messages from its old editor.
        dispose(entry);
        if (visible === item.id) mount(item);
      }
    }
  }

  function appearance() {
    syncName();
    for (const entry of frames.values()) {
      if (entry.ready) post(entry, 'appearance', {theme:theme(), language:getLanguage()});
    }
  }
  function syncName() {
    const name = projectName();
    if (lastName === name) return;
    lastName = name;
    for (const entry of frames.values()) {
      entry.frame.title = 'Gigma Studio — ' + name;
      if (entry.ready) post(entry, 'project-name', {projectName:name});
    }
  }
  new MutationObserver(appearance).observe(document.documentElement, {attributes:true, attributeFilter:['data-theme']});

  return {
    show, sync, syncName, appearance,
    references(id) { return frames.get(id)?.references || []; },
    pageId(id) {
      const document = workspace(id)?.document, selected = frames.get(id)?.pageId;
      return document?.pages.some(page => page.id === selected) ? selected : document?.activePageId;
    },
    reveal({workspaceId, pageId, objectId, playAnimation = false}) {
      const entry = frames.get(workspaceId);
      if (!entry) return;
      if (entry.loaded) post(entry, 'reveal', {pageId, objectId, playAnimation});
      else entry.reveal = {pageId, objectId, playAnimation};
    },
    focus(id) { frames.get(id)?.frame.focus({preventScroll:true}); },
    async flushAll() { return (await Promise.all([...frames.values()].map(flush))).every(Boolean); },
    async close(id) {
      const entry = frames.get(id);
      if (entry && !await flush(entry)) return false;
      if (entry) dispose(entry);
      return true;
    },
    reset() { for (const entry of [...frames.values()]) dispose(entry); show(null); },
  };
}
