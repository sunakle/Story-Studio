'use strict';
// StoryForge — main-процесс Electron.
// Вся работа с файлами, настройками, сетью и диалогами живёт здесь.
// Рендерер общается только через preload.js -> window.sf.

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard, net, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { createHash } = require('node:crypto');

const DEV = process.argv.includes('--dev');
const ROOT = __dirname;
const packagedProfile = app.isPackaged && path.join(
  process.platform === 'win32' && process.env.LOCALAPPDATA || app.getPath('appData'),
  'StoryForge', 'User Data'
);
if (process.platform === 'win32') app.setAppUserModelId('sunakle.StoryForge');
const {atomicWrite, scopedFile, recoveryFiles} = require('./project-files.cjs');
const { createVoiceLibrary } = require('./src/native/voice-library.cjs');

// ---------------------------------------------------------------- журнал
// Electron — GUI-процесс: без консоли его сообщения теряются, поэтому пишем
// При разработке журнал лежит в .logs, в установленной версии — в профиле пользователя.
const LOG_DIR = process.argv.includes('--selftest') && process.env.SF_TEST_OUTPUT
  ? path.resolve(process.env.SF_TEST_OUTPUT)
  : packagedProfile ? path.join(process.env.SF_USERDATA || packagedProfile, 'logs') : path.join(ROOT, '.logs');
const LOG_FILE = path.join(LOG_DIR, 'main.log');

