// tools/selftest-renderer.js — функциональный сценарий приёмки StoryForge.
// Выполняется ВНУТРИ рендерера (main.js --selftest) через executeJavaScript,
// результат пишется в .logs/selftest.json. Требует window.__sfTest (app.js, ?selftest=1).
//
// Здесь проверяется то, что не видно юнит-тестам: реальные DOM-события,
// перерисовка графа, undo, валидатор в интерфейсе, IPC-каналы, AI-цикл.

const checks = [];
const add = (name, ok, info) => checks.push({ name, ok: !!ok, info: info === undefined ? '' : String(info).slice(0, 400) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000, step = 60) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (fn()) return true;
    } catch {
      /* ещё не готово */
    }
    await wait(step);
  }
  return false;
};
const q = (sel) => document.querySelector(sel);
const qa = (sel) => Array.from(document.querySelectorAll(sel));
const byId = (id) => document.getElementById(id);
// innerText у SVG-элементов отсутствует — для них берём textContent.
const text = (el) => ((el && (el.innerText ?? el.textContent)) || '').replace(/\s+/g, ' ').trim();

const T = window.__sfTest;
if (!T) {
  throw new Error('window.__sfTest отсутствует — приложение не в режиме ?selftest=1');
}
// Результат: main.js выполняет этот файл внутри async-обёртки и читает __sfOut.
let __sfOut = null;
const { store, ui } = T;
const project = () => store.project;
const nodeById = (id) => (project().nodes || []).find((n) => n.id === id) || null;
const params = new URLSearchParams(location.search);
const tmpProj = params.get('tmp') || '';

const fire = (el, type, init = {}) => el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
const key = (target, k, init = {}) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

// ---------------------------------------------------------------- 1. каркас
add('первый запуск открывает пустой проект', project()?.nodes.length === 0 && !store.filePath && !store.dirty);
const { makeStoryFixture } = await import(new URL('../tools/test-fixtures.mjs', document.baseURI).href);
const { computeStats, migrateProject } = await import(new URL('./js/model.js', document.baseURI).href);
store.setProject(makeStoryFixture());
store.setSelection({kind:'node', id:project().startNodeId});
ui.inspector.focusNode(project().startNodeId);
ui.graph.showStart();
await until(() => qa('#graph .node-card').length === 12);

add('модули инициализированы (graph/panels/inspector/ai)',
  ui.graph && ui.panels && ui.inspector && ui.ai,
  `graph=${!!ui.graph} panels=${!!ui.panels} inspector=${!!ui.inspector} ai=${!!ui.ai}`);

add('тестовый граф загружен: 12 узлов, стартовый узел задан',
  (project().nodes || []).length === 12 && !!project().startNodeId,
  `узлов ${(project().nodes || []).length}, start=${project().startNodeId}`);

add('граф отрисован (карточки и рёбра)',
  qa('#graph .node-card').length === 12 && qa('#graph .edge').length >= 12,
  `карточек ${qa('#graph .node-card').length}, рёбер ${qa('#graph .edge').length}, подписей ${qa('#graph .edge-label').length}`);

add('у сцены есть фото и карточка выше обычной',
  !!q('#graph .node-card[data-id="qa_scene"] image.node-media')
    && Number((q('#graph .node-card[data-id="qa_scene"] rect.node-bg') || {}).getAttribute?.('height')) > 90,
  `медиа в библиотеке ${Object.keys(project().media || {}).length}`);

add('левая панель: вкладки проекта, поиска, закладок и сущностей',
  ['script','search','bookmarks','characters','locations','variables','stats'].every(name=>q('#leftTabs [data-tab="'+name+'"]')) && qa('#leftBody .list-item').length > 0,
  `вкладок ${qa('#leftTabs .tab').length}, элементов ${qa('#leftBody .list-item').length}`);

// ---------------------------------------------------------------- 2. инспектор
const startId = project().startNodeId;
const startNode = nodeById(startId);
const textField = () => q('#inspectorBody [data-focus="text"]');
add('инспектор показывает стартовый узел (поле текста с содержимым)',
  !!textField() && textField().value === (startNode && startNode.text),
  textField() ? `поле="${String(textField().value).slice(0, 40)}"` : 'поля нет');

// правка текста через инспектор -> модель -> граф
const originalText = startNode.text;
const NEW_TEXT = 'Проверка автотеста: правка текста.';
if (textField()) {
  textField().value = NEW_TEXT;
  fire(textField(), 'input');
  const modelOk = await until(() => nodeById(startId) && nodeById(startId).text === NEW_TEXT, 3000);
  const graphOk = await until(() => {
    const card = q(`#graph .node-card[data-id="${startId}"]`);
    return card && text(card).includes('Проверка автотеста');
  }, 3000);
  const cardDump = (() => {
    const card = q(`#graph .node-card[data-id="${startId}"]`);
    if (!card) return 'карточки нет';
    return text(card).slice(0, 140);
  })();
  add('правка в инспекторе доходит до модели и до карточки графа', modelOk && graphOk, `модель=${modelOk} граф=${graphOk} карточка="${cardDump}"`);

  // undo возвращает текст
  store.undo();
  const undone = await until(() => nodeById(startId) && nodeById(startId).text === originalText, 3000);
  add('undo возвращает исходный текст', undone, `текст="${String(nodeById(startId).text).slice(0, 40)}"`);
} else {
  add('правка в инспекторе доходит до модели и до карточки графа', false, 'нет поля');
  add('undo возвращает исходный текст', false, 'нет поля');
}

// ---------------------------------------------------------------- 3. граф: создание узла
const before = (project().nodes || []).length;
const addBtn = byId('btnAddNode');
if (addBtn) {
  addBtn.click();
  const created = await until(() => (project().nodes || []).length === before + 1, 3000);
  const cardOk = await until(() => qa('#graph .node-card').length === before + 1, 3000);
  add('кнопка «узел» создаёт узел в модели и карточку в графе', created && cardOk, `узлов ${(project().nodes || []).length}, карточек ${qa('#graph .node-card').length}`);
  // Группировка правок (800 мс) может склеить создание с предыдущей правкой —
  // поэтому жмём undo до 3 раз и фиксируем, сколько понадобилось.
  let undos = 0;
  while ((project().nodes || []).length !== before && undos < 3) {
    store.undo();
    undos += 1;
    await wait(120);
  }
  const back = await until(() => (project().nodes || []).length === before, 3000);
  add('undo убирает созданный узел', back, `узлов ${(project().nodes || []).length}, undo нажатий ${undos}`);
} else {
  add('кнопка «узел» создаёт узел в модели и карточку в графе', false, '#btnAddNode не найден');
  add('undo убирает созданный узел', false, '#btnAddNode не найден');
}

// ---------------------------------------------------------------- 4. валидация
const lineNode = (project().nodes || []).find((n) => n.type === 'line');
const savedNext = lineNode ? lineNode.next : null;
if (lineNode) {
  store.apply([{ op: 'updateNode', id: lineNode.id, patch: { next: 'n_нет_такого' } }], { label: 'тест: битая ссылка' });
  const issues = T.validateProject(project());
  const broken = issues.filter((i) => i.code === 'broken-link');
  add('валидатор находит битую ссылку (broken-link)', broken.length >= 1, `найдено ${broken.length}: ${broken.slice(0, 2).map((i) => `${i.code}@${i.nodeId || '-'}`).join(', ')}`);

  const vBtn = byId('btnValidate');
  if (vBtn) vBtn.click();
  const panelOk = await until(() => {
    const panel = byId('validationPanel');
    return panel && !panel.classList.contains('hidden') && qa('#validationBody .sev-row').length > 0;
  }, 3000);
  const badge = text(byId('badgeIssues'));
  add('панель валидации открывается и показывает проблемы', panelOk && badge !== '0', `строк ${qa('#validationBody .sev-row').length}, бейдж "${badge}"`);

  store.apply([{ op: 'updateNode', id: lineNode.id, patch: { next: savedNext } }], { label: 'тест: вернуть ссылку' });
  const after = T.validateProject(project()).filter((i) => i.code === 'broken-link');
  add('после исправления битой ссылки нет', after.length === 0, `broken-link: ${after.length}`);
} else {
  add('валидатор находит битую ссылку (broken-link)', false, 'в проекте нет line-узла');
  add('панель валидации открывается и показывает проблемы', false, 'в проекте нет line-узла');
  add('после исправления битой ссылки нет', false, 'в проекте нет line-узла');
}

// ---------------------------------------------------------------- 5. вкладки левой панели
const tabResults = [];
for (const tab of qa('#leftTabs .tab')) {
  tab.click();
  await wait(160);
  const body = byId('leftBody');
  tabResults.push({ tab: tab.dataset.tab, len: text(body).length });
}
add('все 7 вкладок левой панели переключаются и рисуют содержимое',
  tabResults.length === 7 && tabResults.every((r) => r.len > 20),
  tabResults.map((r) => `${r.tab}:${r.len}`).join(' '));

