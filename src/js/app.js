import { t as uiText, getLanguage, setLanguage } from './i18n.js';
import { bindShellLanguage } from './shell-strings.js';
// StoryForge — bootstrap рендерера: тулбар, хоткеи, автосохранение, статусбар, склейка модулей.
import {
  store,
  createEmptyProject,
  migrateProject,
  validateProject,
  plural,
  countWords,
  TYPE_LABELS,
} from './model.js';
import { createGraph } from './graph.js';
import { requestInsertion, showPlayback } from './story-player.js';
import { askBeforeClosing } from './close-prompt.js';
import { createInspector } from './inspector.js';
import { createPanels } from './panels.js';
import { createWorkbench } from './workbench.js';
import { initWorkspaceShell } from './workspace-shell.js';
import { createAI } from './ai.js';
import { createVoice } from './voice.js';
import { createVoiceStudio } from './voice-studio.js';
import { createVisualizer } from './visualizer.js';
import { buildExport } from './export.js';
import { icon } from './icons.js';
import { pickImages, filesToMedia, clipboardImages, formatBytes } from './media.js';

const $ = (id) => document.getElementById(id);
const devLog = (...a) => {
  if (window.__SF_DEV__) console.log('[sf]', ...a);
};

// Сбор ошибок рендерера: main-процесс читает их в режиме авто-приёмки
// (`electron . --smoke-shot`) и пишет в .logs/main.log.
window.__sfErrors = [];
window.addEventListener('error', (e) => {
  window.__sfErrors.push(`${e.message} @ ${e.filename}:${e.lineno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  window.__sfErrors.push(`unhandled rejection: ${(r && r.message) || r}`);
});

const state = {
  settings: null,
  issues: [],
  autosaveTimer: null,
  validateTimer: null,
  lastAutosave: null,
  booted: false,
  jumpQuery: '',
};

// ------------------------------------------------------------------ утилиты

function escapeHTML(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html).trim();
  return tpl.content.firstElementChild;
}

function debounce(fn, ms = 150) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

// Track only model-bound inputs. Saving, changing context and undo can
// commit their latest value synchronously before consuming the project.
const pendingEdits = new Set();
function editAfterPause(fn, delay = 150) {
  let timer, args, generation;
  function flush() {
    clearTimeout(timer);
    if (!pendingEdits.delete(flush)) return;
    if (generation === store.generation) fn(...args);
  }
  return (...values) => {
    args = values;
    generation = store.generation;
    pendingEdits.add(flush);
    window.sf.app.setDirty(true);
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
  };
}
function flushEdits() { for (const flush of [...pendingEdits]) flush(); }

function highlight(text, query, opts = {}) {
  const src = String(text ?? '');
  const q = String(query ?? '');
  if (!q) return escapeHTML(src);
  let re;
  try {
    const body = opts.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(body, opts.caseSensitive ? 'g' : 'gi');
  } catch {
    return escapeHTML(src);
  }
  let out = '';
  let last = 0;
  let m;
  let guard = 0;
  while ((m = re.exec(src)) && guard++ < 200) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    out += escapeHTML(src.slice(last, m.index)) + '<mark>' + escapeHTML(m[0]) + '</mark>';
    last = m.index + m[0].length;
  }
  out += escapeHTML(src.slice(last));
  return out;
}

// ------------------------------------------------------------------ тосты и модалки

function toast(text, kind = 'info', ms = 3200) {
  const node = el(`<div class="toast ${kind}">${escapeHTML(text)}</div>`);
  $('toastRoot').appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .2s';
    setTimeout(() => node.remove(), 220);
  }, ms);
}

let modalStack = [];

function modal({ title = '', body = '', buttons = [], wide = false, onClose = null }) {
  const previousFocus = document.activeElement;
  const root = $('modalRoot');
  root.classList.remove('hidden');
  const wrap = el(`
    <div role="dialog" aria-modal="true" aria-label="${escapeHTML(title)}" class="modal-card ${wide ? 'wide' : ''}">
      <div class="modal-head">
        <div class="modal-title">${escapeHTML(title)}</div>
        <div class="grow"></div>
        <button class="tb-icon" type="button" data-close aria-label="${uiText("Закрыть", "Close")}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </div>
      <div class="modal-body"></div>
      <div class="modal-foot"></div>
    </div>
  `);
  const bodyHost = wrap.querySelector('.modal-body');
  if (typeof body === 'string') bodyHost.innerHTML = body;
  else if (body) bodyHost.appendChild(body);

  const foot = wrap.querySelector('.modal-foot');
  const api = {
    close() {
      wrap.remove();
      modalStack = modalStack.filter((m) => m !== api);
      if (!modalStack.length) root.classList.add('hidden');
      if (previousFocus?.isConnected) previousFocus.focus({preventScroll:true});
      if (onClose) onClose();
    },
    body: bodyHost,
  };

  for (const b of buttons) {
    const btn = el(`<button class="btn ${b.kind === 'primary' ? 'btn-primary' : ''} ${b.kind === 'danger' ? 'btn-danger' : ''}" type="button">${escapeHTML(b.label)}</button>`);
    btn.addEventListener('click', () => {
      if (b.onClick) b.onClick(api);
      else api.close();
    });
    foot.appendChild(btn);
  }
  if (!buttons.length) {
    const btn = el(uiText("<button class=\"btn btn-primary\" type=\"button\">Закрыть</button>", "<button class=\"btn btn-primary\" type=\"button\">Close</button>"));
    btn.addEventListener('click', () => api.close());
    foot.appendChild(btn);
  }

  wrap.querySelector('[data-close]').addEventListener('click', () => api.close());
  wrap.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...wrap.querySelectorAll('button,input,textarea,select,[tabindex="0"]')]
      .filter(control => !control.disabled && control.tabIndex >= 0 && control.getClientRects().length);
    const edge = event.shiftKey ? controls[0] : controls.at(-1);
    if (edge && document.activeElement === edge) {
      event.preventDefault();
      (event.shiftKey ? controls.at(-1) : controls[0]).focus();
    }
  });
  root.appendChild(wrap);
  modalStack.push(api);
  const firstInput = wrap.querySelector('input, textarea, select');
  if (firstInput) setTimeout(() => { if (wrap.isConnected && modalStack.at(-1) === api) firstInput.focus(); }, 30);
  return api;
}

function confirmDialog(message, { detail = '', danger = false, okLabel = uiText("Удалить", "Delete"), cancelLabel = uiText("Отмена", "Cancel"), title = '' } = {}) {
  return new Promise((resolve) => {
    // Важно: сначала фиксируем ответ, потом закрываем окно. close() вызывает
    // onClose, и если разрешать промис после close(), то onClose успевал бы
    // вернуть false — любое подтверждение превращалось в отмену.
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const m = modal({
      title: title || (danger ? uiText("Удаление", "Delete") : uiText("Подтверждение", "Confirm")),
      body: `<p style="margin:0 0 6px">${escapeHTML(message)}</p>${detail ? `<p class="hint-text">${escapeHTML(detail)}</p>` : ''}`,
      buttons: [
        {
          label: cancelLabel,
          onClick: (api) => {
            settle(false);
            api.close();
          },
        },
        {
          label: okLabel,
          kind: danger ? 'danger' : 'primary',
          onClick: (api) => {
            settle(true);
            api.close();
          },
        },
      ],
      onClose: () => settle(false),
    });
    m.body.closest('.modal-card').querySelector('.modal-foot').lastElementChild.focus();
  });
}

// ------------------------------------------------------------------ статусбар

function updateStatus() {
  const p = store.project;
  const file = store.filePath
    ? store.filePath.split(/[\\/]/).pop()
    : p.meta?.title
      ? `${p.meta.title} · ${uiText("не сохранён", "unsaved")}`
      : uiText("без имени", "untitled");
  $('stFile').textContent = file;
  $('stDirty').classList.toggle('hidden', !store.dirty);
  const words = (p.nodes || []).reduce((sum, n) => sum + (n.type === 'note' ? 0 : countWords(n.text)), 0);
  const nodes = (p.nodes || []).length;
  $('stCounts').textContent = `${nodes} ${plural(nodes, [uiText("узел", "node"), uiText("узла", "nodes"), uiText("узлов", "nodes")])} • ${words.toLocaleString(getLanguage())} ${plural(words, [uiText("слово", "word"), uiText("слова", "words"), uiText("слов", "words")])}`;
  $('stAutosave').textContent = state.lastAutosave ? `${uiText("Автосохранено", "Autosaved")} ${state.lastAutosave}` : '';
  const errors = state.issues.filter((i) => i.severity === 'error').length;
  const warnings = state.issues.filter((i) => i.severity === 'warning').length;
  const stIssues = $('stIssues');
  const total = errors + warnings;
  stIssues.classList.toggle('has-errors', errors > 0);
  stIssues.classList.toggle('has-warnings', !errors && warnings > 0);
  const unit = plural(total, [uiText("проблема", "issue"), uiText("проблемы", "issues"), uiText("проблем", "issues")]);
  $('issueIcon').innerHTML = icon(total ? 'alert' : 'check', 12);
  $('badgeIssues').textContent = String(total);
  $('issueUnit').textContent = unit;
  stIssues.title = total ? `${uiText("Ошибок", "Errors")}: ${errors}. ${uiText("Предупреждений", "Warnings")}: ${warnings}. ${uiText("Открыть проверку", "Open validation")} (F5)` : uiText("Проблем нет. Открыть проверку (F5)", "No issues. Open validation (F5)");
  $('btnUndo').disabled = !store.canUndo();
  $('btnRedo').disabled = !store.canRedo();
  // не затираем заголовок, пока пользователь его набирает
  const titleInput = $('projectTitle');
  if (document.activeElement !== titleInput) titleInput.value = p.meta?.title || uiText("Новый проект", "New project");
}

function runValidation({ show = false } = {}) {
  state.issues = validateProject(store.project);
  if (show) {
    if (ui.workbench?.current() !== 'graph') ui.workbench?.openGraph();
    ui.visualizer?.close();
    ui.panels?.showValidation(state.issues);
  } else if (!$('validationPanel').classList.contains('hidden')) {
    ui.panels?.showValidation(state.issues);
  }
  updateStatus();
  return state.issues;
}

// Пересчёт проблем после правок: иначе бейдж в тулбаре, статусбар
// и панель валидации показывают состояние «до правки» вплоть до F5.
function scheduleValidate(delay = 350) {
  clearTimeout(state.validateTimer);
  state.validateTimer = setTimeout(() => {
    state.issues = validateProject(store.project);
    const panelOpen = !$('validationPanel').classList.contains('hidden');
    if (panelOpen) ui.panels?.showValidation(state.issues);
    else ui.panels?.refreshIssues?.();
    updateStatus();
  }, delay);
}

// ------------------------------------------------------------------ автосохранение

function scheduleAutosave() {
  if (!state.settings?.autosave) return;
  clearTimeout(state.autosaveTimer);
  const generation = store.generation;
  state.autosaveTimer = setTimeout(async () => {
    if (generation !== store.generation || !store.dirty) return;
    try {
      const content = JSON.stringify(store.project, null, 2);
      const revision = store.revision;
      const res = await window.sf.autosave.write({content,key:store.documentKey,filePath:store.filePath});
      if (generation !== store.generation || revision !== store.revision) return;
      if (!res?.ok) throw new Error(res?.error || uiText("Запись автосохранения не удалась", "Autosave failed"));
      if (res.ok) {
        const d = new Date();
        state.lastAutosave = d.toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' });
        updateStatus();
      }
    } catch (err) {
      toast(uiText("Не удалось записать автосохранение: ", "Could not write autosave: ") + err.message, 'warn');
    }
  }, 800);
}

// ------------------------------------------------------------------ обновление UI

let refreshPending = null;
let refreshKinds = { graph: false, panels: false, inspector: false, status: false };

function scheduleRefresh(kinds = { graph: true, panels: true, inspector: true, status: true }) {
  // Копим запрошенные части, а не выбрасываем повторный вызов: раньше второй
  // вызов (например, изменение модели сразу после выделения) терял свои kinds.
  refreshKinds = {
    graph: refreshKinds.graph || !!kinds.graph,
    panels: refreshKinds.panels || !!kinds.panels,
    inspector: refreshKinds.inspector || !!kinds.inspector,
    status: refreshKinds.status || !!kinds.status,
  };
  if (refreshPending) return;
  // setTimeout, а не requestAnimationFrame: в скрытом/свёрнутом окне rAF может
  // не вызываться вовсе, и тогда флаг «перерисовка запланирована» залипает
  // навсегда — интерфейс перестаёт обновляться.
  refreshPending = setTimeout(() => {
    refreshPending = null;
    const todo = refreshKinds;
    refreshKinds = { graph: false, panels: false, inspector: false, status: false };
    if (todo.graph) ui.graph?.refresh();
    if (todo.panels) ui.panels?.render();
    if (todo.inspector) ui.inspector?.render();
    if (todo.status) updateStatus();
  }, 16);
}

// ------------------------------------------------------------------ ui-хелперы для модулей

// ---------------------------------------------------------------- изображения узлов

function nodeById(id) {
  return (store.project.nodes || []).find((n) => n.id === id) || null;
}

// Добавляет уже подготовленные картинки в узел: сначала в библиотеку проекта,
// затем в список узла (первая становится превью).
async function applyMediaToNode(nodeId, prepared, { replace = false } = {}) {
  const node = nodeById(nodeId);
  if (!node) return { ok: false, error: uiText("Узел не найден", "Node not found") };
  const good = (prepared || []).filter((item) => item && item.data && !item.error);
  const failed = (prepared || []).filter((item) => item && item.error);
  if (failed.length) {
    toast(`${uiText("Не удалось добавить", "Could not add")}: ${failed.map((f) => f.name || uiText("файл", "file")).join(', ')}`, 'warn', 5000);
  }
  if (!good.length) return { ok: false, error: uiText("Нет изображений", "No images") };

  if (store.beginGroup) store.beginGroup(uiText("Изображения узла", "Node images"));
  try {
    const res = store.apply(good.map((img) => ({ op: 'addMedia', media: { ...img } })), {
      label: good.length > 1 ? `${uiText("Добавлено изображений", "Images added")}: ${good.length}` : uiText("Изображение добавлено", "Image added"),
    });
    if (!res || res.ok === false) {
      toast((res && res.error) || uiText("Не удалось добавить изображение", "Could not add image"), 'bad');
      return res || { ok: false };
    }
    const fresh = nodeById(nodeId);
    const existing = Array.isArray(fresh.media) ? fresh.media : [];
    const next = replace ? res.created.slice() : existing.concat(res.created);
    const previewId = fresh.previewId && next.includes(fresh.previewId) ? fresh.previewId : next[0];
    const link = store.apply([{ op: 'setNodeMedia', id: nodeId, media: next, previewId }], {
      label: uiText("Фото узла", "Node image"),
    });
    if (!link || link.ok === false) {
      toast((link && link.error) || uiText("Не удалось привязать изображение", "Could not attach image"), 'bad');
      return link || { ok: false };
    }
    return { ok: true, ids: res.created };
  } finally {
    if (store.endGroup) store.endGroup();
  }
}

async function attachImagesToNode(nodeId, files) {
  if (!files || !files.length) return;
  const generation = store.generation;
  const prepared = await filesToMedia(files);
  if (generation !== store.generation) return;
  const res = await applyMediaToNode(nodeId, prepared);
  if (res && res.ok) {
    toast(prepared.length > 1 ? `${uiText("Изображений добавлено", "Images added")}: ${prepared.length}` : uiText("Изображение добавлено", "Image added"), 'good');
    scheduleRefresh({ graph: true, inspector: true, panels: true, status: true });
  }
}

async function pickMediaForNode(nodeId) {
  try {
    const generation = store.generation;
    const prepared = await pickImages();
    if (generation !== store.generation || !prepared.length) return;
    const res = await applyMediaToNode(nodeId, prepared);
    if (res && res.ok) {
      toast(prepared.length > 1 ? `${uiText("Изображений добавлено", "Images added")}: ${prepared.length}` : uiText("Изображение добавлено", "Image added"), 'good');
      scheduleRefresh({ graph: true, inspector: true, panels: true, status: true });
    }
  } catch (err) {
    toast(err && err.message ? err.message : uiText("Не удалось выбрать изображение", "Could not choose image"), 'bad');
  }
}

function removeNodeMedia(nodeId, mediaId) {
  const node = nodeById(nodeId);
  if (!node) return;
  const next = (node.media || []).filter((id) => id !== mediaId);
  const previewId = next.includes(node.previewId) ? node.previewId : (next[0] || '');
  const res = store.apply([{ op: 'setNodeMedia', id: nodeId, media: next, previewId }], {
    label: uiText("Изображение убрано", "Image detached"),
  });
  if (!res || res.ok === false) {
    toast((res && res.error) || uiText("Не удалось убрать изображение", "Could not detach image"), 'bad');
    return;
  }
  // Если картинка больше нигде не используется — чистим библиотеку проекта.
  const used = (store.project.nodes || []).some((n) => (n.media || []).includes(mediaId));
  if (!used) store.apply([{ op: 'deleteMedia', id: mediaId }], { label: uiText("Изображение удалено", "Image deleted") });
  scheduleRefresh({ graph: true, inspector: true, panels: true, status: true });
}

function setNodePreview(nodeId, mediaId) {
  const node = nodeById(nodeId);
  if (!node) return;
  if (!(node.media || []).includes(mediaId)) return;
  const res = store.apply([{ op: 'setNodeMedia', id: nodeId, media: node.media, previewId: mediaId }], {
    label: uiText("Превью узла", "Node preview"),
  });
  if (!res || res.ok === false) {
    toast((res && res.error) || uiText("Не удалось сменить превью", "Could not change preview"), 'bad');
    return;
  }
  scheduleRefresh({ graph: true, inspector: true, status: true });
}

const ui = {
  store,
  get settings() {
    return state.settings || {};
  },
  toast,
  modal,
  confirm: confirmDialog,
  escapeHTML,
  el,
  debounce,
  editAfterPause,
  flushEdits,
  highlight,
  plural,
  countWords,
  TYPE_LABELS,

  insertLine(id, edge, type = 'line') { return requestInsertion(store, ui, id, edge, type); },
  playBranch(id) { return showPlayback(store, ui, id); },
  selectNode(id) {
    flushEdits();
    store.setSelection({ kind: 'node', id });
    ui.setRightTab('inspector');
    ui.inspector?.focusNode(id);
    ui.graph?.centerOn(id);
  },
  selectEntity(kind, id) {
    flushEdits();
    store.setSelection({ kind, id });
    ui.setRightTab('inspector');
    ui.inspector?.openEntity(kind, id);
  },
  centerOn(id) {
    ui.graph?.centerOn(id);
  },
  refresh() {
    scheduleRefresh();
  },
  refreshGraph() {
    scheduleRefresh({ graph: true });
  },
  refreshPanels() {
    scheduleRefresh({ panels: true });
  },
  refreshInspector() {
    scheduleRefresh({ inspector: true });
  },
  refreshStatus() {
    updateStatus();
  },
  setLeftTab(name) {
    if ($('leftPanel').classList.contains('collapsed')) togglePanel('left');
    ui.panels?.setTab(name);
  },
  setRightTab(name) {
    if ((name === 'ai' || name === 'voice') && $('rightPanel').classList.contains('collapsed')) togglePanel('right');
    const tabs = $('rightTabs').querySelectorAll('.tab');
    tabs.forEach((t) => {
      const active = t.dataset.tab === name;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
    });
    $('inspectorBody').classList.toggle('hidden', name !== 'inspector');
    $('voiceBody').classList.toggle('hidden', name !== 'voice');
    $('aiBody').classList.toggle('hidden', name !== 'ai');
    if (name === 'ai') ui.ai?.render();
    if (name === 'voice') ui.voice?.render();
  },
  attachImages(nodeId, files) {
    return attachImagesToNode(nodeId, files);
  },
  pickMediaForNode(nodeId) {
    return pickMediaForNode(nodeId);
  },
  removeNodeMedia(nodeId, mediaId) {
    return removeNodeMedia(nodeId, mediaId);
  },
  setNodePreview(nodeId, mediaId) {
    return setNodePreview(nodeId, mediaId);
  },
  formatBytes,
  validate() {
    return runValidation({ show: false });
  },
  chapterOptions() {
    return (store.project.chapters || []).map((c) => ({ id: c.id, name: c.name }));
  },
  saveSettings(patch) {
    state.settings = { ...state.settings, ...patch };
    return window.sf.settings.set(patch);
  },
  saveProject,
  exportFormat,
  openSettings,
  hotkeysHelp,
  graph: null,
  panels: null,
  inspector: null,
  ai: null,
  voice: null,
  studio: null,
  visualizer: null,
  onVisualizerClose: null,
};

// ------------------------------------------------------------------ файлы

function setProject(project, { filePath = null, dirty = false, documentKey } = {}) {
  clearTimeout(state.autosaveTimer);
  clearTimeout(state.validateTimer);
  state.lastAutosave = null;
  $('banner').classList.add('hidden');
  store.setProject(project, { filePath, dirty, documentKey });
  state.issues = validateProject(project);
  scheduleRefresh();
  updateStatus();
  window.sf.app.setDirty(!!dirty);
}

async function openProject() {
  const res = await window.sf.file.openDialog();
  if (!res?.ok) {
    if (res?.error) toast(res.error, 'bad', 6000);
    return;
  }
  await applyLoaded(res);
}

async function applyLoaded(res, documentKey) {
  try {
    const raw = res.project || JSON.parse(res.content);
    const { project, warnings } = migrateProject(raw);
    if (!await canReplaceProject()) return false;
    setProject(project, { filePath: res.path, dirty: false, documentKey });
    if (res.path) await window.sf.file.recentAdd(res.path);
    if (warnings?.length) toast(`${uiText("Проект загружен с замечаниями", "Project loaded with warnings")}: ${warnings[0]}`, 'warn', 5000);
    else if (state.booted) toast(uiText("Проект открыт", "Project opened"), 'good');
    ui.graph?.showStart();
    return true;
  } catch (err) {
    toast(`${uiText("Не удалось открыть проект", "Could not open project")}: ${err.message}`, 'bad', 6000);
  }
}

let saving = Promise.resolve();
function saveProject(saveAs = false) {
  flushEdits();
  const generation = store.generation;
  const run = saving.then(() => generation === store.generation && writeCurrentProject(saveAs));
  saving = run.catch(() => false);
  return run;
}
async function writeCurrentProject(saveAs) {
  flushEdits();
  const generation = store.generation;
  const revision = store.revision;
  const recoveryKey = store.documentKey;
  const content = JSON.stringify(store.project, null, 2);
  let res;
  if (saveAs || !store.filePath) {
    const suggested = `${(store.project.meta?.title || 'project').replace(/[\\/:*?"<>|]/g, '-')}.sfproj`;
    res = await window.sf.file.saveAs(suggested, content);
  } else {
    res = await window.sf.file.save(store.filePath, content);
  }
  if (!res?.ok) {
    if (res?.error) toast(res.error, 'bad', 6000);
    return false;
  }
  flushEdits();
  if (generation !== store.generation) return false;
  store.markSaved(res.path, revision);
  store.documentKey = res.path;
  if (recoveryKey !== res.path) ui.workbench?.persist();
  window.sf.app.setDirty(store.dirty);
  if (store.dirty) {
    scheduleAutosave();
    toast(uiText("Файл записан. Есть более свежие правки.", "File saved. Newer edits are pending."), 'info');
    return false;
  }
  clearTimeout(state.autosaveTimer);
  await window.sf.autosave.clear(recoveryKey);
  if (recoveryKey !== res.path) await window.sf.autosave.clear(res.path);
  updateStatus();
  flushEdits();
  if (generation !== store.generation || revision !== store.revision) return false;
  toast(uiText("Сохранено", "Saved"), 'good');
  return true;
}

let askingToReplace = false;
async function canReplaceProject() {
  flushEdits();
  if (!store.dirty) return true;
  const generation = store.generation, revision = store.revision;
  if (askingToReplace) return false;
  askingToReplace = true;
  let response;
  try {
    response = await new Promise(resolve => {
      const finish = value => dialog => { resolve(value); dialog.close(); };
      const dialog = modal({
        title:uiText("Смена проекта", "Switch project"), body:uiText("<p>Сохранить изменения перед сменой проекта?</p>", "<p>Save changes before switching projects?</p>"),
        buttons:[
          {label:uiText("Отмена", "Cancel"), onClick:finish(2)},
          {label:uiText("Продолжить без сохранения", "Continue without saving"), onClick:finish(1)},
          {label:uiText("Сохранить", "Save"), kind:'primary', onClick:finish(0)}
        ], onClose:()=>resolve(2)
      });
      dialog.body.closest('.modal-card').querySelector('.btn-primary').focus();
    });
  } finally { askingToReplace = false; }
  flushEdits();
  if (generation !== store.generation || revision !== store.revision) return false;
  if (response === 0) return saveProject();
  if (response !== 1) return false;
  clearTimeout(state.autosaveTimer);
  await window.sf.autosave.clear(store.documentKey);
  flushEdits();
  return generation === store.generation && revision === store.revision;
}
async function newProject() {
  if (!await canReplaceProject()) return;
  setProject(createEmptyProject(), { filePath: null, dirty: false });
  ui.graph?.showStart();
  toast(uiText("Создан новый проект", "New project created"), 'good');
}

// ------------------------------------------------------------------ экспорт

async function exportFormat(format) {
  flushEdits();
  runValidation();
  let built;
  try {
    built = buildExport(store.project, format);
  } catch (err) {
    toast(`${uiText("Ошибка экспорта", "Export error")}: ${err.message}`, 'bad', 6000);
    return;
  }
  if (!built || !built.files?.length) {
    toast(uiText("Экспорт не дал файлов", "Export produced no files"), 'bad');
    return;
  }

  if (format === 'clipboard') {
    await window.sf.clipboard.write(built.files[0].content);
    toast(uiText("Сценарий скопирован в буфер обмена", "Story copied to clipboard"), 'good');
    return;
  }

  const errors = state.issues.filter((i) => i.severity === 'error').length;
  if (errors) {
    const ok = await confirmDialog(`${uiText("Валидатор нашёл", "Validation found")} ${errors} ${plural(errors, [uiText("ошибку", "error"), uiText("ошибки", "errors"), uiText("ошибок", "errors")])}. ${uiText("Экспортировать всё равно", "Export anyway")}?`, {
      detail: uiText("Битые ссылки будут помечены в файлах экспорта.", "Broken links will be marked in exported files."),
      okLabel: uiText("Экспортировать", "Export"),
      danger: true,
    });
    if (!ok) return;
  }

  let dir = null;
  if (store.filePath) {
    const base = store.filePath.replace(/[\\/][^\\/]+$/, '');
    dir = `${base}\\exports`;
  }
  const picked = await window.sf.exportFiles.chooseDir(dir || '');
  if (!picked?.ok) return;
  const res = await window.sf.exportFiles.write(picked.dir, built.files);
  if (!res?.ok) {
    toast(res?.error || uiText("Не удалось записать файлы", "Could not write files"), 'bad', 6000);
    return;
  }
  const names = built.files.map((f) => f.name).join(', ');
  toast(`${uiText("Экспортировано", "Exported")}: ${names}`, 'good', 5000);
  if (built.warnings?.length) toast(built.warnings[0], 'warn', 5000);
}

// ------------------------------------------------------------------ настройки

let paintShellLanguage;
function changeInterfaceLanguage(language) {
  flushEdits();
  setLanguage(language);
  paintShellLanguage();
  state.issues = validateProject(store.project);
  ui.workbench?.refreshLanguage();
  ui.graph?.refresh(true);
  ui.panels?.render();
  ui.inspector?.render();
  ui.voice?.render();
  ui.ai?.render();
  ui.studio?.render();
  ui.visualizer?.render();
  ui.updateShellLanguage?.();
  updateStatus();
  renderRecent();
}

function openSettings(initialSection = 'appearance') {
  const s = state.settings;
  const sections = [
    ['appearance', uiText("Оформление", "Appearance"), 'layout'],
    ['save', uiText("Сохранение", "Saving"), 'folder'],
    ['ai', uiText("AI-ассистент", "AI assistant"), 'spark'],
    ['keys', uiText("Горячие клавиши", "Keyboard shortcuts"), 'type'],
  ];
  const body = el(`
    <div class="sf-preferences">
      <nav class="sf-preferences-nav" aria-label="${uiText("Разделы настроек", "Settings sections")}">
        ${sections.map(([id, title, glyph]) => `<button type="button" data-pref="${id}" aria-controls="pref-${id}">${icon(glyph, 15)}${title}</button>`).join('')}
      </nav>
      <div class="sf-preferences-main">
      <div class="modal-section" id="pref-appearance">
        <h4>${uiText("Оформление", "Appearance")}</h4>
        <label class="field">
          <span class="field-label">${uiText('Язык интерфейса', 'Interface language')}</span>
          <select class="select" id="setLanguage">
            <option value="ru" lang="ru">Русский</option>
            <option value="en" lang="en">English</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">${uiText("Тема", "Theme")}</span>
          <select class="select" id="setTheme">
            <option value="dark">${uiText("Тёмная", "Dark")}</option>
            <option value="light">${uiText("Светлая", "Light")}</option>
          </select>
        </label>
      </div>
      <div class="modal-section" id="pref-save">
        <h4>${uiText("Сохранение", "Saving")}</h4>
        <label class="checkbox"><input type="checkbox" id="setAutosave" /> ${uiText("Автосохранение каждые 800 мс после правки", "Autosave 800 ms after each edit")}</label>
        <p class="hint-text">${uiText("Копия хранится в служебной папке приложения и предлагается к восстановлению при запуске", "A recovery copy is stored in the app’s data folder and offered when you start the app")}.</p>
      </div>
      <div class="modal-section" id="pref-ai">
        <h4>${uiText("AI-ассистент", "AI assistant")}</h4>
        <p class="hint-text">${uiText("Провайдер, ключ и модель настраиваются отдельно", "Configure your provider, key and model separately")}.</p>
        <button class="btn btn-sm" type="button" id="setAiBtn">${uiText("Настроить", "Configure")} AI…</button>
      </div>
      <div class="modal-section" id="pref-keys">
        <h4>${uiText("Горячие клавиши", "Keyboard shortcuts")}</h4>
        <div class="kbd-list">
          <span>${uiText("Сохранить / Сохранить как", "Save / Save as")}</span><span><kbd>Ctrl</kbd>+<kbd>S</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd></span>
          <span>${uiText("Открыть / Новый", "Open / New")}</span><span><kbd>Ctrl</kbd>+<kbd>O</kbd> / <kbd>Ctrl</kbd>+<kbd>N</kbd></span>
          <span>${uiText("Отменить / Повторить", "Undo / Redo")}</span><span><kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd></span>
          <span>${uiText("Поиск", "Search")}</span><span><kbd>Ctrl</kbd>+<kbd>F</kbd></span>
          <span>${uiText("Дублировать / Удалить узел", "Duplicate / Delete node")}</span><span><kbd>Ctrl</kbd>+<kbd>D</kbd> / <kbd>Delete</kbd></span>
          <span>${uiText("Автораскладка", "Auto layout")}</span><span><kbd>Ctrl</kbd>+<kbd>G</kbd></span>
          <span>${uiText("Проверка проекта", "Validate project")}</span><span><kbd>F5</kbd></span>
          <span>${uiText("Новая реплика после выбранной", "Add a line after the selected node")}</span><span><kbd>Ctrl</kbd>+<kbd>Enter</kbd></span>
          <span>${uiText("Быстрый переход к узлу", "Quick switcher")}</span><span><kbd>Ctrl</kbd>+<kbd>K</kbd></span>
          <span>${uiText("Вкладки левой панели", "Left sidebar tabs")}</span><span><kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>5</kbd></span>
          <span>${uiText("Фокус в AI-чат", "Focus AI chat")}</span><span><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd></span>
          <span>${uiText("Озвучка реплик", "Voice acting")}</span><span><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd></span>
        </div>
      </div>
      </div>
    </div>
  `);
  function showSection(id) {
    for (const [key] of sections) {
      body.querySelector('#pref-' + key).hidden = key !== id;
      body.querySelector('[data-pref="' + key + '"]').setAttribute('aria-current', String(key === id));
    }
  }
  const nav = body.querySelector('.sf-preferences-nav');
  nav.addEventListener('click', event => {
    const button = event.target.closest('[data-pref]');
    if (button) showSection(button.dataset.pref);
  });
  showSection(sections.some(([id]) => id === initialSection) ? initialSection : 'appearance');
  const languageInput = body.querySelector('#setLanguage');
  languageInput.value = getLanguage();
  languageInput.addEventListener('change', () => {
    const previous = getLanguage();
    const next = languageInput.value;
    if (next === previous) return;
    dialog.close();
    changeInterfaceLanguage(next);
    const saved = ui.saveSettings({ language: next });
    openSettings('appearance');
    document.getElementById('setLanguage')?.focus();
    saved.catch(() => toast(uiText('Не удалось сохранить язык интерфейса', 'Could not save language preference'), 'warn'));
  });
  body.querySelector('#setTheme').value = s.theme || 'dark';
  body.querySelector('#setAutosave').checked = !!s.autosave;
  body.querySelector('#setTheme').addEventListener('change', (e) => {
    applyTheme(e.target.value);
    ui.saveSettings({ theme: e.target.value });
  });
  body.querySelector('#setAutosave').addEventListener('change', (e) => {
    ui.saveSettings({ autosave: !!e.target.checked });
  });
  body.querySelector('#setAiBtn').addEventListener('click', () => {
    dialog.close();
    ui.ai?.openSettings();
  });

  const dialog = modal({
    title: uiText("Настройки", "Settings"),
    body,
    buttons: [{ label: uiText("Готово", "Done"), kind: 'primary' }],
    wide: true,
  });
}

function hotkeysHelp() {
  openSettings('keys');
}

// ------------------------------------------------------------------ тема

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

// ------------------------------------------------------------------ меню файла

function toggleDropdown(id) {
  const target = $(id);
  const isHidden = target.classList.contains('hidden');
  document.querySelectorAll('.dropdown').forEach((d) => d.classList.add('hidden'));
  if (isHidden) target.classList.remove('hidden');
}

async function renderRecent() {
  const list = await window.sf.file.recent();
  const host = $('recentList');
  host.innerHTML = '';
  if (!list.length) {
    host.innerHTML = uiText("<div class=\"dd-empty\">Пока пусто</div>", "<div class=\"dd-empty\">Nothing here yet</div>");
    return;
  }
  for (const p of list) {
    const item = el(`<button class="dd-item" type="button" title="${escapeHTML(p)}">${escapeHTML(p.split(/[\\/]/).pop())}</button>`);
    item.addEventListener('click', async () => {
      const res = await window.sf.file.openPath(p);
      if (res?.ok) await applyLoaded(res);
      else toast(res?.error || uiText("Не удалось открыть файл", "Could not open file"), 'bad', 6000);
      $('menuFile').classList.add('hidden');
    });
    host.appendChild(item);
  }
}

let closeRequested = false;
async function requestWindowClose() {
  if (closeRequested) return;
  closeRequested = true;
  try {
    await saving;
    flushEdits();
    if (store.dirty) {
      const generation = store.generation, revision = store.revision;
      const choice = await askBeforeClosing(store.project.meta?.title);
      flushEdits();
      if (generation !== store.generation || revision !== store.revision || choice === 'cancel') return;
      if (choice === 'save') {
        if (!await saveProject(false)) return;
      } else {
        clearTimeout(state.autosaveTimer);
        await window.sf.autosave.clear(store.documentKey);
      }
      flushEdits();
      if (generation !== store.generation || revision !== store.revision) return;
    }
    await window.sf.app.quit();
  } catch (error) {
    toast(String(error.message || error), 'bad', 6000);
  } finally {
    closeRequested = false;
  }
}

async function handleAction(action) {
  if (action === 'file:requestClose') return requestWindowClose();
  if (closeRequested) return;
  flushEdits();
  switch (action) {
    case 'file:new':
      await newProject();
      break;
    case 'file:open':
      await openProject();
      break;
    case 'file:save':
      await saveProject(false);
      break;
    case 'file:saveAs':
      await saveProject(true);
      break;
    case 'export:godot':
    case 'export:renpy':
    case 'export:markdown':
    case 'export:json':
    case 'export:clipboard':
      await exportFormat(action.split(':')[1]);
      break;
    case 'edit:undo':
      store.undo();
      break;
    case 'edit:redo':
      store.redo();
      break;
    case 'edit:duplicate':
      duplicateSelected();
      break;
    case 'edit:delete':
      deleteSelected();
      break;
    case 'edit:newLine':
      createAfterSelected('line');
      break;
    case 'view:search':
      ui.setLeftTab('search');
      ui.panels?.focusSearch('');
      break;
    case 'view:validate':
      runValidation({ show: true });
      break;
    case 'view:layout':
      ui.graph?.autoLayout();
      break;
    case 'view:fit':
      ui.graph?.fit();
      break;
    case 'view:toggleLeft':
      togglePanel('left');
      break;
    case 'view:toggleRight':
      togglePanel('right');
      break;
    case 'view:theme':
      applyTheme(state.settings.theme === 'light' ? 'dark' : 'light');
      ui.saveSettings({ theme: document.documentElement.dataset.theme });
      break;
    case 'voice:studio':
      openStudio();
      break;
    case 'view:visualizer':
      ui.workbench?.openOverview();
      break;
    case 'help:hotkeys':
      hotkeysHelp();
      break;
    case 'help:about': {
      const info = await window.sf.app.info();
      modal({
        title: uiText("О программе", "About"),
        body: `<div class="about-brand">
                 <img src="./assets/storyforge-mark.png" alt="" width="60" height="60" draggable="false" />
                 <div><strong>StoryForge</strong><p>${uiText("Редактор сценария для игр", "Story editor for games")}.</p></div>
               </div>
               <p class="hint-text">${uiText("Версия", "Version")} ${escapeHTML(info.version)}, Electron ${escapeHTML(info.electron)}, Node ${escapeHTML(info.node)}.</p>
               <p class="hint-text">${uiText("Работает офлайн. AI-запросы уходят только на выбранный вами", "Works offline. AI requests go only to your chosen")} Base URL.</p>`,
      });
      break;
    }
    case 'app:ready':
      devLog(uiText("main сообщил о готовности", "main reported ready"));
      break;
    default:
      devLog(uiText("неизвестное действие меню", "unknown menu action"), action);
  }
}

// ------------------------------------------------------------------ действия над узлами

function selectedNode() {
  const sel = store.selection;
  if (sel?.kind !== 'node' || !sel.id) return null;
  return store.project.nodes.find((n) => n.id === sel.id) || null;
}

function createAfterSelected(type = 'line') {
  if (ui.workbench?.acceptJump?.(true)) return;
  return ui.insertLine(selectedNode()?.id, undefined, type);
}

async function duplicateSelected() {
  const cur = selectedNode();
  if (!cur) return toast(uiText("Узел не выбран", "No node selected"), 'warn');
  const res = store.apply([{ op: 'createNode', node: { ...structuredClone(cur), id: undefined } }], { label: uiText("Дублировать узел", "Duplicate node") });
  if (res?.ok) {
    const id = res.created?.[0];
    if (id) ui.selectNode(id);
    toast(uiText("Узел продублирован", "Node duplicated"), 'good');
  }
}

async function openStudio(explicitTarget) {
  if (!ui.studio) {
    toast(uiText("Студия голоса не инициализирована", "Voice Studio is not ready"), 'bad');
    return;
  }
  let target = explicitTarget;
  if (target === undefined) {
    const sel = store.selection;
    if (sel && sel.kind === 'character') target = sel.id;
  }
  ui.studio.open(target);
}

async function deleteSelected() {
  const sel = store.selection;
  if (sel?.kind !== 'node' || !sel.id) return;
  const node = selectedNode();
  if (!node) return;
  const ok = await confirmDialog(uiText("Удалить выбранный узел?", "Delete the selected node?"), {
    detail: uiText("Входящие связи будут перенаправлены на следующий узел, если он есть.", "Incoming links will point to the next node, if there is one."),
    danger: true,
  });
  if (!ok) return;
  const res = store.apply([{ op: 'deleteNode', id: node.id }], { label: uiText("Удалить узел", "Delete node") });
  if (res?.ok) {
    store.setSelection({ kind: null, id: null });
    ui.refresh();
    toast(uiText("Узел удалён", "Node deleted"), 'good');
  } else {
    toast(res?.error || uiText("Не удалось удалить", "Could not delete"), 'bad');
  }
}

// ------------------------------------------------------------------ панели и ресайз

function togglePanel(side) {
  const panel = $(side === 'left' ? 'leftPanel' : 'rightPanel');
  const visible = panel.classList.toggle('collapsed') === false;
  ui.saveSettings({ [side === 'left' ? 'leftVisible' : 'rightVisible']: visible });
}

function initSplitters() {
  const setup = (splitterId, panelId, side) => {
    const splitter = $(splitterId);
    const panel = $(panelId);
    let startX = 0;
    let startW = 0;
    let dragging = false;

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const w = side === 'left' ? startW + dx : startW - dx;
      const clamped = Math.max(220, Math.min(560, w));
      panel.style.width = `${clamped}px`;
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      splitter.classList.remove('dragging');
      document.body.style.cursor = '';
      const w = parseInt(panel.style.width, 10) || (side === 'left' ? 280 : 360);
      ui.saveSettings({ [side === 'left' ? 'leftWidth' : 'rightWidth']: w });
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    splitter.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startW = panel.getBoundingClientRect().width;
      splitter.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  };
  setup('splitterLeft', 'leftPanel', 'left');
  setup('splitterRight', 'rightPanel', 'right');
}

// ------------------------------------------------------------------ быстрый переход Ctrl+K

function quickJump() {
  ui.workbench?.quickJump();
}

function initHotkeys() {
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;

    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveProject(e.shiftKey);
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      ui.workbench?.toggleOverview();
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      openStudio();
      return;
    }
    if (mod && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      openProject();
      return;
    }
    if (mod && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      newProject();
      return;
    }
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      flushEdits();
      if (e.shiftKey) store.redo();
      else store.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      flushEdits();
      store.redo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      ui.setLeftTab('search');
      ui.panels?.focusSearch('');
      return;
    }
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      quickJump();
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      ui.setRightTab('ai');
      ui.ai?.focusInput();
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      ui.setRightTab('voice');
      return;
    }
    if (mod && e.key >= '1' && e.key <= '5') {
      e.preventDefault();
      const tabs = ['script', 'characters', 'locations', 'variables', 'search'];
      ui.setLeftTab(tabs[Number(e.key) - 1]);
      return;
    }
    if (e.key === 'F5') {
      e.preventDefault();
      runValidation({ show: true });
      return;
    }
    if (e.key === 'Escape' && ui.visualizer && ui.visualizer.isOpen()) {
      ui.visualizer.close();
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      if (ui.studio && ui.studio.isOpen()) {
        ui.studio.close();
        return;
      }
      if (modalStack.length) {
        modalStack[modalStack.length - 1].close();
        return;
      }
      $('contextMenu').classList.add('hidden');
      $('menuFile').classList.add('hidden');
      $('menuExport').classList.add('hidden');
      store.setSelection({ kind: null, id: null });
      return;
    }
    if (inField) return;

    if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      duplicateSelected();
      return;
    }
    if (mod && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      ui.graph?.autoLayout();
      return;
    }
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      createAfterSelected('line');
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (store.selection?.kind === 'node') {
        e.preventDefault();
        deleteSelected();
      }
    }
  });

  // Вставка картинки из буфера обмена (Ctrl+V) — в выбранный узел.
  document.addEventListener('paste', (e) => {
    if (e.target.closest?.('#screenplayText')) return;
    const files = clipboardImages(e);
    if (!files.length) return;
    const node = selectedNode();
    if (!node) {
      toast(uiText("Сначала выберите узел, затем вставьте изображение", "Select a node before pasting an image"), 'warn');
      return;
    }
    e.preventDefault();
    attachImagesToNode(node.id, files);
  });
}