function logLine(...parts) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const text = parts
      .map((p) => (typeof p === 'string' ? p : (() => {
        try {
          return JSON.stringify(p);
        } catch {
          return String(p);
        }
      })()))
      .join(' ');
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${text}\n`, 'utf8');
  } catch {
    /* журнал недоступен — не мешаем работе */
  }
}

process.on('uncaughtException', (e) => logLine('uncaughtException', (e && e.stack) || String(e)));
process.on('unhandledRejection', (e) => logLine('unhandledRejection', String((e && e.stack) || e)));
logLine('--- start', `electron=${process.versions.electron}`, `node=${process.versions.node}`, `argv=${process.argv.slice(1).join(' ')}`);

// ---------------------------------------------------------------- каталог данных
// Chromium пишет профиль и крэш-дампы в userData ещё до app.whenReady(), и если
// путь недоступен (чужой профиль, ограниченные права, песочница) — процесс падает
// на старте без сообщений. Поэтому каталог выбираем заранее и с проверкой записи.
function resolveUserData() {
  const candidates = [];
  // Порядок важен: сначала явные/локальные каталоги. Системный профиль
  // (%APPDATA%\StoryForge) на некоторых сборках Windows валит Chromium при старте,
  // поэтому он идёт последним — только если локальный каталог недоступен.
  if (process.env.SF_USERDATA) candidates.push(process.env.SF_USERDATA);
  // Явный ключ --user-data-dir=... уважаем: он же задаёт каталог блокировки
  // единственного экземпляра, поэтому тестовый профиль не конфликтует с рабочим окном.
  const argvDir = process.argv.map((a) => /^--user-data-dir=(.+)$/.exec(a)).find(Boolean);
  if (argvDir) candidates.push(path.resolve(ROOT, argvDir[1]));
  candidates.push(packagedProfile || path.join(ROOT, '.userdata'));
  try {
    candidates.push(app.getPath('userData'));
  } catch {
    /* путь недоступен — идём дальше */
  }
  try {
    candidates.push(path.join(app.getPath('temp'), 'StoryForge'));
  } catch {
    /* нет временного каталога */
  }

  for (const dir of candidates) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.write-test');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return dir;
    } catch {
      /* пробуем следующий */
    }
  }
  return null;
}

const userDataDir = resolveUserData();
if (userDataDir) {
  app.setPath('userData', userDataDir);
  logLine('userData:', userDataDir);
  if (DEV) console.log('[storyforge] userData:', userDataDir);
}

let win = null;
let dirty = false;
let allowClose = false;
let closeUIReady = false;
const aborters = new Map();

// ---------------------------------------------------------------- настройки

const userDir = () => app.getPath('userData');
const settingsPath = () => path.join(userDir(), 'settings.json');

const historyPath = key => key ? scopedFile(userDir(), 'history', key) : path.join(userDir(), 'ai-history.json');

const DEFAULT_SETTINGS = {
  theme: 'dark',
  language: 'ru',
  leftWidth: 280,
  rightWidth: 360,
  leftVisible: true,
  rightVisible: true,
  autosave: true,
  recent: [],
  lastPath: null,
  voiceDir: null,
  ai: {
    preset: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.4,
    maxTokens: 4096,
    extraHeaders: '',
    allowDelete: false,
    showTools: true,
  },
};

function readJsonSync(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!patch || typeof patch !== 'object') return out;
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Old releases added their bundled examples to recent files. Fingerprint only
// the original files in an application tree so a user's edits are retained.
const retiredSamples = {
  'demo-project.json': 'f22ff9bf9c922c78e8899299e747503c721fb56ce5468d1b8cb2e7fb367d4586',
  'stress-overview.sfproj': '9aa17c50ecaef5083f26052e3cca36e28f988ad3e9762ba5ee4e49e499f47d94',
};
function sampleHashForPath(file) {
  if (typeof file !== 'string' || !file) return false;
  const name = path.basename(file);
  const hash = Object.hasOwn(retiredSamples, name) && retiredSamples[name];
  if (!hash || path.basename(path.dirname(file)) !== 'demo') return false;
  const base = path.resolve(path.dirname(file), '..');
  if (base !== ROOT && readJsonSync(path.join(base, 'package.json'), {})?.name !== 'storyforge') return false;
  return hash;
}
function isRetiredSample(file) {
  const hash = sampleHashForPath(file);
  if (!hash) return false;
  try {
    const content = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    return createHash('sha256').update(content).digest('hex') === hash;
  } catch (err) {
    return err.code === 'ENOENT';
  }
}

// Fingerprints of the two original and migrated v1.0.1 project objects.
// Older migration filled absent creation and save timestamps at open time.
const factoryDraftHashes = new Set([
  '684e0561adc53bc8c666289c4c01c7ea89e6aa6f033235e7f457b1fbf1880c81',
  '91f3cde419b1fa221b2e1da562f3cc96f97f05c2e2ddf0a1a2536554c9a971e4',
  '1f7fa80605071dd778cb4bd2e679eeda6b09c850592c99e848077623333c8bfd',
  'd235737ef160bd38002e524c2bd6be8c11011cd43f7c3529244cb46ac569fe4d',
]);
function isFactoryDraft(draft) {
  if (draft.filePath && !sampleHashForPath(draft.filePath)) return false;
  if (draft.key && !draft.filePath && draft.key !== 'demo:night-shift') return false;
  try {
    const data = JSON.parse(draft.content);
    if (!data?.meta) return false;
    delete data.meta.createdAt;
    delete data.meta.updatedAt;
    return factoryDraftHashes.has(createHash('sha256').update(JSON.stringify(data)).digest('hex'));
  } catch { return false; }
}

let settingsCache = null;
function getSettings() {
  if (!settingsCache) {
    settingsCache = deepMerge(DEFAULT_SETTINGS, readJsonSync(settingsPath(), {}));
    const savedRecent = Array.isArray(settingsCache.recent) ? settingsCache.recent : [];
    settingsCache.recent = savedRecent.filter(file => typeof file === 'string' && !isRetiredSample(file));
    if (typeof settingsCache.lastPath !== 'string' || isRetiredSample(settingsCache.lastPath)) settingsCache.lastPath = null;
  }
  return settingsCache;
}

async function writeSettings(patch) {
  if (patch && 'language' in patch) patch = { ...patch, language: patch.language === 'en' ? 'en' : 'ru' };
  const previousLanguage = getSettings().language;
  settingsCache = deepMerge(getSettings(), patch || {});
  if (settingsCache.language !== previousLanguage) buildMenu();
  if (patch?.theme && process.platform === 'win32' && win && !win.isDestroyed()) {
    win.setTitleBarOverlay(windowControls(settingsCache.theme));
  }
  await fsp.mkdir(userDir(), { recursive: true });
  await atomicWrite(settingsPath(), JSON.stringify(settingsCache, null, 2));
  return settingsCache;
}

// ---------------------------------------------------------------- окно

function windowControls(theme) {
  return {
    color: theme === 'light' ? '#f2f2f2' : '#262626',
    symbolColor: theme === 'light' ? '#383838' : '#dadada',
    height: 40,
  };
}

function createWindow() {
  const theme = getSettings().theme;
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 850,
    minHeight: 700,
    backgroundColor: theme === 'light' ? '#ffffff' : '#1e1e1e',
    ...(process.platform === 'win32' && { titleBarStyle: 'hidden', titleBarOverlay: windowControls(theme) }),
    title: 'StoryForge',
    icon: path.join(ROOT, 'src', 'assets', process.platform === 'win32' ? 'storyforge.ico' : 'storyforge-mark.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // Окно может оказаться за другим окном или быть свёрнутым: без этого
      // Chromium душит таймеры (до 1 раза в секунду) и вообще не вызывает
      // requestAnimationFrame — интерфейс тогда обновляется с задержкой.
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => {
    logLine('ready-to-show');
    win.show();
  });
  const loadOpts = SELFTEST
    ? {
        query: {
          selftest: '1',
          tmp: path.join(LOG_DIR, 'selftest-project.sfproj'),
          ...(AI_BASE ? { aibase: AI_BASE } : {}),
        },
      }
    : undefined;
  win.loadFile(path.join(ROOT, 'src', 'index.html'), loadOpts);

  win.webContents.on('did-fail-load', (_e, code, desc, url) => logLine('did-fail-load', `${code} ${desc} ${url}`));
  win.webContents.on('render-process-gone', (_e, details) => logLine('render-process-gone', details));
  win.webContents.on('preload-error', (_e, preloadPath, error) => logLine('preload-error', preloadPath, (error && error.stack) || String(error)));
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    // 0=verbose 1=info 2=warning 3=error
    if (level >= 2) logLine('renderer', `level=${level}`, message, `${String(sourceId).replace(ROOT, '')}:${line}`);
  });

  win.webContents.on('did-start-navigation', (_event, _url, sameDocument, mainFrame) => {
    if (mainFrame && !sameDocument) closeUIReady = false;
  });
  win.webContents.on('render-process-gone', () => { closeUIReady = false; });
  win.on('close', (event) => {
    if (allowClose || !closeUIReady) return;
    // Even a clean window may have a newly typed edit waiting for its debounce.
    event.preventDefault();
    win.webContents.send('sf:menu', { action: 'file:requestClose' });
  });

  win.on('closed', () => {
    win = null;
  });

  if (DEV) win.webContents.openDevTools({ mode: 'detach' });

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('sf:menu', { action: 'app:ready' });
    if (SMOKE) runSmoke();
    if (SELFTEST) runSelfTest();
  });
}

// ---------------------------------------------------------------- авто-приёмка
// `electron . --smoke-shot` — снимает скриншот окна и собирает диагностику DOM
// в .logs/smoke.png и .logs/smoke.json, затем закрывает приложение.
const SMOKE = process.argv.includes('--smoke-shot');

// `electron . --selftest` — прогоняет функциональный сценарий в самом приложении
// (tools/selftest-renderer.js) и пишет результат в .logs/selftest.json.
const SELFTEST = process.argv.includes('--selftest');
const SELFTEST_FILE =
  (process.argv.find((a) => a.startsWith('--selftest-file=')) || '').slice('--selftest-file='.length) ||
  'tools/selftest-renderer.mjs';
// `--ai-base=http://127.0.0.1:8799/v1` — адрес AI-провайдера для автотеста (заглушка).
const AI_BASE = (process.argv.find((a) => a.startsWith('--ai-base=')) || '').slice('--ai-base='.length);
// `--selftest-shot` или `--selftest-shot=имя` — снимает окно после прогона пробника
// в .logs/<имя>.png (по умолчанию shot.png). Нужно, чтобы посмотреть, как выглядит экран.
const SHOT_ARG = process.argv.find((a) => a === '--selftest-shot' || a.startsWith('--selftest-shot='));
const SHOT_NAME = SHOT_ARG ? SHOT_ARG.split('=')[1] || 'shot' : '';