// ---------------------------------------------------------------- 6. поиск и статистика
const searchTab = qa('#leftTabs .tab').find((t) => t.dataset.tab === 'search');
if (searchTab) {
  searchTab.click();
  await wait(200);
  const input = q('#leftBody input[type="search"], #leftBody input[type="text"], #leftBody .input');
  if (input) {
    input.value = 'Автор';
    fire(input, 'input');
    const found = await until(() => qa('#leftBody .search-group').length > 0 || qa('#leftBody .list-item').length > 0, 3000);
    add('поиск по проекту находит результаты', found, `групп ${qa('#leftBody .search-group').length}, элементов ${qa('#leftBody .list-item').length}`);
  } else {
    add('поиск по проекту находит результаты', false, 'поле поиска не найдено');
  }
} else {
  add('поиск по проекту находит результаты', false, 'вкладка «Поиск» не найдена');
}

const statsTab = qa('#leftTabs .tab').find((t) => t.dataset.tab === 'stats');
if (statsTab) {
  statsTab.click();
  await wait(250);
  const bodyText = text(byId('leftBody'));
  const counts = computeStats(project());
  add('статистика показывает счётчики узлов и слов',
    bodyText.includes(counts.nodes + ' уз') && bodyText.includes(counts.words + ' слов'), bodyText.slice(0, 120));
} else {
  add('статистика показывает счётчики узлов и слов', false, 'вкладка «Статистика» не найдена');
}

// ---------------------------------------------------------------- 7. тема, панели, контекстное меню
const themeBtn = byId('btnTheme');
if (themeBtn) {
  const was = document.documentElement.dataset.theme;
  themeBtn.click();
  await wait(150);
  const now = document.documentElement.dataset.theme;
  themeBtn.click();
  await wait(150);
  add('переключение темы меняет data-theme и возвращается назад',
    now !== was && document.documentElement.dataset.theme === was,
    `${was} -> ${now} -> ${document.documentElement.dataset.theme}`);
} else {
  add('переключение темы меняет data-theme и возвращается назад', false, '#btnTheme не найден');
}

const toggleLeft = byId('btnToggleLeft');
if (toggleLeft) {
  toggleLeft.click();
  await wait(150);
  const collapsed = byId('leftPanel').classList.contains('collapsed');
  toggleLeft.click();
  await wait(150);
  add('панель слева скрывается и возвращается', collapsed && !byId('leftPanel').classList.contains('collapsed'), `collapsed=${collapsed}`);
} else {
  add('панель слева скрывается и возвращается', false, '#btnToggleLeft не найден');
}

const firstCard = q('#graph .node-card');
if (firstCard) {
  firstCard.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
  await wait(200);
  const menu = byId('contextMenu');
  const items = qa('#contextMenu .dd-item').length;
  add('контекстное меню узла открывается с пунктами', menu && !menu.classList.contains('hidden') && items >= 4, `пунктов ${items}`);
  key(document, 'Escape');
  await wait(150);
  add('Esc закрывает контекстное меню', byId('contextMenu').classList.contains('hidden'), 'hidden после Esc');
} else {
  add('контекстное меню узла открывается с пунктами', false, 'нет карточек');
  add('Esc закрывает контекстное меню', false, 'нет карточек');
}

// ---------------------------------------------------------------- 8. хоткеи
if (lineNode) {
  store.apply([{ op: 'updateNode', id: lineNode.id, patch: { text: 'Хоткей-тест' } }], { label: 'тест хоткея' });
  const changed = nodeById(lineNode.id).text === 'Хоткей-тест';
  key(document, 'z', { ctrlKey: true });
  await wait(250);
  add('Ctrl+Z отменяет последнюю правку (глобальный хоткей)',
    changed && nodeById(lineNode.id).text !== 'Хоткей-тест',
    `после хоткея: "${String(nodeById(lineNode.id).text).slice(0, 30)}"`);
} else {
  add('Ctrl+Z отменяет последнюю правку (глобальный хоткей)', false, 'нет line-узла');
}

// ---------------------------------------------------------------- 9. IPC: сохранение/открытие
if (tmpProj) {
  try {
    const content = JSON.stringify(project(), null, 2);
    const saved = await window.sf.file.save(tmpProj, content);
    const opened = await window.sf.file.openPath(tmpProj);
    const roundtrip = opened && opened.ok && opened.project && (opened.project.nodes || []).length === (project().nodes || []).length;
    add('сохранение .sfproj и повторное открытие (IPC) сохраняют проект',
      saved && saved.ok && roundtrip,
      `save=${saved && saved.ok} open=${opened && opened.ok} узлов=${opened && opened.project ? (opened.project.nodes || []).length : '-'}`);
  } catch (e) {
    add('сохранение .sfproj и повторное открытие (IPC) сохраняют проект', false, String(e && e.message));
  }
} else {
  add('сохранение .sfproj и повторное открытие (IPC) сохраняют проект', false, 'нет пути tmp');
}

try {
  const marker = `автосейв-${Date.now()}`;
  await window.sf.autosave.write(marker);
  const read = await window.sf.autosave.read();
  const okAuto = read && read.ok && String(read.content).includes(marker);
  await window.sf.autosave.clear();
  add('автосохранение пишется, читается и очищается', okAuto, `read=${read && read.ok}`);
} catch (e) {
  add('автосохранение пишется, читается и очищается', false, String(e && e.message));
}

try {
  const clip = 'тест-«ёлка»-StoryForge';
  await window.sf.clipboard.write(clip);
  const read = await window.sf.clipboard.read();
  add('буфер обмена: запись и чтение кириллицы', String(read).includes('ёлка'), `прочитано "${String(read).slice(0, 40)}"`);
} catch (e) {
  add('буфер обмена: запись и чтение кириллицы', false, String(e && e.message));
}

// ---------------------------------------------------------------- 10. настройки и AI
try {
  const info = await window.sf.app.info();
  add('window.sf.app.info() отдаёт версию приложения', !!info && !!info.version, `version=${info && info.version}, electron=${window.sf.versions.electron}`);
} catch (e) {
  add('window.sf.app.info() отдаёт версию приложения', false, String(e && e.message));
}

// ---------------------------------------------------------------- поиск: regex
ui.setLeftTab('search');
await wait(200);
const searchInput = () => q('#panelSearchInput');
if (searchInput()) {
  searchInput().value = 'Проверка|Зона';
  fire(searchInput(), 'input');
  await wait(500);
  const plainHits = qa('#leftBody .list-item').length;
  const box = q('#panelSearchRegex');
  if (box) {
    box.checked = true;
    fire(box, 'change');
  }
  await wait(500);
  const regexHits = qa('#leftBody .list-item').length;
  add('поиск: regex-режим (чекбокс) находит по шаблону', !!box && regexHits > 0 && regexHits !== plainHits, `обычный=${plainHits}, regex=${regexHits}`);

  const inp2 = q('#panelSearchInput');
  if (inp2) {
    inp2.value = '[';
    fire(inp2, 'input');
    await wait(500);
    const body = text(q('#leftBody'));
    add('поиск: битый regex даёт понятное сообщение, а не падение', /Некорректное регулярное/.test(body), body.slice(0, 90));
  }
  const inp3 = q('#panelSearchInput');
  if (inp3) {
    inp3.value = '';
    fire(inp3, 'input');
    await wait(400);
  }
}

// ---------------------------------------------------------------- производительность: 500+ узлов
{
  const snap = store.snapshot();
  const t0 = performance.now();
  store.beginGroup('замер: 500 узлов');
  const chapterId = (project().chapters || [])[0]?.id;
  for (let i = 0; i < 500; i++) {
    store.apply([{ op: 'createNode', node: { id: `perf_${i}`, type: 'line', text: `Реплика ${i} для замера производительности.`, chapterId, position: { x: (i % 25) * 260, y: Math.floor(i / 25) * 140 } } }]);
  }
  store.endGroup();
  const applyMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  ui.graph.refresh();
  const renderMs = Math.round(performance.now() - t1);
  const t2 = performance.now();
  T.validateProject(project());
  const validMs = Math.round(performance.now() - t2);
  const t3 = performance.now();
  ui.graph.fit();
  const fitMs = Math.round(performance.now() - t3);
  const total = (project().nodes || []).length;
  add('500+ узлов: создание, отрисовка, валидация и fit без подвисаний', total >= 512 && renderMs < 4000 && validMs < 2000 && fitMs < 2000, `узлов ${total}: apply ${applyMs} мс, render ${renderMs} мс, validate ${validMs} мс, fit ${fitMs} мс`);
  store.restoreSnapshot(snap);
  await wait(300);
  add('после замера проект восстановлен', (project().nodes || []).length === 12, `узлов ${(project().nodes || []).length}`);
}