// ------------------------------------------------------------------ старт

async function boot() {
  paintShellLanguage = bindShellLanguage(document.body);
  state.settings = await window.sf.settings.get();
  setLanguage(state.settings.language);
  paintShellLanguage();
  applyTheme(state.settings.theme || 'dark');
  window.__SF_DEV__ = !!state.settings.dev;

  $('leftPanel').style.width = `${state.settings.leftWidth || 280}px`;
  $('rightPanel').style.width = `${state.settings.rightWidth || 360}px`;
  if (state.settings.leftVisible === false) $('leftPanel').classList.add('collapsed');
  if (state.settings.rightVisible === false) $('rightPanel').classList.add('collapsed');

  const info = await window.sf.app.info();
  $('stVersion').textContent = `v${info.version}`;

  // модули
  try {
    ui.graph = createGraph({ host: $('graphHost'), svg: $('graph'), store, ui });
  } catch (err) {
    console.error('graph init failed', err);
    toast(`${uiText("Граф не инициализирован", "Graph is not ready")}: ${err.message}`, 'bad', 8000);
  }
  try {
    ui.panels = createPanels({ root: $('leftBody'), store, ui });
  } catch (err) {
    console.error('panels init failed', err);
    toast(`${uiText("Левая панель не инициализирована", "Left sidebar is not ready")}: ${err.message}`, 'bad', 8000);
  }
  try {
    ui.inspector = createInspector({ root: $('inspectorBody'), store, ui });
  } catch (err) {
    console.error('inspector init failed', err);
    toast(`${uiText("Инспектор не инициализирован", "Inspector is not ready")}: ${err.message}`, 'bad', 8000);
  }
  try {
    ui.ai = createAI({ root: $('aiBody'), store, ui });
  } catch (err) {
    console.error('ai init failed', err);
    toast(`AI-${uiText("ассистент не инициализирован", "assistant is not ready")}: ${err.message}`, 'bad', 8000);
  }
  try {
    ui.voice = createVoice({ root: $('voiceBody'), store, ui });
  } catch (err) {
    console.error('voice init failed', err);
    toast(`${uiText("Озвучка не инициализирована", "Voice engine is not ready")}: ${err.message}`, 'bad', 8000);
  }
  try {
    ui.studio = createVoiceStudio({ root: $('studioRoot'), store, ui });
  } catch (err) {
    toast(uiText("Студия голоса: ", "Voice Studio: ") + err.message, 'bad');
  }
  try {
    ui.visualizer = createVisualizer({ root: $('vizRoot'), store, ui });
  } catch (err) {
    console.error('visualizer init failed', err);
    toast(`${uiText("Обзор сюжета не инициализирован", "Story overview is not ready")}: ${err.message}`, 'bad', 8000);
  }


  ui.setRightTab('inspector');

  ui.workbench = createWorkbench(store, ui);
  ui.updateShellLanguage = initWorkspaceShell(store, ui);

  // подписка на изменения модели
  store.subscribe((evt) => {
    if (evt.type === 'selection') {
      scheduleRefresh({ inspector: true, graph: true });
    } else if (evt.type === 'project') {
      if (store.dirty) scheduleAutosave();
      state.issues = validateProject(store.project);
      scheduleRefresh();
      window.sf.app.setDirty(store.dirty);
    } else if (evt.scope === 'screenplay') {
      window.sf.app.setDirty(store.dirty);
      scheduleRefresh({ status: true });
      scheduleAutosave();
    } else {
      // инспектор перерисовываем всегда, КРОМЕ случая, когда пользователь печатает
      // в текстовом поле инспектора — иначе теряется каретка. Клик по кнопке
      // (удалить/добавить/переместить) не должен блокировать перерисовку, иначе
      // панель показывает устаревшие данные и следующие клики бьют по старому списку.
      const ae = document.activeElement;
      const typingInInspector =
        !!ae &&
        (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') &&
        $('inspectorBody').contains(ae);
      scheduleRefresh({ graph: true, panels: true, status: true, inspector: !typingInInspector });
      window.sf.app.setDirty(store.dirty);
      scheduleValidate();
      scheduleAutosave();
    }
  });

  // тулбар
  $('btnFile').addEventListener('click', (e) => {
    e.stopPropagation();
    renderRecent();
    toggleDropdown('menuFile');
  });
  $('btnExport').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDropdown('menuExport');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu-wrap')) {
      document.querySelectorAll('.dropdown').forEach((d) => d.classList.add('hidden'));
    }
    if (!e.target.closest('#contextMenu')) $('contextMenu').classList.add('hidden');
  });
  document.querySelectorAll('#menuFile .dd-item, #menuExport .dd-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      document.querySelectorAll('.dropdown').forEach((d) => d.classList.add('hidden'));
      handleAction(action);
    });
  });

  $('btnUndo').addEventListener('click', () => store.undo());
  $('btnRedo').addEventListener('click', () => store.redo());
  $('btnTheme').addEventListener('click', () => handleAction('view:theme'));
  $('btnValidate').addEventListener('click', () => runValidation({ show: true }));
  $('stIssues').addEventListener('click', () => runValidation({ show: true }));
  $('btnToggleLeft').addEventListener('click', () => togglePanel('left'));
  $('btnToggleRight').addEventListener('click', () => togglePanel('right'));
  $('btnSettings').addEventListener('click', openSettings);
  $('btnSearch').addEventListener('click', () => handleAction('view:search'));
  $('btnLayout').addEventListener('click', () => ui.graph?.autoLayout());
  $('btnFit').addEventListener('click', () => ui.graph?.fit());
  $('btnViz').addEventListener('click', () => ui.workbench?.openOverview());
  $('btnAddNode').addEventListener('click', () => createAfterSelected('line'));
  $('btnCreateFirst').addEventListener('click', () => createAfterSelected('line'));
  $('btnRestore').addEventListener('click', restoreAutosave);
  $('btnDismissBanner').addEventListener('click', () => $('banner').classList.add('hidden'));

  // заголовок проекта: живое обновление meta.title (с дебаунсом) + фиксация по Enter/уходу
  const applyTitle = (raw) => {
    const title = String(raw || '').trim() || uiText("Новый проект", "New project");
    if ((store.project.meta?.title || '') === title) return;
    store.apply([{ op: 'setMeta', patch: { title } }], { label: uiText("Название проекта", "Project title") });
  };
  // значение берём в момент ввода: к моменту срабатывания дебаунса поле могло
  // уже перерисоваться из модели и вернуть старое название
  const applyTitleDebounced = ui.editAfterPause((value) => applyTitle(value), 400);
  $('projectTitle').addEventListener('input', (e) => applyTitleDebounced(e.target.value));
  $('projectTitle').addEventListener('change', (e) => applyTitle(e.target.value));
  $('projectTitle').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      applyTitle(e.target.value);
      e.target.blur();
    }
  });

  // ушли из текстового поля инспектора — догоняем перерисовку, которую придержали
  $('inspectorBody').addEventListener('focusout', (e) => {
    const to = e.relatedTarget;
    if (to && $('inspectorBody').contains(to)) return;
    scheduleRefresh({ inspector: true, status: true });
  });

  // правая панель — вкладки
  $('rightTabs').querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => ui.setRightTab(tab.dataset.tab));
  });

  initSplitters();
  initHotkeys();
  document.addEventListener('focusout', flushEdits, true);
  window.sf.onMenu(({ action }) => handleAction(action));

  await loadInitialProject();
  selectStartNode();
  state.booted = true;
  window.sf.app.closeReady();
  updateStatus();

  // Отладочный доступ для авто-приёмки (tools/selftest-renderer.js): только при ?selftest=1.
  if (new URLSearchParams(location.search).has('selftest')) {
    window.__sfTest = {
      store,
      ui,
      project: () => store.project,
      validateProject,
      countWords,
      action: (name) => handleAction(name),
      newProject,
      deleteSelected,
      duplicateSelected,
      exportFormat,
    };
  }
}