async function runSelfTest() {
  const out = path.join(LOG_DIR, 'selftest.json');
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    await new Promise((r) => setTimeout(r, 2500));
    const src = fs.readFileSync(path.resolve(ROOT, SELFTEST_FILE), 'utf8');
    const res = await win.webContents.executeJavaScript(`(async () => {\n${src}\nreturn __sfOut;\n})()`, true);
    fs.writeFileSync(out, JSON.stringify(res, null, 2), 'utf8');
    logLine('selftest done', res && res.summary);
    if (SHOT_NAME) {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(LOG_DIR, SHOT_NAME + '.png'), image.toPNG());
      logLine('shot saved', SHOT_NAME + '.png');
    }
  } catch (e) {
    logLine('selftest failed', (e && e.stack) || String(e));
    try {
      fs.writeFileSync(out, JSON.stringify({ fatal: (e && e.stack) || String(e) }, null, 2), 'utf8');
    } catch {
      /* лог уже записан */
    }
  } finally {
    allowClose = true;
    setTimeout(() => app.quit(), 300);
  }
}

async function runSmoke() {
  try {
    await new Promise((r) => setTimeout(r, 2500));
    const probe = await win.webContents.executeJavaScript(`(() => {
      const q = (s) => document.querySelectorAll(s).length;
      const text = (id) => (document.getElementById(id) || {}).innerText || '';
      return {
        title: (document.getElementById('projectTitle') || {}).value || '',
        theme: document.documentElement.dataset.theme || '',
        nodes: q('#graph .node-card'),
        edges: q('#graph .edge'),
        edgeLabels: q('#graph .edge-label'),
        leftTabs: q('#leftTabs .tab'),
        leftItems: q('#leftBody .list-item'),
        inspectorSections: q('#inspectorBody .insp-section'),
        chatEmpty: q('.chat-empty'),
        graphEmptyHidden: (document.getElementById('graphEmpty') || {classList:{contains:()=>false}}).classList.contains('hidden'),
        statusbar: text('statusbar').replace(/\\s+/g, ' ').slice(0, 240),
        badge: text('badgeIssues').replace(/\\s+/g, ' ').slice(0, 80),
        toasts: text('toastRoot').replace(/\\s+/g, ' ').slice(0, 200),
        jsErrors: window.__sfErrors || [],
        layout: (() => {
          const box = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height) };
          };
          const rows = [...document.querySelectorAll('#leftBody .list-item')].map((el) => Math.round(el.getBoundingClientRect().height));
          const overflow = [...document.querySelectorAll('#toolbar, #graphFilters, #statusbar, #leftTabs, #rightTabs, .list-item, .btn, .tab, .dd-item, .st-item')]
            .filter((el) => el.scrollWidth > el.clientWidth + 1)
            .map((el) => (el.id || el.className || el.tagName) + ' ' + el.scrollWidth + '>' + el.clientWidth)
            .slice(0, 12);
          const cs = getComputedStyle(document.documentElement);
          const body = getComputedStyle(document.body);
          return {
            toolbar: box('#toolbar'),
            filters: box('#graphFilters'),
            statusbar: box('#statusbar'),
            leftPanel: box('#leftPanel'),
            rightPanel: box('#rightPanel'),
            rowHeights: [...new Set(rows)].slice(0, 6),
            rowCount: rows.length,
            overflow,
            tokens: {
              accent: cs.getPropertyValue('--accent').trim(),
              muted: cs.getPropertyValue('--muted').trim(),
              fs: cs.getPropertyValue('--fs-md').trim(),
            },
            bodyFont: body.fontFamily + ' / ' + body.fontSize,
          };
        })(),
      };
    })()`);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(LOG_DIR, 'smoke.png'), image.toPNG());
    fs.writeFileSync(path.join(LOG_DIR, 'smoke.json'), JSON.stringify(probe, null, 2), 'utf8');
    logLine('smoke done', probe);
  } catch (e) {
    logLine('smoke failed', (e && e.stack) || String(e));
  } finally {
    allowClose = true;
    setTimeout(() => app.quit(), 300);
  }
}

