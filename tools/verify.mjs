#!/usr/bin/env node
// tools/verify.mjs — приёмочный прогон StoryForge (Node, без зависимостей).
// Запуск из корня проекта:  node tools/verify.mjs
// Выходной код 1 — если есть хотя бы один FAIL. Отсутствующие (ещё не написанные)
// модули помечаются SKIP и скрипт не падает.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { makeStoryFixture, makeStressFixture } from './test-fixtures.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = ['model', 'export', 'graph', 'inspector', 'panels', 'ai', 'app', 'voice', 'voice-studio', 'media', 'visualizer'];
const VOICE_MODULES = ['dsp', 'params', 'render', 'wav'];
const jsPath = (m) => path.join(ROOT, 'src', 'js', `${m}.js`);
const exists = (p) => fs.existsSync(p);
// Терпимое чтение: срезаем UTF-8 BOM (встречается в файлах команды).
const read = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const readJSON = (p) => JSON.parse(read(p));
const clone = (v) => structuredClone(v);

const results = [];
let fails = 0;

function add(status, name, detail = '') {
  results.push({ status, name, detail });
  if (status === 'FAIL') fails++;
  console.log(`  [${status}] ${name}${detail ? ` — ${detail}` : ''}`);
}
function check(name, fn) {
  try {
    fn();
    add('PASS', name);
  } catch (e) {
    add('FAIL', name, String((e && e.message) || e).split('\n')[0]);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    add('PASS', name);
  } catch (e) {
    add('FAIL', name, String((e && e.message) || e).split('\n')[0]);
  }
}
function skip(name, why) {
  add('SKIP', name, why);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ================================================================ 1. Окружение

console.log('\n=== 1. Окружение ===');
add('PASS', `node ${process.version} доступен`);
check('electron.exe распакован (node_modules\\electron\\dist\\electron.exe)', () => {
  assert(exists(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')), 'файл не найден');
});
check('package.json (корень): main = main.js', () => {
  const p = readJSON(path.join(ROOT, 'package.json'));
  assert(p.main === 'main.js', `main = ${p.main}`);
});
check('src/package.json: "type":"module" (ESM для src/js)', () => {
  const p = readJSON(path.join(ROOT, 'src', 'package.json'));
  assert(p.type === 'module', `type = ${p.type}`);
});
check('main.js/preload.js — CommonJS: в корневом package.json нет "type":"module"', () => {
  const p = readJSON(path.join(ROOT, 'package.json'));
  assert(
    p.type !== 'module',
    'корневой package.json содержит "type":"module", а main.js/preload.js написаны на require() (контракт §0). Electron 28+ при "type":"module" грузит main.js как ESM — require/__dirname не определены. Убрать "type":"module" из корня (ESM для src/js уже даёт src/package.json).'
  );
});
{
  // Синтаксис main/preload именно как CJS — через временную .cjs-копию.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cjs-'));
  for (const f of ['main.js', 'preload.js']) {
    check(`node --check ${f} (как CJS)`, () => {
      assert(exists(path.join(ROOT, f)), 'файла нет');
      const dst = path.join(tmp, f.replace(/\.js$/, '.cjs'));
      fs.copyFileSync(path.join(ROOT, f), dst);
      const r = spawnSync(process.execPath, ['--check', dst], { encoding: 'utf8' });
      assert(r.status === 0, ((r.stderr || '').trim().split('\n')[0]) || `exit ${r.status}`);
    });
  }
}

// ================================================================ 2. Синтаксис src/js

console.log('\n=== 2. Синтаксис src/js (node --check, ESM через src/package.json) ===');
for (const m of MODULES) {
  const p = jsPath(m);
  if (!exists(p)) {
    skip(`node --check ${m}.js`, 'файл ещё не создан');
    continue;
  }
  check(`node --check ${m}.js`, () => {
    const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8', cwd: ROOT });
    assert(r.status === 0, ((r.stderr || '').trim().split('\n').slice(0, 2).join(' | ')) || `exit ${r.status}`);
  });
}

console.log('\n=== 2б. Синтаксис src/js/voice/* (движок озвучки) ===');
for (const m of VOICE_MODULES) {
  const p = path.join(ROOT, 'src', 'js', 'voice', `${m}.js`);
  if (!exists(p)) {
    skip(`node --check voice/${m}.js`, 'файл ещё не создан');
    continue;
  }
  check(`node --check voice/${m}.js`, () => {
    const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8', cwd: ROOT });
    assert(r.status === 0, ((r.stderr || '').trim().split('\n').slice(0, 2).join(' | ')) || `exit ${r.status}`);
  });
}

// ================================================================ 3. DOM-каркас

console.log('\n=== 3. DOM-каркас (index.html ↔ контракт §5 ↔ src/js) ===');
const htmlPath = path.join(ROOT, 'src', 'index.html');
const htmlIds = new Set([...read(htmlPath).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const CONTRACT_IDS = [
  'projectTitle', 'btnFile', 'menuFile', 'recentList', 'btnExport', 'menuExport',
  'btnUndo', 'btnRedo', 'btnSearch', 'btnTheme', 'btnValidate', 'badgeIssues',
  'btnToggleLeft', 'btnToggleRight', 'btnSettings', 'banner', 'bannerText', 'btnRestore', 'btnDismissBanner',
  'leftTabs', 'leftBody', 'splitterLeft', 'splitterRight',
  'filterChapter', 'filterText', 'filterNotes', 'btnAddNode', 'btnLayout', 'btnFit', 'zoomLabel',
  'graphHost', 'graph', 'graphEmpty', 'btnCreateFirst',
  'validationPanel', 'validationBody', 'sevFilter', 'btnCloseValidation',
  'rightTabs', 'inspectorBody', 'voiceBody', 'aiBody',
  'stFile', 'stDirty', 'stCounts', 'stAutosave', 'stIssues', 'stVersion',
  'studioRoot', 'modalRoot', 'contextMenu', 'toastRoot',
];
check('все id из таблицы контракта §5 присутствуют в index.html', () => {
  const missing = CONTRACT_IDS.filter((id) => !htmlIds.has(id));
  assert(!missing.length, `отсутствуют в index.html: ${missing.join(', ')}`);
});

// Все статические getElementById/$('...') из готовых js-файлов должны существовать в html.
for (const m of MODULES) {
  const p = jsPath(m);
  if (!exists(p)) continue;
  const src = read(p);
  const used = new Set([
    ...[...src.matchAll(/\$\(\s*['"]([\w-]+)['"]\s*\)/g)].map((x) => x[1]),
    ...[...src.matchAll(/getElementById\(\s*['"]([\w-]+)['"]\s*\)/g)].map((x) => x[1]),
  ]);
  if (!used.size) continue;
  check(`${m}.js: все искомые id существуют в HTML или шаблоне модуля`, () => {
    const templateIds = new Set([...src.matchAll(/\bid="([\w-]+)"/g)].map(match => match[1]));
    const missing = [...used].filter((id) => !htmlIds.has(id) && !templateIds.has(id));
    assert(!missing.length, `нет в index.html: ${missing.join(', ')}`);
  });
}

// ================================================================ 4. Интеграция готовых файлов

console.log('\n=== 4. Интеграция каркаса (main.js / preload.js / app.js) ===');
check('app.js вызывает только те sf.*-методы, что выставляет preload.js', () => {
  assert(exists(jsPath('app')), 'src/js/app.js ещё не создан');
  const appSrc = read(jsPath('app'));
  const used = new Set([...appSrc.matchAll(/sf\.([a-zA-Z]+)\.([a-zA-Z]+)/g)].map((m) => `${m[1]}.${m[2]}`));
  const preloadSrc = read(path.join(ROOT, 'preload.js'));
  const missing = [...used].filter((k) => !preloadSrc.includes(`${k.split('.')[1]}:`));
  assert(!missing.length, `preload.js не выставляет: ${missing.join(', ')}`);
});
check('поставка приложения содержит только пользовательский редактор', () => {
  assert(!exists(path.join(ROOT, 'demo')) || fs.readdirSync(path.join(ROOT, 'demo')).length === 0, 'остался каталог примеров');
  assert(!read(path.join(ROOT, 'src', 'index.html')).includes('file:demo'), 'осталась команда открытия примера');
});

// ================================================================ 5. model.js

console.log('\n=== 5. model.js ===');
let model = null;
if (!exists(jsPath('model'))) {
  skip('model.js: импорт и все проверки', 'файл ещё не создан');
} else {
  await checkAsync('model.js: импортируется без DOM', async () => {
    model = await import(pathToFileURL(jsPath('model')).href);
  });
}

const sample = makeStoryFixture();
let P = null; // мигрированный набор данных
if (model && sample) {
  await checkAsync('model.migrateProject: тестовый проект мигрирует без исключений', async () => {
    const mig = model.migrateProject(clone(sample));
    assert(mig && mig.project && Array.isArray(mig.project.nodes), 'не вернул project с nodes');
    assert(Array.isArray(mig.warnings), 'не вернул warnings[]');
    P = mig.project;
  });
}

// --- большой тестовый проект для «Обзора сюжета»
if (model) {
  const stress = makeStressFixture();
  check('большой проект: сотни узлов', () => {
    assert(stress.nodes.length >= 200, `узлов ${stress.nodes.length}`);
  });
  check('большой проект: пять глав и восемь персонажей', () => {
    assert(stress.chapters.length === 5, `глав ${stress.chapters.length}`);
    assert(stress.characters.length === 8, `персонажей ${stress.characters.length}`);
  });
  check('большой проект: валидация без ошибок и предупреждений', () => {
    const issues = model.validateProject(stress);
    assert(issues.length === 0, `проблем ${issues.length}: ${JSON.stringify(issues.slice(0, 3))}`);
  });
  check('большой проект: сорок пять выборов', () => {
    const choices = stress.nodes.reduce((sum, n) => sum + (n.choices || []).length, 0);
    assert(choices === 45, `выборов ${choices}`);
  });
  check('большой проект: автораскладка расставляет все узлы', () => {
    const base = makeStressFixture();
    const out = model.autoLayout(base);
    const positions = out && out.positions ? out.positions : base.positions;
    const known = new Set(base.nodes.map((n) => n.id));
    const placed = Object.keys(positions || {}).filter((id) => known.has(id));
    assert(placed.length === base.nodes.length, `расставлено ${placed.length} из ${base.nodes.length}`);
  });
  check('большой проект: из старта достижимы все узлы', () => {
    const seen = new Set([stress.startNodeId]);
    const queue = [stress.startNodeId];
    const byId = new Map(stress.nodes.map((n) => [n.id, n]));
    while (queue.length) {
      const node = byId.get(queue.shift());
      if (!node) continue;
      const next = [
        node.next,
        ...(node.choices || []).map((c) => c.next),
        ...(node.branches || []).map((b) => b.next),
      ].filter(Boolean);
      for (const id of next) {
        if (!seen.has(id)) {
          seen.add(id);
          queue.push(id);
        }
      }
    }
    // заметки автора намеренно висят отдельно — в графе сюжета они не достижимы
    const playable = stress.nodes.filter((n) => n.type !== 'note').length;
    assert(seen.size === playable, `достижимо ${seen.size} из ${playable}`);
  });
}

if (model) {
  check('countWords: «Это предложение. Ещё одно!» = 4', () => {
    assert(model.countWords('Это предложение. Ещё одно!') === 4, `получено ${model.countWords('Это предложение. Ещё одно!')}`);
  });
  check('countWords: «кто-то пришёл — и всё» = 4 (дефис и тире — не слова)', () => {
    assert(model.countWords('кто-то пришёл — и всё') === 4, `получено ${model.countWords('кто-то пришёл — и всё')}`);
  });
  check('countWords: пустая строка = 0', () => {
    assert(model.countWords('') === 0, `получено ${model.countWords('')}`);
  });
  check('plural: узел / узла / узлов (только форма слова)', () => {
    const f = ['узел', 'узла', 'узлов'];
    assert(model.plural(1, f) === 'узел', model.plural(1, f));
    assert(model.plural(2, f) === 'узла', model.plural(2, f));
    assert(model.plural(5, f) === 'узлов', model.plural(5, f));
    assert(model.plural(21, f) === 'узел', model.plural(21, f));
    assert(model.plural(111, f) === 'узлов', model.plural(111, f));
  });
}

if (model && P) {
  check('validateProject на тестовых данных: 0 ошибок, 0 предупреждений', () => {
    const issues = model.validateProject(P) || [];
    const errs = issues.filter((i) => i.severity === 'error');
    const warns = issues.filter((i) => i.severity === 'warning');
    assert(
      errs.length === 0 && warns.length === 0,
      `ошибок: ${errs.length} [${errs.map((i) => i.code).join(',')}], предупреждений: ${warns.length} [${warns.map((i) => i.code).join(',')}]`
    );
  });
  check('валидация: end без next не даёт dead-end, note не даёт unreachable', () => {
    const issues = model.validateProject(P) || [];
    const typeOf = (id) => (P.nodes.find((n) => n.id === id) || {}).type;
    const bad = issues.filter(
      (i) => (i.code === 'dead-end' && typeOf(i.nodeId) === 'end') || (i.code === 'unreachable' && typeOf(i.nodeId) === 'note')
    );
    assert(!bad.length, `ложные срабатывания: ${bad.map((i) => `${i.code}@${i.nodeId}`).join(', ')}`);
  });

  check('computeStats: слова по спикерам ⊆ общих; главы покрывают все узлы', () => {
    const s = model.computeStats(P);
    const sum = (s.bySpeaker || []).reduce((a, x) => a + (x.words || 0), 0);
    // По спикерам считаются только реплики (line) с speakerId, поэтому сумма ≤ общего числа слов.
    assert(sum <= s.words, `по спикерам ${sum} > всего ${s.words}`);
    const lineWords = P.nodes.filter((n) => n.type === 'line' && n.speakerId).reduce((a, n) => a + model.countWords(n.text), 0);
    assert(sum === lineWords, `по спикерам ${sum} ≠ слов в репликах ${lineWords}`);
    // Главы: сумма слов по главам = общий счётчик (в тестовых данных все узлы распределены по главам).
    const chapterWords = (s.chapters || []).reduce((a, c) => a + (c.words || 0), 0);
    assert(chapterWords === s.words, `по главам ${chapterWords} ≠ всего ${s.words}`);
  });
  check('computeStats: byType в сумме = всего узлов; lines/endings согласованы', () => {
    const s = model.computeStats(P);
    const sum = Object.values(s.byType || {}).reduce((a, b) => a + b, 0);
    assert(sum === s.nodes, `byType ${sum} ≠ nodes ${s.nodes}`);
    assert(s.lines === (s.byType.line || 0), `lines ${s.lines} ≠ byType.line ${s.byType.line}`);
    assert(s.endings === (s.byType.end || 0), `endings ${s.endings} ≠ byType.end ${s.byType.end}`);
  });
  check('computeStats: minutes = ceil(words/150 + 3с на выбор)', () => {
    const s = model.computeStats(P);
    const expect = Math.ceil(s.words / 150 + (s.choices * 3) / 60);
    assert(s.minutes === expect, `minutes ${s.minutes}, ожидалось ${expect} (words=${s.words}, choices=${s.choices})`);
  });

  check('autoLayout: чистая функция — проект не мутирован, позиции для всех узлов', () => {
    const p = clone(P);
    const before = JSON.stringify(p);
    const res = model.autoLayout(p);
    assert(JSON.stringify(p) === before, 'проект изменился после autoLayout');
    const positions = (res && res.positions) || {};
    for (const n of p.nodes) {
      assert(positions[n.id] && typeof positions[n.id].x === 'number', `нет позиции для ${n.id}`);
    }
  });

  // --- Store
  const newStore = () => {
    const st = new model.Store();
    st.setProject(clone(P));
    return st;
  };
  check('Store.apply(createNode): created содержит реальный id нового узла', () => {
    const st = newStore();
    const res = st.apply([{ op: 'createNode', node: { type: 'note', text: 'проверка' } }], { label: 'тест' });
    assert(res && res.ok, `ok=false: ${res && res.error}`);
    const ids = Object.values(res.created || {});
    assert(ids.length === 1, `created = ${JSON.stringify(res.created)}`);
    assert(typeof ids[0] === 'string' && /^n_/.test(ids[0]), `id = ${ids[0]}`);
    assert(st.project.nodes.some((n) => n.id === ids[0]), 'узла нет в проекте');
  });
  check('Store: undo/redo восстанавливают текст узла', () => {
    const st = newStore();
    const node = P.nodes.find((n) => n.type === 'line');
    assert(node, 'в тестовых данных нет line-узла');
    st.apply([{ op: 'updateNode', id: node.id, patch: { text: 'новый текст' } }], { label: 'тест' });
    assert(st.project.nodes.find((n) => n.id === node.id).text === 'новый текст', 'правка не применилась');
    st.undo();
    assert(st.project.nodes.find((n) => n.id === node.id).text === node.text, 'undo не вернул текст');
    st.redo();
    assert(st.project.nodes.find((n) => n.id === node.id).text === 'новый текст', 'redo не повторил правку');
  });
  check('Store: beginGroup/endGroup схлопывают серию правок в одну запись undo', () => {
    const st = newStore();
    const before = JSON.stringify(st.project);
    const nodes = P.nodes.filter((n) => n.type === 'line').slice(0, 3);
    assert(nodes.length >= 2, 'нужно ≥2 line-узлов в тестовых данных');
    st.beginGroup('тест-группа');
    nodes.forEach((n, i) => st.apply([{ op: 'updateNode', id: n.id, patch: { text: `группа ${i}` } }], { label: 'тест' }));
    st.endGroup();
    assert(JSON.stringify(st.project) !== before, 'правки группы не применились');
    st.undo();
    assert(JSON.stringify(st.project) === before, 'undo не вернул проект к состоянию до группы (группировка не работает)');
  });
  check('applyOps: атомарность — при ошибке в серии проект не меняется', () => {
    const p = clone(P);
    const before = JSON.stringify(p);
    const res = model.applyOps(p, [
      { op: 'createNode', node: { type: 'line', text: 'создастся-не-должен' } },
      { op: 'updateNode', id: 'n_такого_нет', patch: { text: 'x' } },
    ]);
    assert(res && res.ok === false, 'ошибочная серия вернула ok');
    assert(JSON.stringify(p) === before, 'проект изменился несмотря на ошибку');
  });
}

// ================================================================ 6. Валидация: 13 классов

if (model && P) {
  console.log('\n=== 6. Валидация: 13 классов (мутация копии) ===');
  const summarize = (issues) =>
    `${(issues || []).length} шт: ${(issues || []).slice(0, 10).map((i) => `${i.code}(${i.severity})`).join(', ')}`;
  const newNode = (p, type, text) => ({
    id: 'n_iso', type, chapterId: (p.nodes[0] || {}).chapterId || '', title: '', speakerId: '',
    locationId: '', text, emotion: '', next: '', choices: [], branches: [], effects: [],
    tags: [], notes: '', color: '', position: { x: 0, y: 0 },
  });

  const MUTATIONS = [
    { code: 'start-missing', sev: 'error', mut: (p) => { p.startNodeId = 'n_нет'; } },
    { code: 'broken-link', sev: 'error', exactly: 1, mut: (p) => { const n = p.nodes.find((x) => x.type === 'line' && x.next); assert(n, 'нет line с next'); n.next = 'n_нет'; } },
    { code: 'empty-text', sev: 'warning', mut: (p) => { const n = p.nodes.find((x) => x.type === 'line'); assert(n, 'нет line'); n.text = ''; } },
    { code: 'choice-empty', sev: 'error', mut: (p) => { const c = p.nodes.find((x) => x.type === 'choice'); assert(c, 'нет choice'); c.choices = []; } },
    { code: 'unreachable', sev: 'warning', mut: (p) => { p.nodes.push(newNode(p, 'line', 'Изолированная реплика')); } },
    { code: 'dead-end', sev: 'error', mut: (p) => { const n = p.nodes.find((x) => x.type === 'line' && x.next); assert(n, 'нет line с next'); n.next = ''; } },
    { code: 'empty-choice', sev: 'warning', mut: (p) => { const c = p.nodes.find((x) => x.type === 'choice'); assert(c && (c.choices || []).length, 'нет choice с вариантами'); c.choices[0].text = ''; } },
    { code: 'duplicate-choice', sev: 'warning', mut: (p) => { const c = p.nodes.find((x) => x.type === 'choice'); assert(c && (c.choices || []).length, 'нет choice с вариантами'); if (c.choices.length >= 2) c.choices[1].text = c.choices[0].text || 'одинаково'; else c.choices.push({ ...clone(c.choices[0]), id: 'o_dup', text: c.choices[0].text || 'одинаково' }); } },
    { code: 'no-speaker', sev: 'warning', mut: (p) => { const n = p.nodes.find((x) => x.type === 'line'); assert(n, 'нет line'); n.speakerId = ''; } },
    { code: 'no-location', sev: 'hint', mut: (p) => { const n = p.nodes.find((x) => x.locationId) || p.nodes.find((x) => x.type === 'scene'); assert(n, 'нет узла с локацией'); n.locationId = ''; } },
    { code: 'unused-character', sev: 'hint', mut: (p) => { p.characters.push({ id: 'c_unused', name: 'Неиспользуемый', color: '#7c9cff', role: '', age: '', description: '', appearance: '', personality: '', speech: '', notes: '', tags: [] }); } },
    { code: 'unused-location', sev: 'hint', mut: (p) => { p.locations.push({ id: 'l_unused', name: 'Неиспользуемая', description: '', atmosphere: '', timeOfDay: '', notes: '', tags: [] }); } },
    { code: 'unused-variable', sev: 'hint', mut: (p) => { p.variables.push({ id: 'v_unused', name: 'zz_unused', type: 'number', initial: 0, description: '' }); } },
    { code: 'bad-effect', sev: 'error', mut: (p) => { const n = p.nodes.find((x) => x.type === 'line'); assert(n, 'нет line'); n.effects = [{ varId: 'v_нет', op: '+=', value: 1 }]; } },
    { code: 'bad-condition', sev: 'error', mut: (p) => { const c = p.nodes.find((x) => x.type === 'condition' && (x.branches || []).length); assert(c, 'нет condition с ветвями'); c.branches[0].condition = 'trust_mark >='; } },
    { code: 'duplicate-variable', sev: 'error', mut: (p) => { assert(p.variables.length, 'нет переменных'); p.variables.push({ id: 'v_dup', name: p.variables[0].name, type: 'number', initial: 0, description: '' }); } },
    { code: 'cycle-no-exit', sev: 'warning', mut: (p) => { const c = p.nodes.find((x) => x.type === 'condition'); assert(c, 'нет condition'); const v = p.variables[0]; c.branches = [{ id: 'b_self', condition: v ? `${v.name} >= 0` : 'true', next: c.id }]; c.next = ''; } },
    { code: 'no-chapter', sev: 'hint', mut: (p) => { const n = p.nodes.find((x) => x.type === 'line'); assert(n, 'нет line'); n.chapterId = ''; } },
  ];

  for (const M of MUTATIONS) {
    check(`валидация: ${M.code} (${M.sev})`, () => {
      const p = clone(P);
      M.mut(p);
      const issues = model.validateProject(p) || [];
      const hit = issues.filter((i) => i.code === M.code);
      if (M.exactly) {
        assert(hit.length === M.exactly, `ожидалось ровно ${M.exactly}, найдено ${hit.length} (nodeId: ${hit.map((i) => i.nodeId).join(',')})`);
      } else {
        assert(hit.length >= 1, `код не найден; отчёт: ${summarize(issues)}`);
      }
      assert(hit.every((i) => i.severity === M.sev), `severity [${hit.map((i) => i.severity).join(',')}] вместо ${M.sev}`);
    });
  }
}

// ================================================================ 7. export.js

console.log('\n=== 7. export.js ===');
let exporter = null;
if (!exists(jsPath('export'))) {
  skip('export.js: импорт и все проверки', 'файл ещё не создан');
} else {
  await checkAsync('export.js: импортируется без DOM', async () => {
    exporter = await import(pathToFileURL(jsPath('export')).href);
  });
}

if (exporter && P) {
  let godot = null;
  check("buildExport('godot'): ровно 3 файла — dialogue.json, dialogue_runner.gd, README.md", () => {
    godot = exporter.buildExport(P, 'godot');
    const names = (godot.files || []).map((f) => f.name).sort().join(',');
    assert((godot.files || []).length === 3, `файлов: ${(godot.files || []).length} (${names})`);
    assert(names === 'README.md,dialogue.json,dialogue_runner.gd', `состав: ${names}`);
  });
  check('godot: dialogue.json парсится; есть start, nodes, characters; все узлы (кроме note) в экспорте', () => {
    const dj = JSON.parse(godot.files.find((f) => f.name === 'dialogue.json').content);
    assert(dj.start, 'нет start');
    assert(dj.nodes && typeof dj.nodes === 'object', 'нет nodes');
    assert(dj.characters, 'нет characters');
    for (const n of P.nodes) {
      if (n.type === 'note') continue;
      assert(dj.nodes[n.id], `узел ${n.id} отсутствует в экспорте`);
    }
  });
  check('godot: dialogue_runner.gd непустой, содержит DialogueRunner; README непустой', () => {
    const gd = godot.files.find((f) => f.name === 'dialogue_runner.gd').content;
    const md = godot.files.find((f) => f.name === 'README.md').content;
    assert(/DialogueRunner/.test(gd), 'в .gd нет класса DialogueRunner');
    assert(gd.length > 200, `.gd подозрительно мал (${gd.length} симв.)`);
    assert(md.length > 50, `README подозрительно мал (${md.length} симв.)`);
  });
  check('godot: битая ссылка не роняет экспорт и помечается ("broken" или warnings)', () => {
    const p = clone(P);
    const n = p.nodes.find((x) => x.type === 'line' && x.next);
    assert(n, 'нет line с next');
    n.next = 'n_нет';
    let built;
    try {
      built = exporter.buildExport(p, 'godot');
    } catch (e) {
      throw new Error(`экспорт упал: ${e.message}`);
    }
    const dj = JSON.parse(built.files.find((f) => f.name === 'dialogue.json').content);
    const marked = Object.values(dj.nodes).some((x) => x && x.broken === true) || (built.warnings || []).length > 0;
    assert(marked, 'битая ссылка не помечена (нет "broken":true, warnings пуст)');
  });
  check("buildExport('renpy'): не падает на кавычках/апострофах, содержит Character(", () => {
    const p = clone(P);
    const n = p.nodes.find((x) => x.type === 'line');
    assert(n, 'нет line');
    n.text = 'Он сказал "привет", а она ответила: \'не сейчас\' — и ушла.';
    const r = exporter.buildExport(p, 'renpy');
    assert((r.files || []).length === 1, `файлов: ${(r.files || []).length}`);
    const text = r.files[0].content;
    assert(/Character\(/.test(text), 'нет Character(');
    assert(text.includes('привет'), 'реплика с кавычками не попала в экспорт');
  });
  check("buildExport('markdown'): 1 файл, кириллица не пустая", () => {
    const r = exporter.buildExport(P, 'markdown');
    assert((r.files || []).length === 1, `файлов: ${(r.files || []).length}`);
    assert(/[А-Яа-яЁё]/.test(r.files[0].content), 'нет кириллицы в выводе');
    assert(r.files[0].content.length > 50, 'вывод почти пуст');
  });
  check("buildExport('json'): 1 файл, парсится, содержит nodes", () => {
    const r = exporter.buildExport(P, 'json');
    assert((r.files || []).length === 1, `файлов: ${(r.files || []).length}`);
    const j = JSON.parse(r.files[0].content);
    assert(Array.isArray(j.nodes), 'нет nodes в дампе');
  });
  check("buildExport('clipboard'): непустой текст без исключения", () => {
    const r = exporter.buildExport(P, 'clipboard');
    assert(r && r.files && r.files.length >= 1 && r.files[0].content.length > 0, 'пустой вывод clipboard');
  });
}

// ================================================================ 8. Фабрики модулей

console.log('\n=== 7б. Студия голоса (полный порт плагина) ===');
{
  const studioPath = path.join(ROOT, 'src', 'js', 'voice-studio.js');
  const studioSrc = exists(studioPath) ? read(studioPath) : '';
  check('Студия голоса: файл модуля на месте', () => assert(studioSrc.length > 1000, 'voice-studio.js пуст или отсутствует'));
  check('Студия голоса: пять вкладок Голос/Сэмпл/EQ/Эффекты/Диалог', () => {
    const paramsSrc = read(path.join(ROOT, 'src', 'js', 'voice', 'params.js'));
    for (const name of ['Голос', 'Сэмпл', 'EQ', 'Эффекты', 'Диалог']) {
      assert(paramsSrc.includes("'" + name + "'") || paramsSrc.includes('"' + name + '"'), 'нет вкладки ' + name);
    }
  });
  check('Студия голоса: режим выделения сэмпла (selection) поддержан', () => {
    const renderSrc = read(path.join(ROOT, 'src', 'js', 'voice', 'render.js'));
    assert(renderSrc.includes("'selection'"), 'нет режима selection в render.js');
    assert(studioSrc.includes('listenSelection'), 'нет прослушивания выделения');
  });
  check('Студия голоса: волна сэмпла и эквалайзер рисуются на canvas', () => {
    assert(studioSrc.includes('studio-wave') && studioSrc.includes('studio-eq'), 'нет canvas-ов студии');
    assert(studioSrc.includes('eqResponseDb'), 'нет кривой АЧХ');
  });
  check('Студия голоса: экспорт 8 вариаций и формат .dvoice', () => {
    assert(studioSrc.includes('Вариации голоса'), 'нет подпапки вариаций');
    assert(studioSrc.includes('storyforge-voice'), 'нет формата .dvoice');
  });
  check('Студия голоса: стили .studio-card и .studio-grid в styles.css', () => {
    const cssSrc = read(path.join(ROOT, 'src', 'styles.css'));
    assert(cssSrc.includes('.studio-card') && cssSrc.includes('.studio-grid'), 'нет стилей студии');
  });
}
console.log('\n=== 10. Изображения узлов ===');
{
  const model = await import(pathToFileURL(jsPath('model')).href);
  check('model.js: экспортирует nodePreviewId/nodeCardHeight/MEDIA_BAND', () => {
    assert(typeof model.nodePreviewId === 'function', 'nodePreviewId отсутствует');
    assert(typeof model.nodeCardHeight === 'function', 'nodeCardHeight отсутствует');
    assert(Number(model.MEDIA_BAND) > 0, 'MEDIA_BAND отсутствует');
  });

  const tiny = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJQBOgCHwAP7+4AAAAA==';
  const project = model.createEmptyProject();
  const created = model.applyOps(project, [{ op: 'createNode', node: { type: 'line', text: 'С фото' } }]);
  assert(created.ok, 'createNode не сработал');
  const nodeId = created.created[0];
  const mediaRes = model.applyOps(project, [
    { op: 'addMedia', media: { name: 'a.webp', mime: 'image/webp', w: 800, h: 600, size: 900, data: tiny } },
  ]);
  check('addMedia: изображение попадает в библиотеку проекта', () => {
    assert(mediaRes.ok, mediaRes.error || 'ошибка');
    assert(Object.keys(project.media).length === 1, 'медиа не добавилось');
  });
  const mediaId = mediaRes.created[0];
  check('setNodeMedia: изображение привязывается и становится превью', () => {
    const res = model.applyOps(project, [{ op: 'setNodeMedia', id: nodeId, media: [mediaId], previewId: mediaId }]);
    assert(res.ok, res.error || 'ошибка');
    const node = project.nodes.find((n) => n.id === nodeId);
    assert(node.media[0] === mediaId, 'media не привязалось');
    assert(model.nodePreviewId(node) === mediaId, 'превью не выставлено');
    assert(model.nodeCardHeight(node) === 90 + model.MEDIA_BAND, 'высота карточки не выросла');
  });
  check('addMedia: мусор вместо картинки отклоняется', () => {
    const bad = model.applyOps(project, [{ op: 'addMedia', media: { data: 'http://x/a.png' } }]);
    assert(bad.ok === false, 'плохие данные приняты');
  });
  check('deleteMedia: чистит ссылки в узлах', () => {
    const res = model.applyOps(project, [{ op: 'deleteMedia', id: mediaId }]);
    assert(res.ok, res.error || 'ошибка');
    const node = project.nodes.find((n) => n.id === nodeId);
    assert(node.media.length === 0, 'ссылка осталась');
    assert(node.previewId === '', 'превью осталось');
    assert(Object.keys(project.media).length === 0, 'библиотека не очищена');
  });
  check('migrateProject: убирает ссылки на отсутствующие изображения', () => {
    const raw = model.createEmptyProject();
    raw.nodes = [{ id: 'n_x', type: 'line', text: 'x', media: ['m_ghost'], previewId: 'm_ghost' }];
    const { project: fixed, warnings } = model.migrateProject(raw);
    const node = fixed.nodes[0];
    assert(node.media.length === 0, 'ссылка на призрак осталась');
    assert(node.previewId === '', 'превью на призрак осталось');
    assert(warnings.length >= 1, 'нет предупреждения о битой ссылке');
  });
  check('autoLayout: карточки с фото не наезжают друг на друга', () => {
    // Три узла: стартовый выбор и две цели в одном столбце — у одной из них фото.
    const p = model.createEmptyProject();
    model.applyOps(p, [
      { op: 'addMedia', media: { name: 'a.webp', mime: 'image/webp', data: tiny } },
      {
        op: 'createNode',
        node: {
          id: 'n_a',
          type: 'choice',
          text: 'выбор',
          choices: [
            { text: 'b', next: 'n_b' },
            { text: 'c', next: 'n_c' },
          ],
        },
      },
      { op: 'createNode', node: { id: 'n_b', type: 'line', text: 'b' } },
      { op: 'createNode', node: { id: 'n_c', type: 'line', text: 'c' } },
    ]);
    model.applyOps(p, [
      { op: 'setNodeMedia', id: 'n_b', media: Object.keys(p.media), previewId: Object.keys(p.media)[0] },
    ]);
    const { positions } = model.autoLayout(p);
    assert(positions.n_b.x === positions.n_c.x, 'цели должны быть в одном столбце');
    assert(positions.n_c.y - positions.n_b.y >= 90 + model.MEDIA_BAND, 'второй узел наезжает на карточку с фото');
  });

  const main = read(path.join(ROOT, 'main.js'));
  const preload = read(path.join(ROOT, 'preload.js'));
  check('IPC: main.js содержит обработчик sf:media:pick', () => {
    assert(main.includes("'sf:media:pick'"), 'канал не найден');
    assert(/IMAGE_MIME/.test(main), 'нет таблицы mime');
  });
  check('IPC: preload.js отдаёт media.pick', () => {
    assert(/media:\s*\{/.test(preload), 'нет объекта media');
    assert(preload.includes("'sf:media:pick'"), 'канал не вызывается');
  });
  check('media.js: экспортирует pickImages/filesToMedia/clipboardImages/prepareImage', async () => {
    const src = read(jsPath('media'));
    for (const fn of ['export async function pickImages', 'export async function filesToMedia', 'export function clipboardImages', 'export async function prepareImage']) {
      assert(src.includes(fn), `нет ${fn}`);
    }
  });
  const css = read(path.join(ROOT, 'src', 'styles.css'));
  check('styles.css: есть стили миниатюр и полосы превью', () => {
    for (const cls of ['.insp-media-grid', '.insp-media', '.media-viewer', '.node-media-band', '.node-card.drop-target']) {
      assert(css.includes(cls), `нет ${cls}`);
    }
  });
  const graphSrc = read(jsPath('graph'));
  check('graph.js: рисует миниатюру и принимает файлы', () => {
    assert(graphSrc.includes('node-media'), 'нет рендера миниатюры');
    assert(graphSrc.includes("addEventListener('drop'"), 'нет обработчика drop');
    assert(graphSrc.includes('nodeCardHeight'), 'высота карточки не учитывается');
  });
  const inspSrc = read(jsPath('inspector'));
  check('inspector.js: блок изображений с превью и удалением', () => {
    assert(inspSrc.includes('data-act="media-add"'), 'нет кнопки добавления');
    assert(inspSrc.includes('data-media-preview'), 'нет кнопки превью');
    assert(inspSrc.includes('data-media-del'), 'нет кнопки удаления');
  });
  const appSrc = read(jsPath('app'));
  check('app.js: ui.attachImages/pickMediaForNode/removeNodeMedia/setNodePreview', () => {
    for (const fn of ['attachImages', 'pickMediaForNode', 'removeNodeMedia', 'setNodePreview']) {
      assert(appSrc.includes(fn), `нет ${fn}`);
    }
    assert(appSrc.includes("addEventListener('paste'"), 'нет вставки из буфера');
  });
}

console.log('\n=== 11. Обзор сюжета (граф в духе Obsidian) ===');
{
  const vizSrc = read(jsPath('visualizer'));
  check('visualizer: экспортирует createVisualizer', () => {
    assert(/export function createVisualizer/.test(vizSrc), 'нет экспорта createVisualizer');
  });
  check('visualizer: рисует на canvas, а не через DOM-точки', () => {
    assert(/createElement\('canvas'\)/.test(vizSrc), 'нет canvas');
    assert(/getContext\('2d'\)/.test(vizSrc), 'нет 2d-контекста');
  });
  check('visualizer: force-directed физика (отталкивание, пружины, тяга)', () => {
    assert(/repulsion/.test(vizSrc), 'нет отталкивания');
    assert(/linkDistance|linkStrength/.test(vizSrc), 'нет пружин связей');
    assert(/gravity/.test(vizSrc), 'нет тяги к центру');
  });
  check('visualizer: фильтры по персонажам, локациям, переменным, главам', () => {
    for (const key of ['characters', 'locations', 'variables', 'chapters']) {
      assert(vizSrc.includes(key), 'нет фильтра ' + key);
    }
  });
  check('visualizer: поиск, «только достижимые», кластеры глав', () => {
    assert(/onlyReachable/.test(vizSrc), 'нет только достижимых');
    assert(/reachableFromStart/.test(vizSrc), 'нет обхода достижимости');
    assert(/hiddenChapters/.test(vizSrc), 'нет скрытия глав');
  });
  check('visualizer: настраиваемые подписи, однотонные точки и прямые связи', () => {
    assert(/labelThreshold/.test(vizSrc), 'нет порога подписей');
    assert(/\.lineTo\(/.test(vizSrc) && !/\.(?:quadraticCurveTo|bezierCurveTo)\(/.test(vizSrc), 'ожидались прямые связи');
    assert(!/createRadialGradient/.test(vizSrc), 'радиальный ореол скрывает цвет точки');
  });
  check('visualizer: клик по точке выбирает узел в редакторе', () => {
    assert(/store\.setSelection|selectNode/.test(vizSrc), 'нет выбора узла из облака');
  });
  check('index.html: слой #vizRoot и кнопка «Обзор» в тулбаре графа', () => {
    const html = read(path.join(ROOT, 'src', 'index.html'));
    assert(/id="vizRoot"/.test(html), 'нет #vizRoot');
    assert(/id="btnViz"/.test(html), 'нет кнопки #btnViz');
  });
  check('app.js: модуль подключён, действие и хоткей Ctrl+Shift+G', () => {
    const appSrc = read(jsPath('app'));
    assert(/createVisualizer/.test(appSrc), 'нет импорта createVisualizer');
    assert(/visualizer = createVisualizer/.test(appSrc), 'нет создания модуля');
    assert(/case 'view:visualizer'/.test(appSrc), 'нет действия view:visualizer');
    assert(/key\.toLowerCase\(\) === 'g'/.test(appSrc), 'нет хоткея на G');
  });
  check('main.js: пункт меню «Обзор сюжета»', () => {
    const mainSrc = read(path.join(ROOT, 'main.js'));
    assert(/view:visualizer/.test(mainSrc), 'меню не отправляет view:visualizer');
  });
  check('styles.css: стили обзора сюжета', () => {
    const css = read(path.join(ROOT, 'src', 'styles.css'));
    for (const cls of ['.viz-root', '.viz-head', '.viz-stage', '.viz-canvas', '.viz-side', '.viz-group']) {
      assert(css.includes(cls), 'нет ' + cls);
    }
  });
}

console.log('\n=== 12. Производительность: LOD графа и тихие правки инспектора ===');
{
  const graphSrc = read(jsPath('graph'));
  const inspSrc = read(jsPath('inspector'));
  const css = read(path.join(ROOT, 'src', 'styles.css'));

  check('граф: текст отсекается по вьюпорту (.is-far) и по зуму (.is-small)', () => {
    assert(/LOD_TEXT_ZOOM/.test(graphSrc), 'нет порога LOD_TEXT_ZOOM');
    assert(/CULL_MARGIN/.test(graphSrc), 'нет запаса отсечения CULL_MARGIN');
    assert(/function updateLod\(/.test(graphSrc), 'нет функции updateLod');
    assert(/classList\.toggle\('is-small'/.test(graphSrc), 'не ставится класс is-small');
    assert(/classList\.add\('is-far'\)/.test(graphSrc), 'не ставится класс is-far');
    assert(/updateLod\(\)/.test(graphSrc.slice(graphSrc.indexOf('function applyTransform'), graphSrc.indexOf('function applyTransform') + 900)), 'applyTransform не пересчитывает отсечение');
  });

  check('styles.css: скрытие текста в графе через display:none', () => {
    assert(/\.graph\.is-small\s+\.node-card\s+text/.test(css), 'нет правила для .is-small text');
    assert(/\.graph\s+\.node-card\.is-far\s+text/.test(css), 'нет правила для .is-far text');
    const rule = css.slice(css.indexOf('.graph.is-small .node-card text'));
    assert(/display:\s*none/.test(rule.slice(0, 400)), 'у правил нет display: none');
  });

  check('граф: точечная перерисовка карточек вместо полной сборки svg', () => {
    for (const name of ['patchGraph', 'renderNodeInner', 'nodeSig', 'edgesSignature', 'posSig']) {
      assert(new RegExp(`function ${name}\\(`).test(graphSrc), `нет функции ${name}`);
    }
    assert(/cardSig/.test(graphSrc) && /cardPos/.test(graphSrc), 'нет карт подписей cardSig/cardPos');
    assert(/el\.innerHTML\s*=\s*renderNodeInner/.test(graphSrc), 'patchGraph не обновляет содержимое карточки');
    const idx = graphSrc.slice(graphSrc.indexOf('function indexElements'), graphSrc.indexOf('function indexElements') + 800);
    assert(/querySelectorAll\('\.edges \[data-edge\]'\)/.test(idx), 'indexElements не перебирает рёбра одним запросом');
  });

  check('инспектор: правки в полях не пересобирают панель (тихий режим)', () => {
    assert(/QUIET_PROPS/.test(inspSrc), 'нет списка тихих свойств');
    assert(/refresh\s*=\s*true/.test(inspSrc), 'у apply нет флага refresh');
    assert(/\{\s*refresh:\s*!quiet\s*\}/.test(inspSrc), 'тихий режим не передаётся в apply');
    assert(/updateWordCounter/.test(inspSrc), 'нет пересчёта счётчика без чтения лэйаута');
    assert(!/\.scrollHeight/.test(inspSrc), 'осталось чтение scrollHeight (принудительный лэйаут)');
  });

  check('styles.css: высоту текстового поля считает CSS (field-sizing)', () => {
    assert(/field-sizing:\s*content/.test(css), 'нет field-sizing: content у .textarea[data-autosize]');
  });

  check('tools: пробники производительности на месте', () => {
    for (const f of ['_probe-perf20.mjs', '_probe-perf27.mjs', '_probe-perf28.mjs', '_probe-perf30.mjs', '_probe-perf32.mjs']) {
      assert(exists(path.join(ROOT, 'tools', f)), `нет ${f}`);
    }
  });
}

console.log('\n=== 8. Фабрики модулей (graph/inspector/panels/ai/voice) ===');
const FACTORIES = [
  ['graph', 'createGraph'],
  ['inspector', 'createInspector'],
  ['panels', 'createPanels'],
  ['ai', 'createAI'],
  ['voice', 'createVoice'],
  ['voice-studio', 'createVoiceStudio'],
];
for (const [m, fn] of FACTORIES) {
  if (!exists(jsPath(m))) {
    skip(`${m}.js: фабрика ${fn}`, 'файл ещё не создан');
    continue;
  }
  // Зависимости модуля (напр. './model.js') могут быть ещё не написаны — это SKIP,
  // а не FAIL: частично собранный проект не должен ронять приёмку.
  let depMissing = null;
  try {
    await import(pathToFileURL(jsPath(m)).href);
  } catch (e) {
    if (/Cannot find module/.test(String(e && e.message))) depMissing = e;
  }
  if (depMissing) {
    skip(`${m}.js: фабрика ${fn}`, `импорт падает на ещё не созданной зависимости: ${depMissing.message.split('\n')[0]}`);
    continue;
  }
  await checkAsync(`${m}.js: экспортирует фабрику ${fn} (функция, ≤1 аргумента)`, async () => {
    const mod = await import(pathToFileURL(jsPath(m)).href);
    const f = mod[fn];
    assert(typeof f === 'function', `экспорт ${fn} отсутствует или не функция (${typeof f})`);
    assert(f.length <= 1, `у фабрики ${fn} аргументов: ${f.length}`);
  });
}

// ================================================================ 9. Озвучка

console.log('\n=== 9. Озвучка диалогов (порт Dialogue Voice Studio) ===');
{
  const model = await import(pathToFileURL(jsPath('model')).href);
  const voiceDir = path.join(ROOT, 'src', 'js', 'voice');
  const paramsMod = exists(path.join(voiceDir, 'params.js')) ? await import(pathToFileURL(path.join(voiceDir, 'params.js')).href) : null;
  const renderMod = exists(path.join(voiceDir, 'render.js')) ? await import(pathToFileURL(path.join(voiceDir, 'render.js')).href) : null;
  const wavMod = exists(path.join(voiceDir, 'wav.js')) ? await import(pathToFileURL(path.join(voiceDir, 'wav.js')).href) : null;

  check('model: у нового проекта есть голос по умолчанию', () => {
    const p = model.createEmptyProject();
    assert(p.voice && typeof p.voice.preset === 'number', 'нет поля voice');
    assert(p.voice.preset === 0, `preset = ${p.voice.preset}`);
  });

  check('model: setVoice меняет голос проекта', () => {
    const p = model.createEmptyProject();
    const res = model.applyOps(p, [{ op: 'setVoice', voice: { preset: 2, params: { pitch: 4 } } }]);
    assert(res.ok, res.error || 'операция не прошла');
    assert(p.voice.preset === 2, `preset = ${p.voice.preset}`);
    assert(Number(p.voice.params.pitch) === 4, 'параметр pitch не сохранился');
  });

  check('model: голос персонажа и наследование (null)', () => {
    const p = model.createEmptyProject();
    model.applyOps(p, [{ op: 'createCharacter', character: { name: 'Аня' } }]);
    const id = p.characters[0].id;
    assert(p.characters[0].voice === null, 'по умолчанию голос должен быть null');
    model.applyOps(p, [{ op: 'setVoice', id, voice: { preset: 1 } }]);
    assert(p.characters[0].voice.preset === 1, 'голос персонажа не задался');
    model.applyOps(p, [{ op: 'updateCharacter', id, patch: { voice: null } }]);
    assert(p.characters[0].voice === null, 'сброс голоса не сработал');
  });

  check('model: migrateProject сохраняет голоса', () => {
    const p = model.createEmptyProject();
    model.applyOps(p, [{ op: 'setVoice', voice: { preset: 3 } }]);
    model.applyOps(p, [{ op: 'createCharacter', character: { name: 'Марк', voice: { preset: 1 } } }]);
    const round = model.migrateProject(JSON.parse(JSON.stringify(p)));
    assert(round.project.voice.preset === 3, 'голос проекта потерян');
    assert(round.project.characters[0].voice.preset === 1, 'голос персонажа потерян');
  });

  if (!paramsMod) {
    skip('voice/params.js: характеристики и параметры', 'файл ещё не создан');
  } else {
    check('voice/params.js: 4 заводских характера и ≥60 параметров', () => {
      assert(paramsMod.FACTORY_VOICES.length === 4, `характеров: ${paramsMod.FACTORY_VOICES.length}`);
      assert(paramsMod.SPECS.length >= 60, `параметров: ${paramsMod.SPECS.length}`);
    });
    check('voice/params.js: resolveParams даёт полный набор и учитывает пресет', () => {
      const base = paramsMod.resolveParams(null);
      const low = paramsMod.resolveParams({ preset: 1 });
      assert(typeof base.pitch === 'number', 'нет pitch');
      assert(low.pitch === -12, `у «Низкого» pitch = ${low.pitch}`);
    });
    check('voice/params.js: diffFromPreset не хранит лишнего', () => {
      const own = paramsMod.resolveParams({ preset: 1 });
      const diff = paramsMod.diffFromPreset(own, 1);
      assert(Object.keys(diff).length === 0, `лишние отличия: ${Object.keys(diff).join(', ')}`);
    });
  }

  if (!renderMod) {
    skip('voice/render.js: рендер реплики', 'файл ещё не создан');
  } else {
    check('voice/render.js: реплика рендерится в звук', () => {
      const r = renderMod.renderLine({ params: paramsMod.resolveParams(null), text: 'Привет, мир!', seed: 7, mode: 'line' });
      assert(r.left.length > 1000, `сэмплов: ${r.left.length}`);
      assert(r.left.length === r.right.length, 'каналы разной длины');
      assert(renderMod.peakOf(r) > 0.02, 'тишина вместо звука');
      assert(r.seconds > 0.2 && r.seconds < 15, `длительность: ${r.seconds.toFixed(2)} с`);
    });
    check('voice/render.js: один seed → одинаковый результат', () => {
      const a = renderMod.renderLine({ params: paramsMod.resolveParams(null), text: 'Проверка', seed: 3, mode: 'line' });
      const b = renderMod.renderLine({ params: paramsMod.resolveParams(null), text: 'Проверка', seed: 3, mode: 'line' });
      assert(renderMod.peakOf(a) === renderMod.peakOf(b), 'рендер недетерминирован');
    });
    check('voice/render.js: длинный текст даёт более длинную реплику', () => {
      const short = renderMod.renderLine({ params: paramsMod.resolveParams(null), text: 'Да.', seed: 1, mode: 'line' });
      const long = renderMod.renderLine({ params: paramsMod.resolveParams(null), text: 'Она вошла в комнату и долго молчала, глядя в окно...', seed: 1, mode: 'line' });
      assert(long.seconds > short.seconds, `${long.seconds} против ${short.seconds}`);
    });
  }

  if (!wavMod) {
    skip('voice/wav.js: WAV-кодек', 'файл ещё не создан');
  } else {
    check('voice/wav.js: WAV-круговорот сохраняет длину и амплитуду', () => {
      const r = renderMod.renderLine({ params: paramsMod.resolveParams(null), text: 'Круговорот', seed: 5, mode: 'line' });
      const bytes = wavMod.encodeWav([r.left, r.right], r.rate);
      const back = wavMod.decodeWav(bytes);
      assert(back.frames === r.left.length, `кадров ${back.frames} вместо ${r.left.length}`);
      assert(back.rate === r.rate, `частота ${back.rate}`);
      assert(Math.abs(back.peak - renderMod.peakOf(r)) < 0.02, 'амплитуда изменилась');
    });
  }

  check('ai.js: есть инструменты get_voice и set_voice', () => {
    const src = read(jsPath('ai'));
    assert(/tool\('get_voice'/.test(src), 'нет get_voice');
    assert(/tool\(\s*'set_voice'/.test(src), 'нет set_voice');
  });

  check('index.html: вкладка «Озвучка» на месте', () => {
    assert(/data-tab="voice"/.test(read(htmlPath)), 'нет кнопки вкладки voice');
  });

  check('preload ↔ main: каналы sf:voice:* совпадают', () => {
    const pre = read(path.join(ROOT, 'preload.js'));
    const mainSrc = read(path.join(ROOT, 'main.js'));
    const channels = [...pre.matchAll(/invoke\('(sf:voice:[^']+)'/g)].map((m) => m[1]);
    assert(channels.length >= 3, `каналов в preload: ${channels.length}`);
    for (const ch of channels) {
      assert(mainSrc.includes(`ipcMain.handle('${ch}'`), `в main.js нет обработчика ${ch}`);
    }
  });

  check('у тестовых персонажей заданы голоса', () => {
    const withVoice = (sample.characters || []).filter((c) => c.voice && typeof c.voice.preset === 'number');
    assert(withVoice.length >= 2, `с голосом: ${withVoice.length}`);
  });

  check('styles.css: стили панели озвучки добавлены', () => {
    const css = read(path.join(ROOT, 'src', 'styles.css'));
    assert(/\.voice-panel/.test(css), 'нет .voice-panel');
    assert(/\.voice-grid/.test(css), 'нет .voice-grid');
  });
}

// ================================================================ итог

console.log('\n' + '='.repeat(62));
const pass = results.filter((r) => r.status === 'PASS').length;
const sk = results.filter((r) => r.status === 'SKIP').length;
console.log(`ИТОГ: ${pass} PASS / ${fails} FAIL / ${sk} SKIP`);
if (fails) {
  console.log('Проваленные пункты:');
  for (const r of results.filter((x) => x.status === 'FAIL')) {
    console.log(`  ✘ ${r.name}\n     ${r.detail}`);
  }
  process.exitCode = 1;
} else {
  console.log('Провалов нет.');
}