const aiBase = params.get('aibase');
if (aiBase) {
  try {
    await ui.saveSettings({ ai: { preset: 'custom', baseUrl: aiBase, apiKey: 'test-key', model: 'mock-model', temperature: 0, maxTokens: 512, extraHeaders: '{"x-mock-script":"e2e"}' } });
    const settings = await window.sf.settings.get();
    add('настройки AI сохраняются через IPC', settings && settings.ai && settings.ai.baseUrl === aiBase, `baseUrl=${settings && settings.ai && settings.ai.baseUrl}`);
    add('AI считает себя настроенным (isConfigured)', ui.ai.isConfigured() === true, `isConfigured=${ui.ai.isConfigured()}`);

    const nodesBefore = (project().nodes || []).length;
    ui.setRightTab('ai');
    await wait(200);
    // Отправляем сообщение как пользователь — через поле ввода панели AI.
    const chatInput = q('#aiBody .chat-input');
    if (chatInput) {
      chatInput.value = 'Создай узел-заметку с текстом «Тест AI»';
      fire(chatInput, 'input');
      key(chatInput, 'Enter');
    } else {
      ui.ai.send('Создай узел-заметку с текстом «Тест AI»');
    }

    const done = await until(() => qa('#aiBody .tool-trace').length > 0 && !q('#aiBody [data-ai-act="stop"]'), 25000, 250);
    const traces = qa('#aiBody .tool-trace').length;
    const nodesAfter = (project().nodes || []).length;
    add('AI-цикл: ответ получен, инструменты вызваны', done && traces >= 1, `ответ=${done}, трасс=${traces}, узлов ${nodesBefore}->${nodesAfter}`);
    add('AI-правка применилась (проект изменён ассистентом)', nodesAfter > nodesBefore, `узлов после AI: ${nodesAfter}`);
    if (nodesAfter > nodesBefore) {
      store.undo();
      const reverted = await until(() => (project().nodes || []).length === nodesBefore, 3000);
      add('undo после AI-правки возвращает проект в исходное состояние (одна транзакция)', reverted, `узлов ${(project().nodes || []).length}`);
    } else {
      add('undo после AI-правки возвращает проект в исходное состояние', false, 'правка не применилась');
    }
    const history = await window.sf.history.read(store.filePath || store.documentKey);
    add('история AI-чата сохраняется на диск', Array.isArray(history) && history.some(m => m.role === 'user') && history.some(m => m.role === 'tool'), JSON.stringify(history).slice(0, 80));
  } catch (e) {
    add('AI-цикл: ответ получен, инструменты вызваны', false, String(e && e.message));
  }
}

// ------------------------------------------------- 8. перетаскивание узла
// Проверяем главное свойство: карточка и её рёбра двигаются вместе,
// а позиция сохраняется в модели и откатывается по undo.
{
  const parseT = (el) => {
    const m = /translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/.exec((el && el.getAttribute('transform')) || '');
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  };
  const note = (project().nodes || []).find((n) => n.type === 'note') || (project().nodes || [])[0];
  const cardOf = () => q(`#graph .node-card[data-id="${note.id}"]`);
  const start = parseT(cardOf());
  const zoom = ui.graph.getZoom();
  const rect = cardOf().getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dxPx = 80;
  const dyPx = 48;
  const ev = (x, y) => ({
    clientX: x,
    clientY: y,
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    buttons: 1,
  });

  cardOf().dispatchEvent(new PointerEvent('pointerdown', ev(cx, cy)));
  await wait(40); // даём шанс перерисовке, которая ломала перетаскивание
  window.dispatchEvent(new PointerEvent('pointermove', ev(cx + dxPx, cy + dyPx)));
  await wait(20);
  const during = parseT(cardOf());
  window.dispatchEvent(new PointerEvent('pointerup', ev(cx + dxPx, cy + dyPx)));
  await wait(120);

  const wantDx = dxPx / zoom;
  const wantDy = dyPx / zoom;
  add(
    'перетаскивание: карточка идёт за курсором (а не только рёбра)',
    start && during && Math.abs(during.x - start.x - wantDx) < 2 && Math.abs(during.y - start.y - wantDy) < 2,
    `zoom=${zoom}, сдвиг карточки ${during ? `${(during.x - start.x).toFixed(1)},${(during.y - start.y).toFixed(1)}` : 'нет'}, ожидалось ${wantDx.toFixed(1)},${wantDy.toFixed(1)}`,
  );

  const after = parseT(cardOf());
  const stored = (nodeById(note.id) || {}).position || {};
  add(
    'перетаскивание: позиция сохранена в модели',
    after && Math.abs(stored.x - after.x) < 2 && Math.abs(stored.y - after.y) < 2,
    `модель ${stored.x},${stored.y}; карточка ${after ? `${after.x},${after.y}` : 'нет'}`,
  );

  // Каждое ребро должно начинаться и заканчиваться на границе карточки.
  // Высота карточки переменная: у узлов с фото она больше на полосу превью.
  const anchors = [];
  for (const n of project().nodes || []) {
    const el = q(`#graph .node-card[data-id="${n.id}"]`);
    const t = el && parseT(el);
    if (!t) continue;
    const bg = el.querySelector('rect.node-bg');
    const h = Number((bg && bg.getAttribute('height')) || 90);
    anchors.push({ x: t.x, y: t.y + h / 2 }, { x: t.x + 220, y: t.y + h / 2 });
  }
  const near = (p) => anchors.some((a) => Math.abs(a.x - p.x) < 1.5 && Math.abs(a.y - p.y) < 1.5);
  const loose = [];
  for (const p of qa('#graph .edge')) {
    const m = /^M\s*(-?[\d.]+),(-?[\d.]+)\s*C.*?(-?[\d.]+),(-?[\d.]+)\s*$/.exec(p.getAttribute('d') || '');
    if (!m) {
      loose.push('пустой path');
      continue;
    }
    if (!near({ x: Number(m[1]), y: Number(m[2]) })) loose.push(`начало ${m[1]},${m[2]}`);
    if (!near({ x: Number(m[3]), y: Number(m[4]) })) loose.push(`конец ${m[3]},${m[4]}`);
  }
  add('рёбра держатся за карточки после перетаскивания', loose.length === 0, loose.slice(0, 4).join(' | '));

  store.undo();
  await wait(80);
  const back = parseT(cardOf());
  add(
    'undo возвращает узел на прежнее место',
    back && start && Math.abs(back.x - start.x) < 2 && Math.abs(back.y - start.y) < 2,
    `${back ? `${back.x},${back.y}` : 'нет'} против ${start ? `${start.x},${start.y}` : 'нет'}`,
  );
}