const uiText = (ru, en) => getSettings().language === 'en' ? en : ru;

function buildMenu() {
  const send = (action) => () => win && win.webContents.send('sf:menu', { action });
  const template = [
    {
      label: uiText("Файл", "File"),
      submenu: [
        { label: uiText("Новый проект", "New project"), accelerator: 'CmdOrCtrl+N', click: send('file:new') },
        { label: uiText("Открыть…", "Open…"), accelerator: 'CmdOrCtrl+O', click: send('file:open') },
        { type: 'separator' },
        { label: uiText("Сохранить", "Save"), accelerator: 'CmdOrCtrl+S', click: send('file:save') },
        { label: uiText("Сохранить как…", "Save as…"), accelerator: 'CmdOrCtrl+Shift+S', click: send('file:saveAs') },
        { type: 'separator' },
        { label: uiText("Экспорт в Godot", "Export to Godot"), click: send('export:godot') },
        { label: uiText("Экспорт в Ren’Py", "Export to Ren’Py"), click: send('export:renpy') },
        { label: uiText("Экспорт в Markdown", "Export to Markdown"), click: send('export:markdown') },
        { label: uiText("Экспорт в JSON", "Export to JSON"), click: send('export:json') },
        { type: 'separator' },
        { label: uiText("Выход", "Exit"), click: () => win?.close() },
      ],
    },
    {
      label: uiText("Правка", "Edit"),
      submenu: [
        { label: uiText("Отменить", "Undo"), accelerator: 'CmdOrCtrl+Z', click: send('edit:undo') },
        { label: uiText("Повторить", "Redo"), accelerator: 'CmdOrCtrl+Shift+Z', click: send('edit:redo') },
        { type: 'separator' },
        { label: uiText("Дублировать узел", "Duplicate node"), accelerator: 'CmdOrCtrl+D', click: send('edit:duplicate') },
        { label: uiText("Удалить", "Delete"), accelerator: 'Delete', click: send('edit:delete') },
        { label: uiText("Новая реплика после выбранной", "Add a line after the selected node"), accelerator: 'CmdOrCtrl+Enter', click: send('edit:newLine') },
      ],
    },
    {
      label: uiText("Вид", "View"),
      submenu: [
        { label: uiText("Поиск", "Search"), accelerator: 'CmdOrCtrl+F', click: send('view:search') },
        { label: uiText("Проверка проекта", "Validate project"), accelerator: 'F5', click: send('view:validate') },
        { label: uiText("Автораскладка", "Auto layout"), accelerator: 'CmdOrCtrl+G', click: send('view:layout') },
        { label: uiText("По размеру", "Fit to view"), click: send('view:fit') },
        { label: uiText("Обзор сюжета", "Story overview"), accelerator: 'CmdOrCtrl+Shift+G', click: send('view:visualizer') },
        { type: 'separator' },
        { label: uiText("Студия голоса", "Voice Studio"), accelerator: 'CmdOrCtrl+Shift+O', click: send('voice:studio') },
        { type: 'separator' },
        { label: uiText("Левая панель", "Left sidebar"), click: send('view:toggleLeft') },
        { label: uiText("Правая панель", "Right sidebar"), click: send('view:toggleRight') },
        { label: uiText("Тема", "Theme"), click: send('view:theme') },
        { type: 'separator' },
        { label: uiText("Инструменты разработчика", "Developer tools"), role: 'toggleDevTools' },
        { label: uiText("Перезагрузить", "Reload"), role: 'reload' },
      ],
    },
    {
      label: uiText("Помощь", "Help"),
      submenu: [
        { label: uiText("Горячие клавиши", "Keyboard shortcuts"), click: send('help:hotkeys') },
        { label: uiText("О программе", "About"), click: send('help:about') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- файлы

function parseProjectText(text, filePath) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `${uiText("Файл не является корректным", "Invalid")} JSON: ${err.message}` };
  }
  if (!json || typeof json !== 'object' || !Array.isArray(json.nodes)) {
    return { ok: false, error: uiText("Файл не похож на проект StoryForge: отсутствует массив nodes.", "This is not a StoryForge project: missing array nodes.") };
  }
  return { ok: true, path: filePath, content: text, project: json };
}

async function readProjectFile(filePath) {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return parseProjectText(text, filePath);
  } catch (err) {
    return { ok: false, error: `${uiText("Не удалось прочитать файл", "Could not read file")}: ${err.message}` };
  }
}

function registerFileIpc() {
  ipcMain.handle('sf:file:openDialog', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: uiText("Открыть проект", "Open project"),
      properties: ['openFile'],
      filters: [
        { name: uiText("Проект StoryForge", "Project StoryForge"), extensions: ['sfproj', 'json'] },
        { name: uiText("Все файлы", "All files"), extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const out = await readProjectFile(res.filePaths[0]);
    return out;
  });

  ipcMain.handle('sf:file:openPath', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return { ok: false, error: uiText("Пустой путь", "Empty path") };
    const out = await readProjectFile(filePath);
    return out;
  });

  ipcMain.handle('sf:file:save', async (_e, { path: filePath, content } = {}) => {
    if (typeof content !== 'string') return { ok: false, error: uiText("Нет содержимого", "Missing content") };
    if (!filePath) return { ok: false, error: uiText("Нет пути", "Missing path") };
    try {
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await atomicWrite(filePath, content);
      await pushRecent(filePath);
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, error: `${uiText("Не удалось сохранить", "Could not save")}: ${err.message}` };
    }
  });

  ipcMain.handle('sf:file:saveAs', async (_e, { suggestedName, content } = {}) => {
    const res = await dialog.showSaveDialog(win, {
      title: uiText("Сохранить проект как", "Save project as"),
      defaultPath: suggestedName || 'project.sfproj',
      filters: [{ name: uiText("Проект StoryForge", "Project StoryForge"), extensions: ['sfproj'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try {
      await atomicWrite(res.filePath, content);
      await pushRecent(res.filePath);
      return { ok: true, path: res.filePath };
    } catch (err) {
      return { ok: false, error: `${uiText("Не удалось сохранить", "Could not save")}: ${err.message}` };
    }
  });

  ipcMain.handle('sf:file:recent', () => getSettings().recent || []);
  ipcMain.handle('sf:file:recentAdd', async (_e, p) => {
    await pushRecent(p);
    return getSettings().recent;
  });
  ipcMain.handle('sf:file:recentClear', async () => {
    await writeSettings({ recent: [] });
    return [];
  });

}

async function pushRecent(filePath) {
  if (!filePath) return;
  const list = (getSettings().recent || []).filter((p) => p !== filePath);
  list.unshift(filePath);
  await writeSettings({ recent: list.slice(0, 8), lastPath: filePath });
}

function registerSettingsIpc() {
  ipcMain.handle('sf:settings:get', () => getSettings());
  ipcMain.handle('sf:settings:set', async (_e, patch) => writeSettings(patch));
  ipcMain.handle('sf:app:setDirty', (_e, value) => {
    dirty = !!value;
    if (win) win.setDocumentEdited && win.setDocumentEdited(!!value);
    return true;
  });
  ipcMain.handle('sf:app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    userData: userDir(),
    dev: DEV,
  }));
  ipcMain.handle('sf:app:closeReady', event => {
    if (win && event.sender === win.webContents) closeUIReady = true;
  });
  ipcMain.handle('sf:app:quit', () => {
    allowClose = true;
    app.quit();
    return true;
  });
  ipcMain.handle('sf:shell:showItem', (_e, p) => {
    if (p && fs.existsSync(p)) shell.showItemInFolder(p);
    return true;
  });
  ipcMain.handle('sf:shell:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https?:/i.test(url)) shell.openExternal(url);
    return true;
  });
}

// ---------------------------------------------------------------- автосохранение

function registerAutosaveIpc() {
  const recovery = recoveryFiles(userDir(), isFactoryDraft);
  ipcMain.handle('sf:autosave:write', async (_e, payload) => {
    try {
      await recovery.write(payload);
      return {ok:true, at:new Date().toISOString()};
    } catch (err) { return {ok:false, error:err.message}; }
  });
  ipcMain.handle('sf:autosave:read', async (_e, key) => {
    const draft = await recovery.read(key);
    if (isRetiredSample(draft?.filePath)) return { ...draft, filePath: null };
    return draft;
  });
  ipcMain.handle('sf:autosave:clear', async (_e,key) => {
    await recovery.clear(key);
    return {ok:true};
  });
  ipcMain.handle('sf:history:read', (_e,key) => readJsonSync(historyPath(key), []));
  ipcMain.handle('sf:history:write', async (_e, payload) => {
    const old = Array.isArray(payload);
    try {
      await atomicWrite(historyPath(old ? null : payload.key), JSON.stringify((old ? payload : payload.messages) || [], null, 2));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

// ---------------------------------------------------------------- экспорт

function registerExportIpc() {
  ipcMain.handle('sf:export:chooseDir', async (_e, suggested) => {
    const res = await dialog.showOpenDialog(win, {
      title: uiText("Папка для экспорта", "Export folder"),
      defaultPath: suggested || app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, dir: res.filePaths[0] };
  });

  ipcMain.handle('sf:export:writeFiles', async (_e, { dir, files } = {}) => {
    if (!dir || !Array.isArray(files) || !files.length) return { ok: false, error: uiText("Нечего записывать", "Nothing to write") };
    try {
      await fsp.mkdir(dir, { recursive: true });
      const written = [];
      for (const f of files) {
        const target = path.join(dir, f.name);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, f.content, 'utf8');
        written.push(target);
      }
      return { ok: true, dir, written };
    } catch (err) {
      return { ok: false, error: `${uiText("Ошибка записи", "Write error")}: ${err.message}` };
    }
  });

  ipcMain.handle('sf:clipboard:write', (_e, text) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });
  ipcMain.handle('sf:clipboard:read', () => clipboard.readText());
}

// ---------------------------------------------------------------- озвучка

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

// Изображения узлов: выбор файлов и чтение в data-URL. Дальше рендерер
// уменьшает их через canvas и кладёт в библиотеку проекта (op addMedia).
function registerMediaIpc() {
  ipcMain.handle('sf:media:pick', async () => {
    const win = BrowserWindow.getAllWindows()[0] || null;
    const result = await dialog.showOpenDialog(win, {
      title: uiText("Добавить изображения", "Add images"),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: uiText("Изображения", "Images"), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] }],
    });
    if (result.canceled || !result.filePaths.length) return { ok: true, files: [] };
    const files = [];
    for (const filePath of result.filePaths.slice(0, 24)) {
      try {
        const buffer = await fsp.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mime = IMAGE_MIME[ext] || 'image/png';
        files.push({
          name: path.basename(filePath),
          mime,
          size: buffer.length,
          data: `data:${mime};base64,${buffer.toString('base64')}`,
        });
      } catch (err) {
        logLine('media pick error', filePath, err && err.message);
      }
    }
    return { ok: true, files };
  });
}

function registerVoiceIpc() {
  const library = createVoiceLibrary(userDir());
  const libraryCall = action => async (_event, payload) => {
    try { return await action(payload); }
    catch (error) { return { ok: false, code: error.code || 'IO_ERROR' }; }
  };
  ipcMain.handle('sf:voiceLibrary:list', libraryCall(async () => ({ ok: true, entries: await library.list() })));
  ipcMain.handle('sf:voiceLibrary:load', libraryCall(async id => ({ ok: true, voice: await library.load(id) })));
  ipcMain.handle('sf:voiceLibrary:save', libraryCall(({ name, voice, replaceId }) => library.save(name, voice, replaceId)));
  // Папка для сохранения озвученных реплик.
  ipcMain.handle('sf:voice:chooseDir', async (_e, suggested) => {
    const res = await dialog.showOpenDialog(win, {
      title: uiText("Куда сохранять озвучку", "Voice export folder"),
      defaultPath: suggested || app.getPath('music') || app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, dir: res.filePaths[0] };
  });

  // Запись WAV: приходит ArrayBuffer/Uint8Array из рендерера.
  ipcMain.handle('sf:voice:writeWav', async (_e, { dir, name, bytes } = {}) => {
    if (!dir) return { ok: false, error: uiText("Не выбрана папка для озвучки", "Choose a voice export folder") };
    if (!name) return { ok: false, error: uiText("Не задано имя файла", "Missing file name") };
    if (!bytes) return { ok: false, error: uiText("Нет данных для записи", "No data to write") };
    try {
      await fsp.mkdir(dir, { recursive: true });
      const safe = String(name).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120);
      const target = path.join(dir, safe.toLowerCase().endsWith('.wav') ? safe : `${safe}.wav`);
      const buffer = Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
      await fsp.writeFile(target, buffer);
      return { ok: true, path: target, size: buffer.length };
    } catch (err) {
      return { ok: false, error: `${uiText("Не удалось записать", "Could not write")} WAV: ${err.message}` };
    }
  });

  // Выбор WAV-сэмпла для «источник: сэмпл».
  ipcMain.handle('sf:voice:pickSample', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: uiText("Сэмпл для озвучки", "Voice sample"),
      filters: [{ name: 'WAV', extensions: ['wav'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    try {
      const file = res.filePaths[0];
      const buffer = await fsp.readFile(file);
      return { ok: true, name: path.basename(file), bytes: new Uint8Array(buffer) };
    } catch (err) {
      return { ok: false, error: `${uiText("Не удалось прочитать файл", "Could not read file")}: ${err.message}` };
    }
  });

  // Открыть папку с озвучкой в проводнике.
  ipcMain.handle('sf:voice:reveal', async (_e, target) => {
    if (!target) return false;
    shell.showItemInFolder(target);
    return true;
  });

  // Сохранить один WAV через диалог «Сохранить как» (вкладка «Диалог» студии).
  ipcMain.handle('sf:voice:saveWave', async (_e, { name, bytes } = {}) => {
    if (!bytes) return { ok: false, error: uiText("Нет данных для записи", "No data to write") };
    const res = await dialog.showSaveDialog(win, {
      title: uiText("Экспорт WAV", "Export WAV"),
      defaultPath: path.join(app.getPath('music') || app.getPath('documents'), String(name || 'voice.wav')),
      filters: [{ name: 'WAV', extensions: ['wav'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try {
      const target = res.filePath.toLowerCase().endsWith('.wav') ? res.filePath : `${res.filePath}.wav`;
      const buffer = Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
      await fsp.writeFile(target, buffer);
      return { ok: true, path: target, size: buffer.length };
    } catch (err) {
      return { ok: false, error: `${uiText("Не удалось записать", "Could not write")} WAV: ${err.message}` };
    }
  });

  // Создать подпапку для «8 вариаций».
  ipcMain.handle('sf:voice:makeDir', async (_e, { dir, name } = {}) => {
    if (!dir) return { ok: false, error: uiText("Не выбрана папка", "No folder selected") };
    try {
      const safe = String(name || uiText("Вариации голоса", "Voice variations")).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60);
      let target = path.join(dir, safe);
      let counter = 2;
      while (true) {
        try {
          await fsp.mkdir(target, { recursive: false });
          return { ok: true, dir: target };
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
          target = path.join(dir, `${safe} ${counter++}`);
        }
      }
    } catch (err) {
      return { ok: false, error: `${uiText("Не удалось создать папку", "Could not create folder")}: ${err.message}` };
    }
  });

  // Голос в .dvoice: сохранить.
  ipcMain.handle('sf:voice:savePreset', async (_e, { name, text } = {}) => {
    if (typeof text !== 'string') return { ok: false, error: uiText("Нет данных голоса", "No voice data") };
    const res = await dialog.showSaveDialog(win, {
      title: uiText("Сохранить голос", "Save voice"),
      defaultPath: path.join(app.getPath('documents'), String(name || 'voice.dvoice')),
      filters: [{ name: uiText("Голос StoryForge", "Voice StoryForge"), extensions: ['dvoice'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try {
      const target = res.filePath.toLowerCase().endsWith('.dvoice') ? res.filePath : `${res.filePath}.dvoice`;
      await fsp.writeFile(target, text, 'utf8');
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, error: `${uiText("Не удалось записать голос", "Could not save voice")}: ${err.message}` };
    }
  });

  // Голос в .dvoice: открыть.
  ipcMain.handle('sf:voice:openPreset', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: uiText("Открыть голос", "Open voice"),
      filters: [{ name: uiText("Голос StoryForge", "Voice StoryForge"), extensions: ['dvoice', 'json'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    try {
      const file = res.filePaths[0];
      const text = await fsp.readFile(file, 'utf8');
      return { ok: true, name: path.basename(file), text };
    } catch (err) {
      return { ok: false, error: `${uiText("Не удалось прочитать голос", "Could not read voice")}: ${err.message}` };
    }
  });
}

// ---------------------------------------------------------------- диалоги

function registerDialogIpc() {
  ipcMain.handle('sf:dialog:message', async (_e, opts = {}) => {
    const res = await dialog.showMessageBox(win, {
      type: opts.type || 'info',
      title: opts.title || 'StoryForge',
      message: opts.message || '',
      detail: opts.detail || '',
      buttons: opts.buttons || ['OK'],
      defaultId: opts.defaultId ?? 0,
      cancelId: opts.cancelId ?? (opts.buttons ? opts.buttons.length - 1 : 0),
      noLink: true,
    });
    return { response: res.response };
  });
}

// ---------------------------------------------------------------- AI-прокси

function normalizeBase(baseUrl) {
  let base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) base = 'https://api.openai.com/v1';
  if (!/\/v\d+$/.test(base) && !/\/v\d+\//.test(base)) {
    // оставляем как есть: пользователь мог указать полный путь
  }
  return base;
}

function buildHeaders(apiKey, extraHeaders) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (extraHeaders && typeof extraHeaders === 'object') {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (v != null && String(v).length) headers[k] = String(v);
    }
  }
  return headers;
}

function registerAiIpc() {
  ipcMain.handle('sf:ai:test', async (_e, { baseUrl, apiKey, extraHeaders } = {}) => {
    const base = normalizeBase(baseUrl);
    const url = `${base}/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await net.fetch(url, { method: 'GET', headers: buildHeaders(apiKey, extraHeaders), signal: controller.signal });
      const text = await res.text();
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 600)}`, url };
      let models = [];
      try {
        const json = JSON.parse(text);
        models = (json.data || json.models || []).map((m) => m.id || m.name).filter(Boolean);
      } catch {
        /* некоторые провайдеры отдают не-JSON — не критично */
      }
      return { ok: true, url, models: models.slice(0, 100) };
    } catch (err) {
      const msg = err && err.name === 'AbortError' ? uiText("Таймаут 30 с: сервер не ответил", "Server did not respond within 30 seconds") : String(err && err.message ? err.message : err);
      return { ok: false, error: `${msg} (${url})`, url };
    } finally {
      clearTimeout(timer);
    }
  });

  ipcMain.handle('sf:ai:abort', (_e, requestId) => {
    const controller = aborters.get(requestId);
    if (controller) {
      controller.abort();
      aborters.delete(requestId);
      return { ok: true };
    }
    return { ok: false, error: uiText("Запрос не найден", "Request not found") };
  });

  ipcMain.handle('sf:ai:chat', async (event, payload = {}) => {
    const { requestId = `r${Date.now()}`, baseUrl, apiKey, extraHeaders, body, timeoutMs = 120000 } = payload;
    const base = normalizeBase(baseUrl);
    const url = `${base}/chat/completions`;
    const controller = new AbortController();
    aborters.set(requestId, controller);
    const timer = setTimeout(() => controller.abort(), Math.max(5000, timeoutMs));
    const send = (chunk) => {
      if (!event.sender.isDestroyed()) event.sender.send('sf:ai:chunk', { requestId, ...chunk });
    };

    try {
      const res = await net.fetch(url, {
        method: 'POST',
        headers: buildHeaders(apiKey, extraHeaders),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        let detail = text.slice(0, 2000);
        try {
          const j = JSON.parse(text);
          detail = j.error?.message || j.message || detail;
        } catch {
          /* не JSON — оставляем текст */
        }
        return { ok: false, error: `HTTP ${res.status} ${res.statusText}: ${detail}`, status: res.status };
      }

      const ctype = res.headers.get('content-type') || '';
      if (!body || !body.stream || !ctype.includes('event-stream')) {
        const json = await res.json();
        const msg = json.choices?.[0]?.message || {};
        const out = {
          ok: true,
          content: msg.content || '',
          toolCalls: (msg.tool_calls || []).map((tc) => ({
            id: tc.id,
            name: tc.function?.name,
            arguments: tc.function?.arguments || '{}',
          })),
          finishReason: json.choices?.[0]?.finish_reason || null,
          usage: json.usage || null,
        };
        if (out.content) send({ delta: out.content });
        send({ done: true });
        return out;
      }

      // ---- SSE-стрим
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let content = '';
      const calls = new Map();
      let finishReason = null;
      let usage = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const rawLine = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!rawLine || rawLine.startsWith(':')) continue;
          if (!rawLine.startsWith('data:')) continue;
          const data = rawLine.slice(5).trim();
          if (data === '[DONE]') continue;
          let json;
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }
          if (json.usage) usage = json.usage;
          const choice = json.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta || {};
          if (typeof delta.content === 'string' && delta.content.length) {
            content += delta.content;
            send({ delta: delta.content });
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const key = tc.index ?? 0;
              const prev = calls.get(key) || { id: '', name: '', arguments: '' };
              if (tc.id) prev.id = tc.id;
              if (tc.function?.name) prev.name += tc.function.name;
              if (tc.function?.arguments) prev.arguments += tc.function.arguments;
              calls.set(key, prev);
            }
          }
        }
      }

      const toolCalls = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, arguments: c.arguments || '{}' }));
      send({ done: true });
      return { ok: true, content, toolCalls, finishReason, usage };
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || /aborted/i.test(String(err.message)));
      const message = aborted ? uiText("Запрос отменён или истёк таймаут", "Request cancelled or timed out") : String(err && err.message ? err.message : err);
      send({ done: true, error: message });
      return { ok: false, error: message, aborted };
    } finally {
      clearTimeout(timer);
      aborters.delete(requestId);
    }
  });
}

// ---------------------------------------------------------------- старт

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('child-process-gone', (_e, details) => logLine('child-process-gone', details));

  app.whenReady().then(async () => {
    logLine('app ready');
    await fsp.mkdir(userDir(), { recursive: true });
    registerFileIpc();
    registerSettingsIpc();
    registerAutosaveIpc();
    registerExportIpc();
    registerVoiceIpc();
  registerMediaIpc();
    registerDialogIpc();
    registerAiIpc();
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', event => {
    if (win && dirty && !allowClose) {
      event.preventDefault();
      win.close();
    }
  });
}