// При открытии проекта сразу показываем в инспекторе стартовый узел:
// иначе правая панель выглядит пустой и не видно ни одного поля.
function selectStartNode() {
  const p = store.project;
  const id = p?.startNodeId;
  if (!id) return;
  if (!(p.nodes || []).some((n) => n.id === id)) return;
  store.setSelection({ kind: 'node', id });
  ui.inspector?.focusNode(id);
}

let offeredRecovery;
async function restoreAutosave() {
  const res = offeredRecovery || await window.sf.autosave.read(store.documentKey);
  if (!res?.ok) return toast(uiText("Автосохранение не найдено", "No autosave found"), 'warn');
  try {
    const {project} = migrateProject(JSON.parse(res.content));
    if (!await canReplaceProject()) return;
    setProject(project, {filePath:res.filePath,documentKey:res.key,dirty:true});
    offeredRecovery = null;
    if (!res.key) await window.sf.autosave.clear(null);
    ui.graph?.showStart();
    toast(uiText("Несохранённые изменения восстановлены", "Unsaved changes restored"), 'good');
  } catch (err) { toast(uiText("Не удалось восстановить: ", "Could not restore: ") + err.message, 'bad'); }
}
async function loadInitialProject() {
  const auto = await window.sf.autosave.read();
  const recent = await window.sf.file.recent();
  const candidates = new Set([state.settings.lastPath, ...recent].filter(Boolean));
  let loaded = false;
  for (const filePath of candidates) {
    const res = await window.sf.file.openPath(filePath);
    if (res?.ok && await applyLoaded(res)) {
      loaded = true;
      break;
    }
  }
  if (!loaded) setProject(createEmptyProject());
  if (auto?.ok) {
    offeredRecovery = auto;
    const owner = auto.filePath || uiText("проект без сохранённого пути", "project without a saved path");
    $('bannerText').textContent = uiText("Восстановить изменения от ", "Restore changes from ") + new Date(auto.mtime).toLocaleString(getLanguage()) + ' — ' + owner + '?';
    $('banner').classList.remove('hidden');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  boot().catch((err) => {
    console.error('boot failed', err);
    document.body.innerHTML = `<div style="padding:40px;font-family:system-ui;color:#e6ebf2;background:#0e1116;height:100vh">
      <h2>StoryForge ${uiText("не запустился", "could not start")}</h2><pre style="white-space:pre-wrap">${String(err?.stack || err)}</pre></div>`;
  });
});