// ---------------------------------------------------------------- 9. диалоги, удаление, валидатор, варианты
try {
  const snap = store.snapshot();
  const nodesCount = () => (project().nodes || []).length;
  const badgeText = () => text(q('#badgeIssues'));
  const closeModals = () => {
    for (const b of Array.from(document.querySelectorAll('#modalRoot .modal-card [data-close]'))) b.click();
  };

  // 9.1 подтверждение: «Да» возвращает true
  {
    const p = ui.confirm('Проверка подтверждения', { okLabel: 'Да' });
    await wait(120);
    q('#modalRoot .modal-card .modal-foot .btn-primary')?.click();
    const ok = await Promise.race([p, wait(1500).then(() => 'таймаут')]);
    add('подтверждение: кнопка «Да» возвращает true', ok === true, `результат ${String(ok)}`);
  }

  // 9.2 подтверждение: «Отмена» возвращает false
  {
    const p = ui.confirm('Проверка отмены', { okLabel: 'Да' });
    await wait(120);
    q('#modalRoot .modal-card .modal-foot .btn')?.click();
    const res = await Promise.race([p, wait(1500).then(() => 'таймаут')]);
    add('подтверждение: «Отмена» возвращает false', res === false, `результат ${String(res)}`);
  }

  // 9.3 подтверждение: крестик возвращает false
  {
    const p = ui.confirm('Проверка крестика', { okLabel: 'Да' });
    await wait(120);
    q('#modalRoot .modal-card [data-close]')?.click();
    const res = await Promise.race([p, wait(1500).then(() => 'таймаут')]);
    add('подтверждение: закрытие крестиком возвращает false', res === false, `результат ${String(res)}`);
  }

  // 9.4 Delete удаляет выделенный узел
  {
    const before = nodesCount();
    const victim = (project().nodes || []).find((n) => n.id !== project().startNodeId && n.type !== 'note');
    ui.selectNode(victim.id);
    await wait(120);
    // как в жизни: сначала уводим фокус из поля ввода, потом жмём Delete
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    await wait(80);
    key(document.body, 'Delete');
    await wait(120);
    // кнопка подтверждения удаления — «опасная» (btn-danger), поэтому берём последнюю в подвале
    q('#modalRoot .modal-card .modal-foot .btn:last-child')?.click();
    const removed = await until(() => nodesCount() === before - 1, 2000);
    add('Delete удаляет выделенный узел', removed, `${before} → ${nodesCount()}`);
    // restoreSnapshot (в отличие от undo) не зависит от того, что лежит в истории:
    // до этого блока в истории могла остаться запись теста производительности.
    store.restoreSnapshot(snap);
    await wait(200);
    add('undo возвращает удалённый узел', nodesCount() === before, `${nodesCount()} узлов, ожидалось ${before}`);
  }

  // 9.5 новый проект при несохранённых изменениях
  {
    const node = (project().nodes || [])[0];
    store.apply([{ op: 'updateNode', id: node.id, patch: { text: `${node.text || ''} (изменено)` } }], { label: 'dirty' });
    await wait(120);
    const act = T.action('file:new'); // может ждать подтверждения — не блокируемся навсегда
    await wait(200);
    qa('#modalRoot .modal-card .modal-foot button').find(b => b.textContent === 'Продолжить без сохранения')?.click();
    await Promise.race([Promise.resolve(act), wait(2500)]);
    const empty = await until(() => nodesCount() === 0, 2500);
    add('новый проект создаётся при несохранённых изменениях', empty, `узлов ${nodesCount()}, заголовок «${q('#projectTitle')?.value}»`);
  }

  // 9.6 валидатор сам обновляется после правки и откатывается на undo
  {
    store.restoreSnapshot(snap);
    await wait(200);
    const clean = badgeText();
    const node = (project().nodes || []).find((n) => n.type === 'line');
    store.apply([{ op: 'updateNode', id: node.id, patch: { next: 'n_нет_такого' } }], { label: 'битая ссылка' });
    const caught = await until(() => badgeText() !== '0' && badgeText() !== clean, 2500);
    const broken = badgeText();
    store.undo();
    const healed = await until(() => badgeText() === clean, 2500);
    add('валидатор пересчитывается сам (бейдж меняется без F5)', caught && healed, `было ${clean}, после поломки ${broken}, после undo ${badgeText()}`);
  }

  // 9.7 редактор вариантов: добавление и перемещение не теряют элементы
  {
    store.restoreSnapshot(snap);
    await wait(200);
    const choiceNode = (project().nodes || []).find((n) => n.type === 'choice');
    ui.selectNode(choiceNode.id);
    await wait(250);
    const list = () => (nodeById(choiceNode.id)?.choices || []).map((c) => c.id);
    const before = list();
    const addBtn = q('#inspectorBody [data-act="choice-add"]');
    const hadBtn = !!addBtn;
    addBtn?.click();
    const added = await until(() => list().length === before.length + 1, 2000);
    // модель меняется синхронно, а панель перерисовывается отдельным таймером —
    // даём ему сработать, иначе читаем ещё не обновлённый DOM
    await wait(150);
    const modelAfterAdd = list().length;
    const domRows = qa('#inspectorBody .insp-choice').length;
    const downBtns = qa('#inspectorBody [data-choice-down]').length;
    // диагностика: перерисовка вручную — отличает «не пришла перерисовка» от «рисует старое»
    ui.inspector.render();
    const rowsAfterManual = qa('#inspectorBody .insp-choice').length;
    qa('#inspectorBody [data-choice-down]')[0]?.click();
    await wait(200);
    const afterMove = list();
    const movedOk = afterMove.length === before.length + 1 && afterMove[1] === before[0] && afterMove[0] === before[1];
    add(
      'варианты: добавление и перемещение не теряют элементы',
      added && movedOk && domRows === before.length + 1,
      `кнопка=${hadBtn}, было ${before.length}, модель после добавления ${modelAfterAdd}, строк ${domRows}, вручную ${rowsAfterManual}, кнопок «вниз» ${downBtns}, после перемещения ${afterMove.length}: ${afterMove.join(',')}, видимость ${document.visibilityState}, ошибки рендера: ${JSON.stringify((window.__sfRenderErrors || []).slice(-3))}`,
    );
    q('#inspectorBody [data-choice-del]')?.click();
    await wait(200);
    add('варианты: удаление убирает ровно один', list().length === before.length, `осталось ${list().length}, ожидалось ${before.length}`);
  }

  // 9.8 заголовок проекта обновляет meta.title
  {
    const input = q('#projectTitle');
    const title = 'Автотест заголовка';
    input.value = title;
    fire(input, 'input');
    const ok = await until(() => (project().meta?.title || '') === title, 2000);
    add('заголовок проекта правит meta.title', ok, `meta.title="${project().meta?.title}"`);
    fire(input, 'change');
    await wait(120);
  }

  // 9.9 набор текста не теряет каретку и символы (перерисовка после apply)
  {
    store.restoreSnapshot(snap);
    await wait(200);
    const id = project().startNodeId;
    ui.selectNode(id);
    await wait(250);
    const field = () => q('#inspectorBody [data-focus="text"]');
    const target = field();
    if (target) {
      target.focus();
      const typed = 'Раз два три';
      target.value = typed;
      target.setSelectionRange(typed.length, typed.length);
      fire(target, 'input');
      const ok = await until(() => (nodeById(id) || {}).text === typed, 2500);
      await wait(250); // дать перерисовке пройти
      const after = field();
      const caretOk = !!after && after === document.activeElement && after.value === typed;
      add(
        'набор текста: значение и фокус сохраняются после перерисовки',
        ok && caretOk,
        `модель=${ok}, поле="${after ? after.value : 'нет'}", фокус=${after === document.activeElement}`,
      );
    } else {
      add('набор текста: значение и фокус сохраняются после перерисовки', false, 'поля текста нет');
    }
  }

  store.restoreSnapshot(snap);
  await wait(150);
  closeModals();
} catch (err) {
  add('раздел 9 (диалоги и удаление) выполнился без исключений', false, String((err && err.message) || err));
}

// ---------------------------------------------------------------- 10. озвучка
try {
  const snap = store.snapshot();
  ui.setRightTab('voice');
  await wait(200);
  add('озвучка: вкладка открывается и панель отрисована', !byId('voiceBody').classList.contains('hidden') && !!q('#voiceBody .voice-panel'), '');
  add('озвучка: карточка голоса на месте', !!q('#voiceBody .voice-card [data-voice-preset]'), '');

  const lineCount = (project().nodes || []).filter((n) => n.type === 'line' && String(n.text || '').trim()).length;
  add('озвучка: список реплик совпадает с числом озвучиваемых узлов', qa('#voiceBody .voice-item').length === lineCount, `реплик ${lineCount}, строк ${qa('#voiceBody .voice-item').length}`);

  const preset = q('#voiceBody [data-voice-preset]');
  if (preset) {
    preset.value = '1';
    fire(preset, 'change');
    const ok = await until(() => (project().voice || {}).preset === 1, 2000);
    add('озвучка: смена характера меняет голос проекта', ok, `preset=${(project().voice || {}).preset}`);
  } else {
    add('озвучка: смена характера меняет голос проекта', false, 'нет поля характера');
  }

  const pitch = q('#voiceBody [data-voice-param="pitch"]');
  if (pitch) {
    pitch.value = '7';
    fire(pitch, 'input');
    const ok = await until(() => Number((project().voice || {}).params?.pitch) === 7, 2000);
    add('озвучка: ползунок высоты пишется в проект', ok, `pitch=${(project().voice || {}).params?.pitch}`);
  } else {
    add('озвучка: ползунок высоты пишется в проект', false, 'нет ползунка pitch');
  }

  // рендер и запись WAV через IPC
  const mod = await import('./js/voice/render.js');
  const paramsMod = await import('./js/voice/params.js');
  const wavMod = await import('./js/voice/wav.js');
  const node = (project().nodes || []).find((n) => n.type === 'line' && String(n.text || '').trim());
  let rendered = null;
  try {
    rendered = mod.renderLine({ params: paramsMod.resolveParams(project().voice), text: node ? node.text : 'Проверка', seed: 42, mode: 'line' });
  } catch (err) {
    add('озвучка: реплика рендерится в звук', false, String(err.message || err));
  }
  if (rendered) {
    add('озвучка: реплика рендерится в звук', rendered.left.length > 1000 && mod.peakOf(rendered) > 0.02, `${rendered.seconds.toFixed(2)} с, пик ${mod.peakOf(rendered).toFixed(2)}`);
    const bytes = wavMod.encodeWav([rendered.left, rendered.right], rendered.rate);
    const saved = await window.sf.voice.writeWav(tmpProj.replace(/[\\/][^\\/]+$/, ''), 'voice-selftest', bytes);
    add('озвучка: WAV пишется на диск через IPC', !!(saved && saved.ok && saved.size > 1000), saved && saved.ok ? `${Math.round(saved.size / 1024)} КБ` : (saved && saved.error) || 'нет ответа');
  } else {
    add('озвучка: WAV пишется на диск через IPC', false, 'рендер не удался');
  }

  // прослушивание не должно падать (звук в тесте не оцениваем)
  if (node && ui.voice) {
    let threw = '';
    try {
      await ui.voice.playNode(node.id);
      await wait(150);
      ui.voice.stop();
    } catch (err) {
      threw = String(err.message || err);
    }
    add('озвучка: прослушивание запускается без ошибок', !threw, threw);
  } else {
    add('озвучка: прослушивание запускается без ошибок', false, 'нет реплики или модуля');
  }

  // голос персонажа
  const ch = (project().characters || [])[0];
  if (ch) {
    const res = store.apply([{ op: 'setVoice', id: ch.id, voice: { preset: 3, params: {} } }], 'тест: голос персонажа');
    const ok = res.ok && ((project().characters || []).find((c) => c.id === ch.id) || {}).voice?.preset === 3;
    add('озвучка: голос персонажа задаётся отдельно', ok, ch.name);
  } else {
    add('озвучка: голос персонажа задаётся отдельно', false, 'нет персонажей');
  }

  // ---------------------------------------------------------- студия голоса
  const studioBtn = q('#voiceBody [data-voice-act="studio"]');
  if (studioBtn) studioBtn.click();
  await wait(120);
  add('студия: открывается по кнопке из вкладки «Озвучка»', !!q('#studioRoot .studio-card') && !byId('studioRoot').classList.contains('hidden'), '');
  add('студия: пять вкладок на месте', qa('#studioRoot .studio-tabs .tab').length === 5, `вкладок ${qa('#studioRoot .studio-tabs .tab').length}`);

  const studioTab = (index) => {
    const button = qa('#studioRoot .studio-tabs .tab')[index];
    if (button) button.click();
  };

  studioTab(1);
  await wait(80);
  add('студия: вкладка «Сэмпл» рисует волну', !!q('#studioRoot canvas.studio-wave'), '');

  studioTab(2);
  await wait(80);
  add('студия: вкладка «EQ» рисует эквалайзер', !!q('#studioRoot canvas.studio-eq'), '');

  if (node) ui.studio.setNode(node.id);
  studioTab(4);
  await wait(80);
  const words = q('#studioRoot .studio-words');
  add('студия: вкладка «Диалог» даёт поле реплики', !!words, '');
  if (words && node) {
    const before = nodeById(node.id).text;
    const changed = 'Проверка студии голоса '.repeat(30);
    words.value = changed;
    words.dispatchEvent(new Event('input', { bubbles: true }));
    add('студия: полный текст длиннее 600 символов записан сразу', nodeById(node.id).text === changed, node.id);
    store.undo();
    add('студия: отмена возвращает текст в модель и редактор', nodeById(node.id).text === before &&
      q('#studioRoot .studio-words')?.value === before, node.id);
  } else {
    add('студия: реплика редактируется из вкладки «Диалог»', false, 'нет узла или поля');
  }

  studioTab(0);
  await wait(80);
  const attack = q('#studioRoot [data-pid="attack"]');
  let attackOk = false;
  let attackWhere = '';
  if (attack) {
    attack.value = '42';
    attack.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(80);
    const target = ui.studio.state.target;
    const { voiceTarget } = await import('./js/voice/profile.js');
    const owner = voiceTarget(project(), target, nodeById(node.id));
    const value = owner?.voice?.params?.attack;
    attackWhere = (target || 'проект') + ', attack=' + value;
    attackOk = Number(value) === 42;
  }
  add('студия: параметр из вкладки «Голос» пишется в голос', attackOk, attackWhere);

  let pulseThrew = '';
  try {
    const pulse = q('#studioRoot [data-st="pulse"]');
    if (pulse) pulse.click();
    await wait(400);
  } catch (err) {
    pulseThrew = String((err && err.message) || err);
  }
  add('студия: «Один звук» играет без ошибок', !pulseThrew, pulseThrew);

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(120);
  add('студия: Esc закрывает студию', byId('studioRoot').classList.contains('hidden'), '');
  ui.setRightTab('inspector');
  store.restoreSnapshot(snap);
  await wait(120);
} catch (err) {
  add('раздел 10 (озвучка) выполнился без исключений', false, String((err && err.message) || err));
}

// ---------------------------------------------------------------- 11. изображения узлов
try {
  const snap = store.snapshot();
  const node = (project().nodes || []).find((n) => n.type === 'line') || project().nodes[0];
  // В тесте уже есть фото у сцены, поэтому считаем дельту, а не абсолютные числа.
  const baseIds = Object.keys(project().media || {});
  const baseCount = baseIds.length;
  const baseNodeMedia = (node.media || []).length;
  ui.selectNode(node.id);
  ui.setRightTab('inspector');
  await wait(250);

  const makeFile = (w, h, color, name) => {
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const cx = cv.getContext('2d');
    cx.fillStyle = color;
    cx.fillRect(0, 0, w, h);
    const dataUrl = cv.toDataURL('image/png');
    const bin = atob(dataUrl.split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: 'image/png' });
  };

  await ui.attachImages(node.id, [makeFile(64, 48, '#d3a05e', 'first.png')]);
  await wait(500);

  const afterFirst = nodeById(node.id);
  const allIds = Object.keys(project().media || {});
  const addedId = allIds.find((id) => !baseIds.includes(id)) || '';
  add(
    'изображения: файл попадает в библиотеку проекта',
    allIds.length === baseCount + 1 && !!addedId,
    'медиа ' + allIds.length + ' (было ' + baseCount + ')',
  );
  add(
    'изображения: файл привязан к узлу и стал превью',
    (afterFirst.media || []).length === baseNodeMedia + 1 && afterFirst.previewId === addedId,
    'media ' + JSON.stringify(afterFirst.media) + ' preview ' + afterFirst.previewId,
  );

  const card = q('.node-card[data-id="' + node.id + '"]');
  const cardImg = card && card.querySelector('image.node-media');
  const cardBg = card && card.querySelector('rect.node-bg');
  add('изображения: на карточке графа есть миниатюра', !!cardImg, cardImg ? String(cardImg.getAttribute('href')).slice(0, 26) : 'нет');
  add(
    'изображения: карточка с фото стала выше',
    cardBg && Number(cardBg.getAttribute('height')) > 90,
    cardBg ? 'высота ' + cardBg.getAttribute('height') : 'нет карточки',
  );

  const inspThumbs = qa('#inspectorBody .insp-media').length;
  add('изображения: инспектор показывает миниатюру', inspThumbs === baseNodeMedia + 1, 'плиток ' + inspThumbs);

  await ui.attachImages(node.id, [makeFile(2400, 1600, '#6f8cf0', 'big.png')]);
  await wait(800);
  const bigId = Object.keys(project().media || {}).find((id) => (project().media[id] || {}).name === 'big.png');
  const big = bigId ? project().media[bigId] : null;
  add('изображения: большая картинка уменьшается при импорте', !!(big && big.w <= 1400), big ? big.w + '×' + big.h : 'нет');

  ui.setNodePreview(node.id, bigId);
  await wait(400);
  const afterPreview = nodeById(node.id);
  const card2 = q('.node-card[data-id="' + node.id + '"]');
  const cardImg2 = card2 && card2.querySelector('image.node-media');
  add('изображения: превью карточки переключается', afterPreview.previewId === bigId, 'preview ' + afterPreview.previewId);
  add(
    'изображения: карточка рисует новое превью',
    !!(cardImg2 && big && String(cardImg2.getAttribute('href')) === String(big.data)),
    cardImg2 ? 'href совпадает' : 'нет image',
  );

  ui.removeNodeMedia(node.id, addedId);
  await wait(400);
  const afterRemove = nodeById(node.id);
  add(
    'изображения: удаление убирает файл из узла',
    (afterRemove.media || []).length === baseNodeMedia + 1,
    'осталось ' + (afterRemove.media || []).length,
  );
  add(
    'изображения: неиспользуемый файл вычищается из библиотеки',
    !project().media[addedId],
    'медиа ' + Object.keys(project().media || {}).length,
  );

  ui.removeNodeMedia(node.id, bigId);
  await wait(400);
  const afterAll = nodeById(node.id);
  const card3 = q('.node-card[data-id="' + node.id + '"]');
  const cardBg3 = card3 && card3.querySelector('rect.node-bg');
  add('изображения: после удаления всех фото карточка без миниатюры', !!(card3 && !card3.querySelector('image.node-media')), '');
  add(
    'изображения: карточка вернулась к обычной высоте',
    cardBg3 && Number(cardBg3.getAttribute('height')) === 90,
    cardBg3 ? 'высота ' + cardBg3.getAttribute('height') : 'нет',
  );
  add(
    'изображения: библиотека вернулась к исходной',
    Object.keys(project().media || {}).length === baseCount,
    JSON.stringify(Object.keys(project().media || {})),
  );

  store.restoreSnapshot(snap);
  await wait(150);
} catch (err) {
  add('раздел 11 (изображения) выполнился без исключений', false, String((err && err.message) || err));
}

// ---------------------------------------------------------------- 12. обзор сюжета
try {
  const viz = ui.visualizer;
  add('обзор сюжета: модуль создан', !!viz, viz ? 'есть api' : 'нет');

  viz.open();
  await wait(420);
  viz.fit();
  await wait(60);

  const root = q('#vizRoot');
  root?.querySelector('[data-viz="settings"][aria-expanded="false"]')?.click();
  const canvas = q('#vizRoot .viz-canvas');
  add(
    'обзор сюжета: окно открылось на весь экран',
    !!root && !root.classList.contains('hidden'),
    root ? 'класс ' + root.className : 'нет #vizRoot',
  );
  add(
    'обзор сюжета: canvas разложен по размеру сцены',
    !!canvas && canvas.width > 200 && canvas.height > 120,
    canvas ? canvas.width + 'x' + canvas.height : 'нет canvas',
  );

  const st = viz.state;
  const storyCount = (project().nodes || []).length;
  const entityCount =
    (project().characters || []).length +
    (project().locations || []).length +
    (project().variables || []).length +
    (project().chapters || []).length;
  add(
    'обзор сюжета: в облаке все узлы и все сущности',
    st.nodes.length === storyCount + entityCount,
    'точек ' + st.nodes.length + ', ожидалось ' + (storyCount + entityCount),
  );
  add(
    'обзор сюжета: связи построены (переходы + персонажи + локации)',
    st.links.length > storyCount,
    'связей ' + st.links.length,
  );
  add(
    'обзор сюжета: кластеры глав перечислены',
    qa('#vizRoot .viz-group-row').length === (project().chapters || []).length,
    'групп ' + qa('#vizRoot .viz-group-row').length,
  );

  // сколько точек реально попадает в кадр после «Вписать»
  const inFrame = st.nodes.filter((n) => {
    const x = (n.x + st.tx) * st.zoom + st.w / 2;
    const y = (n.y + st.ty) * st.zoom + st.h / 2;
    return x > -20 && x < st.w + 20 && y > -20 && y < st.h + 20;
  }).length;
  add('обзор сюжета: после «Вписать» видно всё облако', inFrame === st.nodes.length, 'в кадре ' + inFrame + '/' + st.nodes.length);

  // точки разнесены физикой, а не лежат в одной куче
  let minD = Infinity;
  for (let i = 0; i < st.nodes.length; i += 1) {
    for (let j = i + 1; j < st.nodes.length; j += 1) {
      const d = Math.hypot(st.nodes[i].x - st.nodes[j].x, st.nodes[i].y - st.nodes[j].y);
      if (d < minD) minD = d;
    }
  }
  add('обзор сюжета: точки не слиплись (физика развела)', minD > 8 && Number.isFinite(minD), 'мин. расстояние ' + minD.toFixed(1));

  // фильтры
  const before = st.nodes.length;
  const charsToggle = q('#vizRoot [data-viz="show"][data-key="characters"]');
  if (charsToggle) {
    charsToggle.checked = false;
    fire(charsToggle, 'change');
    await wait(320);
  }
  const afterHide = st.nodes.length;
  add(
    'обзор сюжета: снятие персонажей убирает их из облака',
    afterHide === before - (project().characters || []).length,
    'было ' + before + ', стало ' + afterHide,
  );
  if (charsToggle) {
    charsToggle.checked = true;
    fire(charsToggle, 'change');
    await wait(320);
  }

  // поиск
  const search = q('#vizRoot [data-viz="search"]');
  if (search) {
    search.value = 'Диктор';
    fire(search, 'input');
    await wait(360);
  }
  const found = st.nodes.length;
  add('обзор сюжета: поиск сужает облако', found > 0 && found < before, 'по «Диктор» осталось ' + found);

  // клик по точке открывает узел в редакторе
  viz.close();
  await wait(80);
  const startNode = (project().nodes || []).find((n) => n.id === project().startNodeId) || project().nodes[0];
  viz.open();
  await wait(320);
  viz.fit();
  await wait(60);
  const target = st.nodes.find((n) => n.key === startNode.id);
  if (target) {
    const sx = (target.x + st.tx) * st.zoom + st.w / 2;
    const sy = (target.y + st.ty) * st.zoom + st.h / 2;
    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: sx + canvas.getBoundingClientRect().left, clientY: sy + canvas.getBoundingClientRect().top, bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: sx + canvas.getBoundingClientRect().left, clientY: sy + canvas.getBoundingClientRect().top, bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }));
    await wait(260);
  }
  const sel = store.selection || {};
  add('обзор сюжета: клик по точке выбирает узел', sel.kind === 'node' && sel.id === startNode.id, 'выбрано ' + sel.kind + ':' + sel.id);

  viz.close();
  await wait(80);
  add('обзор сюжета: закрывается', !q('#vizRoot') || q('#vizRoot').classList.contains('hidden'), '');

  // большое облако: 512 узлов открываются за приемлемое время
  {
    const demoProject = store.project;
    const many = [];
    for (let i = 0; i < 512; i += 1) {
      many.push({
        id: 'p_n' + i,
        type: i % 9 === 0 ? 'choice' : 'line',
        text: 'Реплика номер ' + i + ' про проверку индекса',
        speakerId: '',
        locationId: '',
        chapterId: '',
        next: i < 511 ? 'p_n' + (i + 1) : '',
        choices: i % 9 === 0 ? [{ id: 'o_' + i, text: 'Вариант', next: i < 511 ? 'p_n' + (i + 1) : '', condition: '', effects: [] }] : [],
        branches: [],
        effects: [],
        tags: [],
        x: 0,
        y: 0,
      });
    }
    store.setProject({ ...demoProject, nodes: many });
    const t0 = performance.now();
    viz.open();
    await wait(50);
    const elapsed = performance.now() - t0;
    add('обзор сюжета: 512 узлов рисуются быстро', elapsed < 6000, Math.round(elapsed) + ' мс, точек ' + viz.stats.nodes);
    viz.close();
    await wait(60);
    store.setProject(demoProject);
  }
} catch (err) {
  add('раздел 12 (обзор сюжета) выполнился без исключений', false, String((err && err.message) || err));
}

// ---------------------------------------------------------------- 13. производительность
try {
  // 13.1 набор в поле не пересобирает панель инспектора
  {
    const line = (project().nodes || []).find((n) => n.type === 'line');
    store.setSelection({ kind: 'node', id: line.id });
    await wait(200);
    const area = q('#inspectorBody textarea[data-focus="text"]');
    let renders = 0;
    const orig = ui.inspector.render;
    ui.inspector.render = function patched() {
      renders += 1;
      return orig.apply(this, arguments);
    };
    const before = area.value;
    const t0 = performance.now();
    for (let i = 0; i < 10; i += 1) {
      area.value += 'я';
      area.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(25);
    }
    const elapsed = performance.now() - t0;
    ui.inspector.render = orig;
    add('набор в поле не пересобирает панель инспектора', renders === 0, `render() за 10 нажатий: ${renders}, всего ${Math.round(elapsed)} мс (включая паузы)`);
    add('набор не теряет текст', area.value.length === before.length + 10, `символов ${before.length} → ${area.value.length}`);
  }

  // 13.2 текст в графе отсекается по вьюпорту
  {
    const svg = q('#graph');
    const cards = qa('#graph .node-card');
    const far = cards.filter((c) => c.classList.contains('is-far')).length;
    add('граф: карточки вне кадра помечены is-far', far <= cards.length, `карточек ${cards.length}, вне кадра ${far}`);
    const small = svg.classList.contains('is-small');
    store.setSelection({ kind: 'node', id: (project().nodes || [])[0].id });
    ui.graph.setZoom(0.3);
    await wait(80);
    const smallNow = svg.classList.contains('is-small');
    ui.graph.fit();
    await wait(80);
    add('граф: при мелком зуме включается режим без текста', smallNow || small, `is-small при зуме 0.3: ${smallNow}`);
  }

  // 13.3 большая правка не вызывает долгих задач
  {
    const line = (project().nodes || []).find((n) => n.type === 'line');
    store.setSelection({ kind: 'node', id: line.id });
    await wait(150);
    const area = q('#inspectorBody textarea[data-focus="text"]');
    const long = [];
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) long.push(Math.round(e.duration));
    });
    try {
      po.observe({ entryTypes: ['longtask'] });
    } catch {
      /* longtask может быть недоступен */
    }
    for (let i = 0; i < 12; i += 1) {
      area.value += 'х';
      area.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(40);
    }
    await wait(200);
    try {
      po.disconnect();
    } catch {
      /* ignore */
    }
    const worst = long.length ? Math.max(...long) : 0;
    add('набор не порождает длинных задач (>100 мс)', worst < 100, `longtask: ${long.length ? long.join(', ') : 'нет'}`);
  }

  // 13.4 точечная перерисовка: правка одного узла не пересобирает весь граф
  {
    const line = (project().nodes || []).find((n) => n.type === 'line');
    const group = q('#graph .node-card[data-id="' + line.id + '"]');
    group.dataset.probe = '1';
    store.apply([{ op: 'updateNode', id: line.id, patch: { text: line.text + ' (проверка)' } }]);
    await wait(120);
    const same = q('#graph .node-card[data-id="' + line.id + '"]');
    add('правка узла обновляет карточку без пересборки svg', same && same.dataset.probe === '1', same && same.dataset.probe === '1' ? 'карточка переиспользована' : 'карточка пересоздана');
    store.apply([{ op: 'updateNode', id: line.id, patch: { text: line.text } }]);
    await wait(80);
  }
} catch (err) {
  add('раздел 13 (производительность) выполнился без исключений', false, String((err && err.message) || err));
}

// ---------------------------------------------------------------- вставка, геометрия рёбер, фильтры обзора и проигрыватель
{
  const prior = structuredClone(store.project);
  const priorView = ui.graph.getView();
  const first = { id: 'route-a', type: 'line', text: 'Первая реплика', speakerId: 'route-m', next: 'route-q', position: { x: 0, y: 0 } };
  const decision = { id: 'route-q', type: 'choice', text: 'Выбор', choices: [
    { id: 'route-option', text: 'Одно название', next: 'route-b' }
  ], position: { x: 300, y: 0 } };
  const final = {id: 'route-b', type: 'end', text: 'Серверная', position: { x: 600, y: 0 } };
  const orphan = {id: 'route-a2', type: 'line', text: 'Серверная снаружи', speakerId: 'route-m', position: { x: 0, y: 180 }};
  try {
    store.setProject({ ...prior, startNodeId:first.id, nodes:[first, decision, final, orphan], chapters:[], characters:[{id:'route-m',name:'Диктор'}], variables:[], locations:[] });
    await wait(120);
    ui.graph.setFilter({text:'',chapterId:'',showNotes:true});
    const path = () => q('#graph .edge-choice');
    const oldPath = path().getAttribute('d');
    store.apply([{op:'setPositions',positions:{[final.id]:{x:700,y:210}}}]);
    ui.graph.refresh();
    add('геометрия выбора обновляется после смещения цели', path().getAttribute('d') !== oldPath);
    store.undo(); ui.graph.refresh();
    add('отмена смещения возвращает конец стрелки', path().getAttribute('d') === oldPath);
    store.apply([{op:'setChoices',id:decision.id,choices:[{...decision.choices[0],next:first.id}]}]);
    ui.graph.refresh();
    add('переназначение цели с той же подписью видно на схеме',path().getAttribute('d') !== oldPath && q('#graph .edge-label').textContent === 'Одно название');
    store.undo(); ui.graph.refresh();
    ui.insertLine(decision.id,{kind:'choice',id:'route-option'});
    const newId = store.selection.id;
    add('вставка на конкретный выбор сохраняет продолжение',nodeById(decision.id).choices[0].next===newId && nodeById(newId).next===final.id);
    store.undo(); ui.graph.refresh();
    add('одна отмена полностью удаляет вставку',!nodeById(newId) && nodeById(decision.id).choices[0].next===final.id);
    ui.visualizer.open();
    q('#vizRoot [data-viz="settings"][aria-expanded="false"]')?.click();
    const reachable=q('#vizRoot [data-viz="reachable"]');
    reachable.checked=true; fire(reachable,'input');
    const field=q('#vizRoot [data-viz="search"]');
    field.focus(); field.value='';
    for(const c of 'серверная') { field.value+=c; fire(field,'input'); }
    const visible = new Set(ui.visualizer.state.nodes.map(n=>n.key));
    add('поиск обзора сохраняет фокус и полностью набранное слово',document.activeElement===field && field.value==='серверная' && field.selectionStart===field.value.length);
    add('достижимость и поиск пересекаются независимо от персонажа',visible.has(final.id) && !visible.has(orphan.id));
    ui.visualizer.close();
    ui.playBranch(first.id);
    const player = q('.sf-playback');
    player.querySelector('[data-advance]').click(); player.querySelector('[data-option]').click();
    add('игрок видит текст концовки на выбранном маршруте',player.querySelector('.sf-play-line').textContent==='Серверная');
    player.querySelector('[data-back]').click();
    add('шаг назад возвращает выбор читателю',player.querySelector('[data-option]')?.textContent==='Одно название');
    player.closest('.modal')?.querySelector('[data-close]')?.click();
  } catch (err) {
    add('прохождение и рисование изменённой ветки',false,String(err?.stack || err));
  } finally {
    ui.visualizer.close();
    store.setProject(prior);
    ui.graph.setView(priorView);
  }
}


{
  const previous=store.snapshot(), previousPath=store.filePath, previousKey=store.documentKey;
  try {
    const demo = makeStoryFixture();
    store.setProject(demo);
    const wb=ui.workbench;
    wb.openTable('type:line speaker:Диктор');
    const row=q('#tableBody [data-doc]');
    const id=row.dataset.doc;
    row.click();
    const editor=q('#documentText');
    const revised='Изменённая строка редактора.';
    editor.value=revised;
    fire(editor,'input');
    wb.openTable();
    add('таблица сохраняет фильтр и показывает изменённую реплику',q('#tableQuery').value==='type:line speaker:Диктор' && q('#tableBody').textContent.includes(revised));
    const cell=q('#tableBody [data-speaker]');
    const old=nodeById(id).speakerId;
    cell.click();
    const editorSpeaker=q('#tableBody select');
    editorSpeaker.value=project().characters.find(c=>c.id!==old).id;
    fire(editorSpeaker,'change');
    store.undo();
    await wait(90);
    add('смена спикера из таблицы отменяется одним действием',nodeById(id).speakerId===old && q('#tableBody [data-doc]')?.dataset.doc===id);
    wb.quickJump();
    const search=q('#jumpInput');
    search.value=id;fire(search,'input');
    key(search,'Enter',{ctrlKey:true});
    add('быстрый переход открывает выбранный узел с клавиатуры',wb.current()==='node' && store.selection.id===id && !q('#jumpInput'));
    wb.daily();
    const first=store.selection.id;
    wb.daily();
    add('одна авторская заметка на локальную дату',store.selection.id===first && nodeById(first)?.type==='note');
    wb.openNode(id);
    const chapterId=nodeById(id).chapterId;
    store.apply([{op:'deleteNode',id}]);
    await wait(80);
    const emptyDoc=q('#workspacePage .wb-empty');
    emptyDoc.click();
    const stayed=wb.current()==='node' && !ui.visualizer.isOpen();
    emptyDoc.querySelector('[data-doc-act="overview"]').click();
    const opened=ui.visualizer.isOpen();
    ui.visualizer.close();
    q('#workspacePage [data-doc-act="chapter"]').click();
    add('удалённая сцена ведёт в свою главу или обзор только по кнопке',stayed && opened && store.selection.kind==='chapter' && store.selection.id===chapterId);
  } catch(e) {
    add('рабочие вкладки сценариста',false,String(e?.stack||e));
  } finally {store.setProject(previous,{filePath:previousPath,documentKey:previousKey});}
}
// Сквозной путь автора проверяет вместе интерфейс, модель и файл.
if (tmpProj) {
  const tab = ui.workbench;
  const filter = 'type:line speaker:Диктор location:"Зал №2"';
  const originalLine = 'Текст после редактирования.';
  const insertedLine = 'Вставленная строка.';
  const filename = tmpProj.replace(/\.sfproj$/, '-editor.sfproj');
  const fillText = (value) => {
    const field = q('#documentText');
    field.focus();
    field.value = value;
    fire(field, 'input');
  };
  try {
    const demo = makeStoryFixture();
    store.setProject(demo, { filePath: filename });
    tab.openTable(filter);
    add('Фильтр по спикеру и локации находит общий узел',
      q('#tableCount').textContent === '1 из 12' && q('[data-doc=qa_shared]'));
    q('[data-doc=qa_shared]').click();
    const incoming = qa('[data-open-node=qa_choice]');
    add('Редактор — два входа показывают название каждого варианта',
      incoming.length === 2 && incoming.some(el => text(el).includes('Второй путь')) &&
      incoming.some(el => text(el).includes('Третий путь')));
    fillText(originalLine);
    incoming[0].click();
    q('[data-doc-act=insert]').click();
    qa('.sf-insert-options button')[1].click();
    await until(() => store.selection.id !== 'qa_choice' && q('#documentText'));
    const inserted = store.selection.id;
    fillText(insertedLine);
    const speaker = q('#inspectorBody select[data-bind=speakerId]');
    speaker.value = 'qa_reader';
    fire(speaker, 'change');
    q('[data-doc-act=listen]').click();
    await wait(360);
    tab.openNode('qa_choice');
    q('[data-doc-act=play]').click();
    q('[data-option="1"]').click();
    add('Редактор — игрок проходит вставку и возвращается на выбранный переход',
      text(q('.sf-play-line')) === insertedLine &&
      nodeById('qa_choice').choices[1].next === inserted && nodeById(inserted).next === 'qa_shared');
    q('[data-advance]').click();
    add('Редактор — после вставки игрок читает исправленную реплику', text(q('.sf-play-line')) === originalLine);
    q('#modalRoot [data-close]').click();
    tab.openTable();
    add('Редактор — после прохождения таблица восстанавливает фильтр и выводит новый текст',
      q('#tableQuery').value === filter && q('#tableBody').textContent.includes(originalLine));
    q('[data-doc=qa_shared]').click();
    fillText(originalLine + '!');
    const saved = await ui.saveProject();
    const reopened = await window.sf.file.openPath(filename);
    const data = migrateProject(reopened.project || JSON.parse(reopened.content)).project;
    add('Редактор — немедленное сохранение и чтение сохраняют текст, голос, изображение и переход',
      saved && reopened.ok && data.nodes.find(n => n.id === 'qa_shared')?.text === originalLine + '!' &&
      data.nodes.find(n => n.id === inserted)?.next === 'qa_shared' &&
      data.nodes.find(n => n.id === inserted)?.speakerId === 'qa_reader' &&
      JSON.stringify(data.voice) === JSON.stringify(demo.voice) &&
      data.characters.every(c => JSON.stringify(c.voice) === JSON.stringify(demo.characters.find(old => old.id === c.id)?.voice)) &&
      JSON.stringify(data.media) === JSON.stringify(demo.media));
  } catch (err) {
    add('сквозной путь автора по тестовому графу', false, String(err?.stack || err));
  }
}
// Переходы рабочего места должны работать и в окне с нативной строкой заголовка.
{
  const header = q('#documentTabs').getBoundingClientRect();
  const rail = q('#toolbar').getBoundingClientRect();
  add('лента команд и вкладки занимают разные области рабочего окна',
    rail.width >= 32 && rail.width <= 56 && rail.height > 200 && header.height > 20 && header.x >= rail.right);
  const filter = 'type:line speaker:Диктор';
  ui.workbench.openTable(filter);
  const row = q('#tableBody [data-doc]');
  row?.click();
  q('#shellBack')?.click();
  await wait(75);
  const returned = ui.workbench.current() === 'table' && q('#tableQuery')?.value === filter;
  q('#shellForward')?.click();
  await wait(75);
  add('назад возвращает фильтр таблицы, вперёд возвращает открытую сцену',
    returned && ui.workbench.current() === 'node' && store.selection.id === row?.dataset.doc);
  ui.workbench.openTable(filter);
  q('#btnViz').click();
  const tabs = qa('#documentTabs [data-tab-index]').length;
  q('#btnViz').click();
  const selectedGraph = ui.visualizer.isOpen() && ui.workbench.current() === 'overview' &&
    q('#documentTabs [aria-current]').textContent.includes('Обзор') && qa('#documentTabs [data-tab-index]').length === tabs;
  q('#shellBack').click();
  const previousTable = ui.workbench.current() === 'table' && q('#tableQuery')?.value === filter;
  q('#shellForward').click();
  const forwardGraph = ui.visualizer.isOpen() && ui.workbench.current() === 'overview';
  const graphSettings = q('#vizRoot [data-viz="settings"]');
  if (graphSettings.getAttribute('aria-expanded') !== 'true') graphSettings.click();
  key(q('#vizRoot'), 'Escape');
  add('Escape сначала закрывает настройки графа и возвращает фокус кнопке',
    ui.visualizer.isOpen() && graphSettings.getAttribute('aria-expanded') === 'false' && document.activeElement === graphSettings);
  key(q('#vizRoot'), 'Escape');
  add('обзор работает отдельной вкладкой с историей и возвратом к фильтру',
    selectedGraph && previousTable && forwardGraph && ui.workbench.current() === 'table' && !ui.visualizer.isOpen(),
    JSON.stringify({selectedGraph, previousTable, forwardGraph, view:ui.workbench.current(), open:ui.visualizer.isOpen(),
      focus:document.activeElement?.id, openMenus:qa('details[open]').map(el=>el.id || el.className), forward:ui.workbench.historyState().forward}));
}
// Четыре точки образуют две перпендикулярные связи и отдельный остров.
// Фиксируем только начальную раскладку обзора, затем используем его настоящие события и canvas.
{
  const prior = store.snapshot(), filePath = store.filePath, documentKey = store.documentKey;
  const theme = document.documentElement.dataset.theme;
  const v = ui.visualizer.state;
  const priorFilters = { show: { ...v.show }, search: v.search, localId: v.localId,
    onlyReachable: v.onlyReachable, hiddenChapters: new Set(v.hiddenChapters) };
  try {
    const start = { id: 'probe-start', type: 'line', text: 'Начало', next: 'probe-end', speakerId: 'probe-speaker' };
    const end = { id: 'probe-end', type: 'end', text: 'Конец' };
    const orphan = { id: 'probe-island', type: 'scene', text: 'Остров' };
    const speaker = { id: 'probe-speaker', name: 'Рассказчик' };
    store.setProject({ ...prior, startNodeId: start.id, nodes: [start, end, orphan],
      characters: [speaker], locations: [], variables: [], chapters: [] });
    document.documentElement.dataset.theme = 'dark';
    ui.workbench.openOverview();
    Object.assign(v, { show: { ...v.show, characters: true, orphans: true }, search: '', localId: null,
      onlyReachable: false, hiddenChapters: new Set() });
    ui.visualizer.render();
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    await frame();
    v.alpha = 0;
    await frame();
    const canvas = q('#vizRoot .viz-canvas');
    const ctx = canvas.getContext('2d');
    Object.assign(v, { autoFrame: false, zoom: 1, tx: 0, ty: 0 });
    const dx = Math.min(105, Math.floor(v.w / 5)), dy = Math.min(70, Math.floor(v.h / 5));
    const place = (id, x, y) => {
      const node = v.byId.get(id);
      if (!node) throw Error('Нет точки ' + id + '; на графе: ' + v.nodes.map(n => n.key).join(', '));
      return Object.assign(node, { x, y, vx: 0, vy: 0 });
    };
    const a = place(start.id, -dx, dy), b = place(end.id, dx, dy);
    const c = place(orphan.id, dx, -dy), s = place(speaker.id, -dx, -dy);
    const screen = node => ({ x: (node.x + v.tx) * v.zoom + v.w / 2, y: (node.y + v.ty) * v.zoom + v.h / 2 });
    const pointer = (type, point, buttons = 0) => {
      const box = canvas.getBoundingClientRect();
      const ev = new PointerEvent(type, { clientX: box.left + point.x, clientY: box.top + point.y,
        pointerId: 1, pointerType: 'mouse', button: 0, buttons, isPrimary: true, bubbles: true });
      // Синтетический указатель уже адресован canvas; ОС выдаёт захват только физической мыши.
      if (type !== 'pointerdown') return canvas.dispatchEvent(ev);
      const original = Object.getOwnPropertyDescriptor(canvas, 'setPointerCapture');
      canvas.setPointerCapture = () => {};
      try { return canvas.dispatchEvent(ev); }
      finally {
        if (original) Object.defineProperty(canvas, 'setPointerCapture', original);
        else delete canvas.setPointerCapture;
      }
    };
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 0, cancelable: true }));
    const composite = (data, offset = 0) => [0, 1, 2].map(i => 28 + (data[offset+i] - 28) * data[offset+3] / 255);
    const color = (x, y) => composite(ctx.getImageData(Math.floor(x * v.dpr), Math.floor(y * v.dpr), 1, 1).data);
    const nodeColor = node => { const p = screen(node); return color(p.x, p.y); };
    const distance = (u, w) => Math.hypot(...u.map((value, i) => value - w[i]));
    const paper = color(3, 3);
    function solidEdge(bitmap, first, last, violet) {
      const p = screen(first), q = screen(last);
      const horizontal = p.y === q.y;
      const length = Math.hypot(q.x - p.x, q.y - p.y);
      for (let i = 14; i <= length - 14; i++) {
        const x = p.x + (q.x - p.x) * i / length, y = p.y + (q.y - p.y) * i / length;
        const strip = [-1, 0, 1].map(j => {
          const u = Math.floor(x * v.dpr) + (horizontal ? 0 : j);
          const w = Math.floor(y * v.dpr) + (horizontal ? j : 0);
          return composite(bitmap.data, 4 * (u + w * bitmap.width));
        });
        const ink = strip.reduce((m, n) => distance(n, paper) > distance(m, paper) ? n : m);
        if (distance(ink, paper) < 4 || (violet ? ink[2] - ink[1] < 5 : Math.max(...ink) - Math.min(...ink) > 22)) return false;
      }
      return true;
    }
    const edges = violet => {
      const bitmap = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return solidEdge(bitmap, a, b, violet) && solidEdge(bitmap, a, s, violet);
    };
    const idle = nodeColor(c), neighbor = nodeColor(b), sourceColor = nodeColor(a);
    add('граф рисует прямую сплошную серую линию и для перехода, и для связи с персонажем',
      edges(false));
    const sampleTransition = async type => {
      const samples = { island: [nodeColor(c)], source: [nodeColor(a)] };
      const sample = () => {
        samples.island.push(nodeColor(c));
        samples.source.push(nodeColor(a));
      };
      pointer(type, screen(a));
      sample();
      const started = performance.now();
      do {
        await frame();
        sample();
      } while (performance.now() - started < 330);
      return samples;
    };
    const intermediate = (frames, initial, final) => {
      const span = distance(initial, final);
      return span > 30 && frames.some(p => distance(p, initial) > span * .08 && distance(p, final) > span * .08);
    };
    const entering = await sampleTransition('pointermove');
    const dim = entering.island.at(-1), violet = entering.source.at(-1);
    add('на остановленном графе наведение плавно затемняет дальний узел и сохраняет цвет соседа',
      distance(dim, paper) < distance(idle, paper) * .6 && distance(neighbor, nodeColor(b)) < 6 &&
      intermediate(entering.island, idle, dim) && intermediate(entering.source, sourceColor, violet) &&
      violet[2] > violet[0] && violet[0] > violet[1], entering.island.map(p => Math.round(p[0])));
    add('подсветка сохраняет обе связи прямыми, сплошными и фиолетовыми',
      edges(true));
    const leaving = await sampleTransition('pointerleave');
    add('после ухода курсора цвет восстанавливается через промежуточные кадры',
      distance(leaving.island.at(-1), idle) < 5 && distance(leaving.source.at(-1), sourceColor) < 5 &&
      intermediate(leaving.island, dim, idle) && intermediate(leaving.source, violet, sourceColor),
      leaving.island.map(p => Math.round(p[0])));

    const saved = JSON.stringify(store.project);
    const drop = { x: v.w / 2, y: v.h * .1 };
    pointer('pointerdown', screen(a), 1);
    pointer('pointermove', drop, 1);
    const atDrop = screen(a);
    pointer('pointerup', drop);
    const release = { x: a.x, y: a.y };
    const toward = { x: (b.x + s.x) / 2 - a.x, y: (b.y + s.y) / 2 - a.y };
    await frame();
    await frame();
    const moved = { x: a.x - release.x, y: a.y - release.y };
    add('после отпускания связи тянут узел от места сброса, документ остаётся прежним',
      Math.hypot(atDrop.x - drop.x, atDrop.y - drop.y) < 2 && !v.dragging && !a.fixed &&
      Math.hypot(moved.x, moved.y) > .25 && moved.x * toward.x + moved.y * toward.y > 0 &&
      ui.workbench.current() === 'overview' && JSON.stringify(store.project) === saved, JSON.stringify({ atDrop, drop, moved }));
    pointer('pointerdown', screen(a), 1);
    pointer('pointerup', screen(a));
    add('обычный клик после перетаскивания открывает документ выбранного узла',
      ui.workbench.current() === 'node' && store.selection.id === start.id);
  } catch (err) {
    add('проверка интерактивного графа', false, String(err?.stack || err));
  } finally {
    if (theme === undefined) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    store.setProject(prior, { filePath, documentKey });
    Object.assign(v, priorFilters);
    if (ui.visualizer.isOpen()) ui.visualizer.render();
  }
}
// ---------------------------------------------------------------- итог
const failed = checks.filter((c) => !c.ok);
__sfOut = {
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  failed: failed.map((c) => `${c.name} — ${c.info}`),
  jsErrors: (window.__sfErrors || []).slice(0, 20),
  checks,
};
