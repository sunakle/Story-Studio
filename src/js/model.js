import { t as uiText, getLanguage } from './i18n.js';
// ============================================================================
// model.js — ядро модели данных StoryForge.
//
// Здесь живёт всё, что не зависит от интерфейса:
//   • схема проекта, дефолты и миграция загружаемых файлов;
//   • applyOps — единственный путь мутации проекта (атомарные операции);
//   • Store — текущее состояние, undo/redo, группы правок, подписчики;
//   • валидация (13 классов проблем), статистика, автораскладка;
//   • разбор условий (parseCondition), поиск путей, поддеревья, рёбра.
//
// Модуль — чистый ES-модуль без зависимостей и без DOM: он одинаково
// импортируется рендерером Electron и Node (самотест tools/_selftest-model.mjs).
// ============================================================================

// Отладочный вывод разрешён только при включённом флаге разработки.
const devLog = (...args) => { if (globalThis.__SF_DEV__) console.log(...args); };

export const NODE_TYPES = ['line', 'choice', 'condition', 'jump', 'scene', 'end', 'note'];

export const TYPE_LABELS = {
  get line() { return uiText("Реплика", "Line"); },
  get choice() { return uiText("Выбор", "Choice"); },
  get condition() { return uiText("Условие", "Condition"); },
  get jump() { return uiText("Переход", "Jump"); },
  get scene() { return uiText("Сцена", "Scene"); },
  get end() { return uiText("Конец", "Ending"); },
  get note() { return uiText("Заметка", "Note"); },
};

export const OP_LABELS = { set: '=', '+=': '+=', '-=': '-=', get toggle() { return uiText("переключить", "toggle"); } };

const SCHEMA_VERSION = 1;
const HISTORY_LIMIT = 100;     // максимум записей undo
const GROUP_WINDOW_MS = 800;   // окно склейки правок одной группы
const CARD_HEIGHT = 90;        // высота карточки узла в графе (совпадает с graph.js)
const LAYOUT_STEP_X = 300;     // шаг сетки автораскладки по горизонтали
const LAYOUT_STEP_Y = 140;     // ...и по вертикали

const VARIABLE_TYPES = ['number', 'bool', 'string'];
const SEVERITY_RANK = { error: 0, warning: 1, hint: 2 };

// ---------------------------------------------------------------------------
// Базовые утилиты
// ---------------------------------------------------------------------------

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function asString(v, fallback = '') { return typeof v === 'string' ? v : fallback; }
function asArray(v) { return Array.isArray(v) ? v : []; }
function asNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function deepClone(value) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch (e) { /* неклонируемые значения уйдут в JSON-путь */ }
  }
  return JSON.parse(JSON.stringify(value));
}

function nowISO() { return new Date().toISOString(); }

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function uid(prefix = 'n_') {
  let s = '';
  for (let i = 0; i < 6; i++) s += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return prefix + s;
}

// Правильные русские склонения: 1 узел / 2 узла / 5 узлов / 11 узлов / 21 узел.
export function plural(n, forms) {
  const count = Math.abs(Math.trunc(Number(n) || 0));
  if (getLanguage() === 'en') return count === 1 ? forms[0] : forms[2];
  const mod10 = count % 10;
  const mod100 = count % 100;
  let form;
  if (mod10 === 1 && mod100 !== 11) form = forms[0];
  else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) form = forms[1];
  else form = forms[2];
  // Возвращается ТОЛЬКО форма слова: вызывающий код сам подставляет число
  // (`${n} ${plural(n, forms)}`). Контракт §3, строка про plural.
  return form;
}

// Слова в тексте: буквы и числа (числа считаются словами), пустая строка — 0.
export function countWords(text) {
  if (typeof text !== 'string' || !text) return 0;
  // дефисные слова («кто-то», «что-нибудь») считаются одним словом
  const matches = text.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu);
  return matches ? matches.length : 0;
}

// ---------------------------------------------------------------------------
// Дефолты сущностей и миграция
// ---------------------------------------------------------------------------

function normalizeChoices(raw, created = {}) {
  return asArray(raw).filter(isObj).map((c) => ({
    id: asString(c.id) || uid('o_'),
    text: asString(c.text),
    next: asString(resolveLink(c.next, created)),
    condition: asString(c.condition),
    effects: normalizeEffects(c.effects),
    hint: asString(c.hint),
  }));
}

function normalizeBranches(raw, created = {}) {
  return asArray(raw).filter(isObj).map((b) => ({
    id: asString(b.id) || uid('b_'),
    condition: asString(b.condition),
    next: asString(resolveLink(b.next, created)),
  }));
}

function normalizeEffects(raw) {
  return asArray(raw).filter(isObj).map((e) => ({
    varId: asString(e.varId),
    op: asString(e.op),
    value: e.value === undefined ? 0 : e.value,
  }));
}

function normalizeMediaList(raw) {
  return asArray(raw).filter((id) => typeof id === 'string' && id);
}

// Библиотека изображений проекта: { id: {id, name, mime, w, h, size, data} }.
// data — data-URL (data:image/…), поэтому .sfproj остаётся самодостаточным файлом.
function normalizeMediaStore(raw) {
  const store = {};
  if (!isObj(raw)) return store;
  for (const [key, value] of Object.entries(raw)) {
    if (!isObj(value)) continue;
    const data = asString(value.data);
    if (!data.startsWith('data:image/')) continue;
    const id = asString(value.id) || key;
    if (!id) continue;
    store[id] = {
      id,
      name: asString(value.name, 'image'),
      mime: asString(value.mime, 'image/webp'),
      w: Math.max(0, Math.round(asNumber(value.w))),
      h: Math.max(0, Math.round(asNumber(value.h))),
      size: Math.max(0, Math.round(asNumber(value.size))),
      data,
    };
  }
  return store;
}

// Дополнительная высота карточки узла с превью (полоса изображения внизу).
export const MEDIA_BAND = 74;

// Превью узла: previewId, если он реально привязан, иначе первое изображение.
export function nodePreviewId(node) {
  if (!node) return '';
  const list = normalizeMediaList(node.media);
  const wanted = asString(node.previewId);
  if (wanted && list.includes(wanted)) return wanted;
  return list[0] || '';
}

// Высота карточки узла в графе — общая точка правды для graph.js и autoLayout.
export function nodeCardHeight(node) {
  return nodePreviewId(node) ? CARD_HEIGHT + MEDIA_BAND : CARD_HEIGHT;
}

function defaultNode(raw = {}, created = {}) {
  const type = NODE_TYPES.includes(raw.type) ? raw.type : 'note';
  return {
    id: asString(raw.id),
    type,
    chapterId: asString(raw.chapterId),
    title: asString(raw.title),
    speakerId: asString(raw.speakerId),
    ...(raw.voice && { voice: normalizeVoice(raw.voice) }),
    ...(Number.isInteger(raw.voiceSeed) && { voiceSeed: raw.voiceSeed >>> 0 }),
    locationId: asString(raw.locationId),
    text: asString(raw.text),
    emotion: asString(raw.emotion),
    next: asString(resolveLink(raw.next, created)),
    choices: normalizeChoices(raw.choices, created),
    branches: normalizeBranches(raw.branches, created),
    effects: normalizeEffects(raw.effects),
    tags: asArray(raw.tags).filter((t) => typeof t === 'string'),
    notes: asString(raw.notes),
    color: asString(raw.color),
    media: normalizeMediaList(raw.media),
    previewId: asString(raw.previewId),
    position: {
      x: asNumber(raw.position && raw.position.x),
      y: asNumber(raw.position && raw.position.y),
    },
  };
}

/**
 * Голос озвучки: {preset, params}. null — «как в проекте».
 * preset — индекс заводского характера, params — отличия от него.
 */
function normalizeVoice(raw) {
  if (!isObj(raw)) return null;
  const preset = Math.max(0, Math.min(3, Math.round(asNumber(raw.preset, 0))));
  const params = {};
  if (isObj(raw.params)) {
    for (const [key, value] of Object.entries(raw.params)) {
      const num = Number(value);
      if (Number.isFinite(num)) params[key] = Math.round(num * 100) / 100;
    }
  }
  const voice = { preset, params };
  if (typeof raw.sample?.data === 'string' && raw.sample.data.length) {
    voice.sample = { name: asString(raw.sample.name) || 'sample.wav', data: raw.sample.data };
  }
  if (Number.isInteger(raw.seed)) voice.seed = raw.seed >>> 0;
  if (isObj(raw.output)) {
    voice.output = {
      rate: raw.output.rate === 44100 ? 44100 : 48000,
      channels: raw.output.channels === 1 ? 1 : 2,
      bits: raw.output.bits === 16 ? 16 : 24,
    };
  }
  return voice;
}

function defaultCharacter(raw = {}) {
  return {
    id: asString(raw.id),
    name: asString(raw.name),
    color: asString(raw.color, '#7c9cff') || '#7c9cff',
    role: asString(raw.role),
    age: asString(raw.age),
    description: asString(raw.description),
    appearance: asString(raw.appearance),
    personality: asString(raw.personality),
    speech: asString(raw.speech),
    notes: asString(raw.notes),
    tags: asArray(raw.tags).filter((t) => typeof t === 'string'),
    voice: normalizeVoice(raw.voice),
  };
}

function defaultLocation(raw = {}) {
  return {
    id: asString(raw.id),
    name: asString(raw.name),
    description: asString(raw.description),
    atmosphere: asString(raw.atmosphere),
    timeOfDay: asString(raw.timeOfDay),
    notes: asString(raw.notes),
    tags: asArray(raw.tags).filter((t) => typeof t === 'string'),
  };
}

function defaultVariable(raw = {}) {
  const type = VARIABLE_TYPES.includes(raw.type) ? raw.type : 'string';
  const hasInitial = raw.initial !== undefined && raw.initial !== null;
  const initial = hasInitial ? raw.initial : (type === 'number' ? 0 : type === 'bool' ? false : '');
  return {
    id: asString(raw.id),
    name: asString(raw.name),
    type,
    initial,
    description: asString(raw.description),
  };
}

function defaultChapter(raw = {}) {
  return {
    id: asString(raw.id),
    name: asString(raw.name),
    color: asString(raw.color, '#7c9cff') || '#7c9cff',
    collapsed: raw.collapsed === true,
  };
}

// Пустой, но полностью валидный проект: одна глава, ни одного узла.
// overrides — глубокое наложение значений сверху (используется тестами и app.js).
export function createEmptyProject(overrides) {
  const now = nowISO();
  const project = {
    schemaVersion: SCHEMA_VERSION,
    meta: { title: uiText('Новый проект', 'New project'), author: '', description: '', createdAt: now, updatedAt: now },
    startNodeId: '',
    characters: [],
    locations: [],
    variables: [],
    chapters: [{ id: 'ch_main', name: uiText('Глава 1', 'Chapter 1'), color: '#7c9cff', collapsed: false }],
    nodes: [],
    media: {},
    voice: { preset: 0, params: {} },
  };
  if (isObj(overrides)) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) continue;
      if (key === 'meta' && isObj(value)) Object.assign(project.meta, deepClone(value));
      else project[key] = deepClone(value);
    }
  }
  return project;
}

// Мягкая миграция загруженного JSON: заполняет недостающие поля, чинит типы,
// ничего не удаляя содержательного. Предполагается вызов после успешного JSON.parse.
export function migrateProject(raw) {
  const warnings = [];
  if (!isObj(raw)) {
    return { project: createEmptyProject(), warnings: [uiText('Данные проекта не являются объектом — создан пустой проект.', 'Invalid project data. An empty project was created.')] };
  }

  const meta = isObj(raw.meta) ? raw.meta : {};
  const project = {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      title: asString(meta.title),
      author: asString(meta.author),
      description: asString(meta.description),
      createdAt: asString(meta.createdAt) || nowISO(),
      updatedAt: asString(meta.updatedAt) || nowISO(),
    },
    startNodeId: asString(raw.startNodeId),
    characters: [],
    locations: [],
    variables: [],
    chapters: [],
    nodes: [],
    media: normalizeMediaStore(raw.media),
    voice: normalizeVoice(raw.voice) || { preset: 0, params: {} },
  };

  if (raw.schemaVersion !== undefined) {
    const v = asNumber(raw.schemaVersion, 1);
    if (v > SCHEMA_VERSION) {
      warnings.push(`${uiText("Версия схемы", "Schema version")} ${v} ${uiText("новее поддерживаемой", "is newer than the supported version")} (${SCHEMA_VERSION}) — ${uiText("файл создан в более новой версии", "file created by a newer version")} StoryForge.`);
    }
  }

  for (const item of asArray(raw.characters)) {
    if (!isObj(item)) { warnings.push(uiText("Пропущен повреждённый элемент списка персонажей.", "Skipped a damaged character entry.")); continue; }
    const ch = defaultCharacter(item);
    if (!ch.id) ch.id = uid('c_');
    project.characters.push(ch);
  }

  for (const item of asArray(raw.locations)) {
    if (!isObj(item)) { warnings.push(uiText("Пропущен повреждённый элемент списка локаций.", "Skipped a damaged location entry.")); continue; }
    const loc = defaultLocation(item);
    if (!loc.id) loc.id = uid('l_');
    project.locations.push(loc);
  }

  for (const item of asArray(raw.variables)) {
    if (!isObj(item)) { warnings.push(uiText("Пропущен повреждённый элемент списка переменных.", "Skipped a damaged variable entry.")); continue; }
    if (item.type !== undefined && !VARIABLE_TYPES.includes(item.type)) {
      warnings.push(`${uiText("Неизвестный тип переменной", "Unknown variable type")} «${item.type}» — ${uiText("переменная", "variable")} «${asString(item.name, item.id)}» ${uiText("считается строкой", "treated as a string")}.`);
    }
    const v = defaultVariable(item);
    if (!v.id) v.id = uid('v_');
    project.variables.push(v);
  }

  for (const item of asArray(raw.chapters)) {
    if (!isObj(item)) { warnings.push(uiText("Пропущен повреждённый элемент списка глав.", "Skipped a damaged chapter entry.")); continue; }
    const ch = defaultChapter(item);
    if (!ch.id) ch.id = uid('ch_');
    project.chapters.push(ch);
  }

  if (raw.nodes !== undefined && !Array.isArray(raw.nodes)) {
    warnings.push(uiText("Список узлов повреждён (не массив) — узлы сброшены.", "Invalid node list (expected an array). Nodes were reset."));
  }
  const seenIds = new Set();
  asArray(raw.nodes).forEach((item, index) => {
    if (!isObj(item)) { warnings.push(`${uiText("Пропущен повреждённый узел", "Skipped a damaged node")} №${index + 1}.`); return; }
    if (item.type !== undefined && !NODE_TYPES.includes(item.type)) {
      warnings.push(`${uiText("Неизвестный тип узла", "Unknown node type")} «${item.type}» (№${index + 1}) — ${uiText("узел сохранён как заметка", "node preserved as a note")}.`);
    }
    const node = defaultNode(item);
    if (!node.id) {
      node.id = uid('n_');
      warnings.push(`${uiText("Узлу", "Node")} №${index + 1} («${node.title || node.text.slice(0, 30)}») ${uiText("присвоен новый", "assigned a new")} id «${node.id}».`);
    }
    if (seenIds.has(node.id)) {
      warnings.push(`${uiText("Дубликат узла с", "Duplicate node with")} id «${node.id}» ${uiText("пропущен", "skipped")}.`);
      return;
    }
    seenIds.add(node.id);
    project.nodes.push(node);
  });

  for (const node of project.nodes) {
    const keep = node.media.filter((id) => project.media[id]);
    if (keep.length !== node.media.length) {
      warnings.push(`${uiText("Узел", "Node")} «${node.id}» ${uiText("ссылался на отсутствующие изображения — ссылки убраны", "referenced missing images; links removed")}.`);
    }
    node.media = keep;
    if (!keep.includes(node.previewId)) node.previewId = keep[0] || '';
  }

  return { project, warnings };
}

// ---------------------------------------------------------------------------
// Поиск по проекту
// ---------------------------------------------------------------------------

function findNode(project, id) {
  return asArray(project && project.nodes).find((n) => n && n.id === id) || null;
}

function requireNode(project, id) {
  const node = findNode(project, id);
  if (!node) throw new Error(`${uiText("Узел", "Node")} «${id || '—'}» ${uiText("не найден", "not found")}.`);
  return node;
}

function indexNodes(project) {
  const map = new Map();
  for (const n of asArray(project && project.nodes)) {
    if (n && n.id && !map.has(n.id)) map.set(n.id, n);
  }
  return map;
}

function findEntity(list, id) {
  return asArray(list).find((e) => e && e.id === id) || null;
}

function requireEntity(list, id, what) {
  const entity = findEntity(list, id);
  if (!entity) throw new Error(`${what} «${id || '—'}» ${uiText("не найден", "not found")}.`);
  return entity;
}

// Собирает все id проекта (узлы, варианты, ветки, персонажи, локации, переменные, главы).
function collectIds(project) {
  const ids = new Set();
  for (const n of asArray(project.nodes)) {
    if (!n || !n.id) continue;
    ids.add(n.id);
    for (const c of asArray(n.choices)) if (c && c.id) ids.add(c.id);
    for (const b of asArray(n.branches)) if (b && b.id) ids.add(b.id);
  }
  for (const key of ['characters', 'locations', 'variables', 'chapters']) {
    for (const e of asArray(project[key])) if (e && e.id) ids.add(e.id);
  }
  if (isObj(project.media)) {
    for (const [key, value] of Object.entries(project.media)) {
      ids.add(key);
      if (value && value.id) ids.add(value.id);
    }
  }
  return ids;
}

function uniqueId(project, prefix) {
  const ids = collectIds(project);
  let id = uid(prefix);
  let guard = 0;
  while (ids.has(id) && guard++ < 200) id = uid(prefix);
  return id;
}

export function nodeSpeakerName(project, node) {
  if (!node) return '';
  const ch = findEntity(project && project.characters, asString(node.speakerId));
  return ch ? asString(ch.name) : '';
}

export function nodeLocationName(project, node) {
  if (!node) return '';
  const loc = findEntity(project && project.locations, asString(node.locationId));
  return loc ? asString(loc.name) : '';
}

// ---------------------------------------------------------------------------
// Рёбра графа (связи выводятся из next / choices[].next / branches[].next)
// ---------------------------------------------------------------------------

// kind: 'next' | 'choice' | 'branch' | 'else' (else — ветка «иначе» условия).
export function outgoingEdges(project, nodeId) {
  return edgesOfNode(findNode(project, nodeId));
}

function edgesOfNode(node) {
  if (!node) return [];
  const edges = [];
  const next = asString(node.next);
  if (next) edges.push({ to: next, kind: node.type === 'condition' ? 'else' : 'next' });
  asArray(node.choices).forEach((c) => {
    if (c && asString(c.next)) edges.push({ to: c.next, kind: 'choice', choiceId: c.id, label: asString(c.text) });
  });
  asArray(node.branches).forEach((b, i) => {
    if (b && asString(b.next)) edges.push({ to: b.next, kind: 'branch', branchIndex: i, label: asString(b.condition) });
  });
  return edges;
}

export function incomingEdges(project, nodeId) {
  const edges = [];
  for (const node of asArray(project && project.nodes)) {
    if (!node || !node.id) continue;
    for (const e of edgesOfNode(node)) {
      if (e.to === nodeId) edges.push({ from: node.id, kind: e.kind, choiceId: e.choiceId, branchIndex: e.branchIndex, label: e.label });
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Разбор условий: рекурсивный парсер выражений
// ---------------------------------------------------------------------------

function condError(message) { return new Error(message); }

function conditionTokens(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9]/.test(ch)) {
      let j = i;
      let dots = 0;
      while (j < src.length && /[0-9.]/.test(src[j])) {
        if (src[j] === '.') dots++;
        if (dots > 1) throw condError(`${uiText("Лишняя точка в числе на позиции", "Extra decimal point at position")} ${j + 1}`);
        j++;
      }
      if (src[j - 1] === '.') throw condError(`${uiText("Число не может заканчиваться точкой (позиция", "A number cannot end in a decimal point (position")} ${j})`);
      tokens.push({ type: 'number', value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) j++;
      if (j >= src.length) throw condError(`${uiText("Не закрыта строка, начавшаяся на позиции", "Unclosed string starting at position")} ${i + 1}`);
      tokens.push({ type: 'string', value: src.slice(i + 1, j), pos: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ type: 'ident', value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(two)) {
      tokens.push({ type: 'op', value: two, pos: i });
      i += 2;
      continue;
    }
    if (ch === '>' || ch === '<' || ch === '!') {
      tokens.push({ type: 'op', value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === '(' || ch === ')') { tokens.push({ type: ch, pos: i }); i++; continue; }
    if (ch === '=') throw condError(`${uiText("Одиночный «=» на позиции", "Single equals sign at position")} ${i + 1} — ${uiText("для сравнения используйте", "for comparison use")} «==»`);
    if (ch === '&') throw condError(`${uiText("Одиночный", "Single")} «&» ${uiText("на позиции", "at position")} ${i + 1} — ${uiText("используйте", "use")} «&&»`);
    if (ch === '|') throw condError(`${uiText("Одиночный", "Single")} «|» ${uiText("на позиции", "at position")} ${i + 1} — ${uiText("используйте", "use")} «||»`);
    throw condError(`${uiText("Неизвестный символ", "Unknown character")} «${ch}» ${uiText("на позиции", "at position")} ${i + 1}`);
  }
  return tokens;
}

// Синтаксический разбор без вычисления: грамматика
//   expr := or;  or := and ('||' and)*;  and := cmp ('&&' cmp)*;
//   cmp := unary (('=='|'!='|'>='|'<='|'>'|'<') unary)?;
//   unary := '!' unary | primary;
//   primary := число | строка | true | false | имя | '(' expr ')'
function parseConditionTokens(src, variables = null) {
  const tokens = conditionTokens(src);
  const names = new Set();
  let cursor = 0;
  const peek = () => tokens[cursor];
  const accept = (op) => {
    if (peek()?.type !== 'op' || peek().value !== op) return false;
    cursor++;
    return true;
  };
  function parseOr() {
    let value = parseAnd();
    while (accept('||')) { const right = parseAnd(); value = Boolean(value || right); }
    return value;
  }
  function parseAnd() {
    let value = parseCmp();
    while (accept('&&')) { const right = parseCmp(); value = Boolean(value && right); }
    return value;
  }
  function parseCmp() {
    const left = parseUnary();
    const op = peek()?.type === 'op' && peek().value;
    if (!['==', '!=', '>=', '<=', '>', '<'].includes(op)) return left;
    cursor++;
    const right = parseUnary();
    if (op === '==') return left === right;
    if (op === '!=') return left !== right;
    if (variables && typeof left !== typeof right) throw condError(uiText("Несовместимые типы для сравнения", "Incompatible types in comparison"));
    if (op === '>') return left > right;
    if (op === '<') return left < right;
    if (op === '>=') return left >= right;
    return left <= right;
  }
  function parseUnary() {
    if (accept('!')) return !parseUnary();
    const t = tokens[cursor++];
    if (!t) throw condError(uiText("Выражение неожиданно оборвалось — не хватает значения", "Expression ended unexpectedly. A value is missing"));
    if (t.type === 'number') return Number(t.value);
    if (t.type === 'string') return t.value;
    if (t.type === 'ident') {
      if (t.value === 'true' || t.value === 'false') return t.value === 'true';
      names.add(t.value);
      if (variables && !Object.hasOwn(variables, t.value)) throw condError(uiText("Неизвестная переменная: ", "Unknown variable: ") + t.value);
      return variables?.[t.value];
    }
    if (t.type === '(') {
      if (peek()?.type === ')') throw condError(uiText("Пустые скобки", "Empty parentheses"));
      const value = parseOr();
      if (tokens[cursor++]?.type !== ')') throw condError(uiText("Не хватает закрывающей скобки", "Missing closing parenthesis"));
      return value;
    }
    throw condError(uiText("Ожидалось значение на позиции ", "Expected a value at position ") + (t.pos + 1));
  }

  const value = parseOr();
  if (peek()) throw condError(uiText("Лишний символ на позиции ", "Unexpected character at position ") + (peek().pos + 1));
  return { names, value };
}

// Вычислитель использует ту же ограниченную грамматику, что и валидатор.
export function evaluateCondition(expr, variables) {
  if (!expr?.trim()) return true;
  try { return Boolean(parseConditionTokens(expr, variables).value); }
  catch { return false; }
}

// Разбор условия. Пустая строка — корректное «всегда истина» без переменных.
// Возвращает { ok, error, names } — names это имена переменных в выражении.
export function parseCondition(expr) {
  if (expr == null) return { ok: true, error: undefined, names: [] };
  if (typeof expr !== 'string') return { ok: false, error: uiText("Условие должно быть строкой", "Condition must be a string"), names: [] };
  if (expr.trim() === '') return { ok: true, error: undefined, names: [] };
  try {
    const { names } = parseConditionTokens(expr);
    return { ok: true, error: undefined, names: [...names] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), names: [] };
  }
}

// ---------------------------------------------------------------------------
// Валидация — ровно 13 классов проблем (§3.2 CONTRACT.md)
// ---------------------------------------------------------------------------

// Человекочитаемое имя узла для сообщений валидатора.
function nodeLabel(node) {
  const t = asString(node.title).trim();
  if (t) return t;
  const text = asString(node.text).trim();
  if (text) return text.length > 40 ? text.slice(0, 40) + '…' : text;
  return TYPE_LABELS[node.type] || uiText("Узел", "Node");
}

function nodeIssue(severity, code, message, node, field) {
  const issue = { severity, code, message, nodeId: node.id, entity: { kind: 'node', id: node.id } };
  if (field) issue.field = field;
  return issue;
}

export function validateProject(project) {
  const issues = [];
  if (!isObj(project)) return issues;

  const nodes = asArray(project.nodes);
  const characters = asArray(project.characters);
  const locations = asArray(project.locations);
  const variables = asArray(project.variables);
  const chapters = asArray(project.chapters);

  const byId = indexNodes(project);
  const charIds = new Set(characters.filter((c) => c && c.id).map((c) => c.id));
  const locIds = new Set(locations.filter((l) => l && l.id).map((l) => l.id));
  const varIds = new Set(variables.filter((v) => v && v.id).map((v) => v.id));
  const chapterIds = new Set(chapters.filter((c) => c && c.id).map((c) => c.id));

  const validNodes = nodes.filter((n) => n && n.id);

  // --- дубликаты имён переменных (11) и «не используется» (8) для пустых проектов
  const nameToIds = new Map();
  for (const v of variables) {
    if (!isObj(v)) continue;
    const name = asString(v.name).trim();
    if (!name) continue;
    if (!nameToIds.has(name)) nameToIds.set(name, []);
    nameToIds.get(name).push(v.id);
  }
  for (const [name, ids] of nameToIds) {
    if (ids.length > 1) {
      issues.push({
        severity: 'error',
        code: 'duplicate-variable',
        message: `${uiText("Имя переменной", "Variable name")} «${name}» ${uiText("используется несколько раз", "is used more than once")}: ${ids.join(', ')}.`,
        entity: { kind: 'variable', id: ids[0] },
      });
    }
  }

  const usedVarNames = new Set(); // имена переменных, встречающиеся в условиях
  const usedVarIds = new Set();   // id переменных из эффектов
  const conditionTexts = [];      // все непустые условия проекта: {expr, node, where}
  for (const n of validNodes) {
    for (const c of asArray(n.choices)) {
      if (c && asString(c.condition).trim()) conditionTexts.push({ expr: c.condition, node: n, where: `choices[${c.id || ''}]` });
    }
    for (const b of asArray(n.branches)) {
      if (b && asString(b.condition).trim()) conditionTexts.push({ expr: b.condition, node: n, where: `branches[${b.id || ''}]` });
    }
    const allEffects = [
      ...asArray(n.effects),
      ...asArray(n.choices).flatMap((c) => (c ? asArray(c.effects) : [])),
    ];
    for (const e of allEffects) {
      if (e && e.varId) usedVarIds.add(e.varId);
    }
  }
  for (const { expr } of conditionTexts) {
    const parsed = parseCondition(expr);
    if (parsed.ok) for (const name of parsed.names) usedVarNames.add(name);
  }

  if (validNodes.length === 0) {
    // Узлов нет — проверяем только переменные (дубликаты уже выше, «не используется» ниже).
    for (const v of variables) {
      if (!isObj(v) || !v.id) continue;
      if (!usedVarIds.has(v.id) && !usedVarNames.has(asString(v.name).trim())) {
        issues.push({
          severity: 'hint',
          code: 'unused-variable',
          message: `${uiText("Переменная", "Variable")} «${v.name}» (${v.id}) ${uiText("не используется ни в условиях, ни в эффектах", "is unused in conditions and effects")}.`,
          entity: { kind: 'variable', id: v.id },
        });
      }
    }
    return sortIssues(issues);
  }

  // --- 1. стартовый узел
  const startId = asString(project.startNodeId);
  const startNode = startId ? byId.get(startId) || null : null;
  if (!startNode) {
    issues.push({
      severity: 'error',
      code: 'start-missing',
      message: startId
        ? `${uiText("Стартовый узел", "Start node")} «${startId}» ${uiText("не найден — проверьте, не переименован ли он", "not found; check whether it was renamed")}.`
        : uiText("Не задан стартовый узел — непонятно, где начинается история.", "No start node. Set where the story begins."),
    });
  }

  // --- проход по каждому узлу: 2, 3, 5, 6, 7, 9, 10, 13
  for (const n of validNodes) {
    const label = `«${nodeLabel(n)}» (${n.id})`;

    // 2. битые ссылки
    if (asString(n.next) && !byId.has(n.next)) {
      issues.push(nodeIssue('error', 'broken-link', `${label}: ${uiText("переход ведёт к несуществующему узлу", "transition leads to a missing node")} «${n.next}».`, n, 'next'));
    }
    asArray(n.choices).forEach((c, i) => {
      if (!c) return;
      if (asString(c.next) && !byId.has(c.next)) {
        issues.push(nodeIssue('error', 'broken-link', `${label}: ${uiText("вариант", "choice")} «${c.text || uiText("без текста", "no text")}» ${uiText("ведёт к несуществующему узлу", "leads to a missing node")} «${c.next}».`, n, `choices[${i}].next`));
      }
    });
    asArray(n.branches).forEach((b, i) => {
      if (!b) return;
      if (asString(b.next) && !byId.has(b.next)) {
        issues.push(nodeIssue('error', 'broken-link', `${label}: ${uiText("ветвь", "branch")} ${i + 1} (${b.condition ? `«${b.condition}»` : uiText("без условия", "no condition")}) ${uiText("ведёт к несуществующему узлу", "leads to a missing node")} «${b.next}».`, n, `branches[${i}].next`));
      }
    });

    // 3. пустой текст реплики/сцены; выбор без вариантов
    if ((n.type === 'line' || n.type === 'scene') && !asString(n.text).trim()) {
      issues.push(nodeIssue('warning', 'empty-text', `${uiText("У", "Node")} ${n.type === 'line' ? uiText("реплики", "lines") : uiText("сцены", "scenes")} ${label} ${uiText("пустой текст", "has empty text")}.`, n, 'text'));
    }
    if (n.type === 'choice' && asArray(n.choices).length === 0) {
      issues.push(nodeIssue('error', 'choice-empty', `${uiText("Узел выбора", "Choice node")} ${label} ${uiText("не содержит ни одного варианта ответа", "contains no choices")}.`, n, 'choices'));
    }

    // 5. тупик (нет ни next, ни исходящих ветвей/вариантов)
    if (['line', 'scene', 'condition', 'choice'].includes(n.type)) {
      const hasOutgoing =
        asString(n.next) ||
        asArray(n.choices).some((c) => c && asString(c.next)) ||
        asArray(n.branches).some((b) => b && asString(b.next));
      if (!hasOutgoing) {
        issues.push(nodeIssue('error', 'dead-end', `${uiText("Тупик", "Dead end")}: ${label} (${TYPE_LABELS[n.type].toLowerCase()}) ${uiText("не имеет ни переходов, ни ветвей — история обрывается", "has no transitions or branches; the story stops here")}.`, n));
      }
    }

    // 6. пустые и дублирующиеся варианты выбора
    if (n.type === 'choice') {
      const seenTexts = new Map();
      asArray(n.choices).forEach((c, i) => {
        if (!c) return;
        const text = asString(c.text);
        if (!text.trim()) {
          issues.push(nodeIssue('warning', 'empty-choice', `${label}: ${uiText("пустой текст варианта", "empty choice text")} ${i + 1} — ${uiText("игрок увидит пустую кнопку", "the player will see an empty button")}.`, n, `choices[${i}].text`));
        } else {
          const key = text.trim();
          if (seenTexts.has(key)) {
            issues.push(nodeIssue('warning', 'duplicate-choice', `${label}: ${uiText("варианты", "choices")} ${seenTexts.get(key) + 1} ${uiText("и", "and")} ${i + 1} ${uiText("повторяются", "are duplicates")}: «${key}».`, n, `choices[${i}].text`));
          } else {
            seenTexts.set(key, i);
          }
        }
      });
    }

    // 7. спикер и локация
    const speakerId = asString(n.speakerId);
    if (n.type === 'line' && !speakerId) {
      issues.push(nodeIssue('warning', 'no-speaker', `${uiText("У реплики", "Line")} ${label} ${uiText("не выбран спикер", "has no speaker")}.`, n, 'speakerId'));
    } else if (speakerId && !charIds.has(speakerId)) {
      issues.push(nodeIssue('warning', 'no-speaker', `${uiText("Реплика", "Line")} ${label} ${uiText("ссылается на несуществующего персонажа", "refers to a missing character")} («${speakerId}»).`, n, 'speakerId'));
    }
    const locationId = asString(n.locationId);
    if ((n.type === 'line' || n.type === 'scene') && !locationId) {
      issues.push(nodeIssue('hint', 'no-location', `${uiText("У", "Node")} ${n.type === 'line' ? uiText("реплики", "lines") : uiText("сцены", "scenes")} ${label} ${uiText("не указана локация", "has no location")}.`, n, 'locationId'));
    } else if (locationId && !locIds.has(locationId)) {
      issues.push(nodeIssue('hint', 'no-location', `${label} ${uiText("ссылается на несуществующую локацию", "refers to a missing location")} «${locationId}».`, n, 'locationId'));
    }

    // 9. эффекты
    const allEffects = [
      ...asArray(n.effects).map((e) => ({ e, where: 'effects' })),
      ...asArray(n.choices).flatMap((c, ci) => asArray(c && c.effects).map((e) => ({ e, where: `choices[${ci}].effects` }))),
    ];
    for (const { e, where } of allEffects) {
      if (!isObj(e)) continue;
      if (!Object.prototype.hasOwnProperty.call(OP_LABELS, asString(e.op))) {
        issues.push(nodeIssue('error', 'bad-effect', `${label}: ${uiText("неизвестная операция", "unknown operation")} «${e.op}» ${uiText("в эффекте", "in effect")} (${where}).`, n, where));
      }
      if (e.varId !== undefined && !varIds.has(asString(e.varId))) {
        issues.push(nodeIssue('error', 'bad-effect', `${label}: ${uiText("эффект", "effect")} (${where}) ${uiText("ссылается на несуществующую переменную", "refers to a missing variable")} «${e.varId}».`, n, where));
      }
    }

    // 10. синтаксис условий
    for (const { expr, node, where } of conditionTexts) {
      if (node !== n) continue;
      const parsed = parseCondition(expr);
      if (!parsed.ok) {
        issues.push(nodeIssue('error', 'bad-condition', `${label}: ${uiText("ошибка в условии", "invalid condition")} «${expr}» (${where}) — ${parsed.error}.`, n, `${where}.condition`));
      }
    }

    // 13. глава
    const chapterId = asString(n.chapterId);
    if (!chapterId) {
      issues.push(nodeIssue('hint', 'no-chapter', `${uiText("Узел", "Node")} ${label} ${uiText("не привязан к главе", "has no chapter")}.`, n, 'chapterId'));
    } else if (!chapterIds.has(chapterId)) {
      issues.push(nodeIssue('hint', 'no-chapter', `${uiText("Узел", "Node")} ${label} ${uiText("ссылается на несуществующую главу", "refers to a missing chapter")} «${chapterId}».`, n, 'chapterId'));
    }
  }

  // --- 4. достижимость и 12. циклы без выхода (имеют смысл только при валидном старте)
  if (startNode) {
    const reachable = new Set([startNode.id]);
    const queue = [startNode.id];
    while (queue.length) {
      const id = queue.shift();
      for (const e of outgoingEdges(project, id)) {
        if (e.to && byId.has(e.to) && !reachable.has(e.to)) {
          reachable.add(e.to);
          queue.push(e.to);
        }
      }
    }
    for (const n of validNodes) {
      if (n.type !== 'note' && !reachable.has(n.id)) {
        issues.push(nodeIssue('warning', 'unreachable', `${uiText("Узел", "Node")} «${nodeLabel(n)}» (${n.id}) ${uiText("недостижим из старта — игрок его никогда не увидит", "is unreachable from the start")}.`, n));
      }
    }

    // Обратная достижимость от концовок: кто может дойти до какого-нибудь end.
    const reverse = new Map(); // id -> [предшественники]
    for (const n of validNodes) {
      for (const e of outgoingEdges(project, n.id)) {
        if (!e.to || !byId.has(e.to)) continue;
        if (!reverse.has(e.to)) reverse.set(e.to, []);
        reverse.get(e.to).push(n.id);
      }
    }
    const endIds = validNodes.filter((n) => n.type === 'end').map((n) => n.id);
    const canReachEnd = new Set(endIds);
    const rqueue = [...endIds];
    while (rqueue.length) {
      const id = rqueue.shift();
      for (const prev of reverse.get(id) || []) {
        if (!canReachEnd.has(prev)) { canReachEnd.add(prev); rqueue.push(prev); }
      }
    }
    for (const n of validNodes) {
      if ((n.type === 'condition' || n.type === 'choice') && !canReachEnd.has(n.id)) {
        issues.push(nodeIssue('warning', 'cycle-no-exit', `${uiText("Из узла", "Node")} «${nodeLabel(n)}» (${n.id}) ${uiText("нет пути ни к одной концовке — игрок застрянет в цикле", "has no path to an ending; the player may get stuck in a loop")}.`, n));
      }
    }
  }

  // --- 8. неиспользуемые сущности
  const usedCharIds = new Set(validNodes.map((n) => asString(n.speakerId)).filter(Boolean));
  for (const c of characters) {
    if (!isObj(c) || !c.id) continue;
    if (!usedCharIds.has(c.id)) {
      issues.push({
        severity: 'hint',
        code: 'unused-character',
        message: `${uiText("Персонаж", "Character")} «${c.name || c.id}» (${c.id}) ${uiText("не произносит ни одной реплики", "has no lines")}.`,
        entity: { kind: 'character', id: c.id },
      });
    }
  }
  const usedLocIds = new Set(validNodes.map((n) => asString(n.locationId)).filter(Boolean));
  for (const l of locations) {
    if (!isObj(l) || !l.id) continue;
    if (!usedLocIds.has(l.id)) {
      issues.push({
        severity: 'hint',
        code: 'unused-location',
        message: `${uiText("Локация", "Location")} «${l.name || l.id}» (${l.id}) ${uiText("не используется ни в одном узле", "is not used in any node")}.`,
        entity: { kind: 'location', id: l.id },
      });
    }
  }
  for (const v of variables) {
    if (!isObj(v) || !v.id) continue;
    if (!usedVarIds.has(v.id) && !usedVarNames.has(asString(v.name).trim())) {
      issues.push({
        severity: 'hint',
        code: 'unused-variable',
        message: `${uiText("Переменная", "Variable")} «${v.name}» (${v.id}) ${uiText("не используется ни в условиях, ни в эффектах", "is unused in conditions and effects")}.`,
        entity: { kind: 'variable', id: v.id },
      });
    }
  }

  return sortIssues(issues);
}

function sortIssues(issues) {
  // Сначала ошибки, потом предупреждения, потом подсказки; внутри — стабильный порядок.
  return issues.slice().sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3));
}

// ---------------------------------------------------------------------------
// Статистика (§3.3)
// ---------------------------------------------------------------------------

export function computeStats(project) {
  const nodes = asArray(project && project.nodes).filter((n) => n && n.id);
  const byType = {};
  for (const t of NODE_TYPES) byType[t] = 0;
  let words = 0;
  let chars = 0;
  let choiceOptions = 0;

  for (const n of nodes) {
    if (NODE_TYPES.includes(n.type)) byType[n.type] += 1;
    if (n.type !== 'note') {
      const text = asString(n.text);
      words += countWords(text);
      chars += text.length;
    }
    if (n.type === 'choice') choiceOptions += asArray(n.choices).length;
  }

  // Время прохождения: слова/150 минут + 3 секунды на каждый вариант выбора, минимум 1 минута.
  const minutes = Math.max(1, Math.ceil(words / 150 + (choiceOptions * 3) / 60));

  const bySpeaker = asArray(project.characters).filter(isObj).map((ch) => {
    let lines = 0;
    let w = 0;
    for (const n of nodes) {
      if (n.type === 'line' && n.speakerId === ch.id) {
        lines += 1;
        w += countWords(n.text);
      }
    }
    return { id: ch.id, name: asString(ch.name), color: asString(ch.color), lines, words: w };
  });
  bySpeaker.sort((a, b) => b.words - a.words || a.name.localeCompare(b.name, getLanguage()));

  const byLocation = asArray(project.locations).filter(isObj).map((loc) => {
    let scenes = 0;
    let w = 0;
    for (const n of nodes) {
      if (n.locationId !== loc.id || n.type === 'note') continue;
      if (n.type === 'scene') scenes += 1;
      w += countWords(n.text);
    }
    return { id: loc.id, name: asString(loc.name), scenes, words: w };
  });

  const chapters = asArray(project.chapters).filter(isObj).map((ch) => ({ id: ch.id, name: asString(ch.name), nodes: 0, words: 0 }));
  const chapterById = new Map(chapters.map((c) => [c.id, c]));
  for (const n of nodes) {
    const c = chapterById.get(asString(n.chapterId));
    if (!c) continue;
    c.nodes += 1;
    if (n.type !== 'note') c.words += countWords(n.text);
  }

  // Достижимость и глубина от старта (BFS).
  const byId = indexNodes(project);
  const startId = asString(project && project.startNodeId);
  const startNode = startId ? byId.get(startId) || null : null;
  let longestChain = 0;
  let unreachable = 0;
  if (startNode) {
    const depth = new Map([[startNode.id, 1]]);
    const queue = [startNode.id];
    while (queue.length) {
      const id = queue.shift();
      longestChain = Math.max(longestChain, depth.get(id));
      for (const e of outgoingEdges(project, id)) {
        if (!e.to || !byId.has(e.to) || depth.has(e.to)) continue;
        depth.set(e.to, depth.get(id) + 1);
        queue.push(e.to);
      }
    }
    unreachable = nodes.filter((n) => n.type !== 'note' && !depth.has(n.id)).length;
  }

  return {
    nodes: nodes.length,
    lines: byType.line,
    words,
    chars,
    choices: choiceOptions,
    endings: byType.end,
    notes: byType.note,
    minutes,
    byType,
    bySpeaker,
    byLocation,
    longestChain,
    unreachable,
    chapters,
  };
}

// ---------------------------------------------------------------------------
// Автораскладка: иерархическая, BFS-уровни от старта; вне дерева — блок справа
// ---------------------------------------------------------------------------

export function autoLayout(project) {
  const nodes = asArray(project && project.nodes).filter((n) => n && n.id);
  const byId = indexNodes(project);
  const positions = {};

  const startId = asString(project && project.startNodeId);
  const visited = new Set();
  const levels = [];
  if (startId && byId.has(startId)) {
    let current = [startId];
    visited.add(startId);
    while (current.length) {
      levels.push(current.slice());
      const nextLevel = [];
      for (const id of current) {
        for (const e of outgoingEdges(project, id)) {
          if (!e.to || !byId.has(e.to) || visited.has(e.to)) continue;
          visited.add(e.to);
          nextLevel.push(e.to);
        }
      }
      current = nextLevel;
    }
  }

  // Высота строки зависит от того, есть ли у узла превью: карточки с
  // изображением выше, иначе они наезжали бы на соседей снизу.
  const yFor = (level) => {
    let y = 0;
    return level.map((id) => {
      const node = byId.get(id);
      const height = node ? nodeCardHeight(node) : CARD_HEIGHT;
      const at = y;
      y += height + (LAYOUT_STEP_Y - CARD_HEIGHT);
      return at;
    });
  };

  levels.forEach((level, li) => {
    const ys = yFor(level);
    level.forEach((id, idx) => {
      positions[id] = { x: li * LAYOUT_STEP_X, y: ys[idx] };
    });
  });

  // Узлы вне дерева (недостижимые, заметки без связей) — отдельным блоком справа.
  const maxLevel = levels.length - 1;
  const rest = nodes.filter((n) => !visited.has(n.id));
  let restY = 0;
  rest.forEach((n) => {
    positions[n.id] = { x: (maxLevel + 1) * LAYOUT_STEP_X, y: restY };
    restY += nodeCardHeight(n) + (LAYOUT_STEP_Y - CARD_HEIGHT);
  });

  return { positions };
}

// ---------------------------------------------------------------------------
// Пути и поддеревья
// ---------------------------------------------------------------------------

// Кратчайший путь между узлами (BFS); [from, ..., to] или null.
export function findPath(project, from, to) {
  const byId = indexNodes(project);
  if (!from || !to || !byId.has(from) || !byId.has(to)) return null;
  if (from === to) return [from];
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const id = queue.shift();
    for (const e of outgoingEdges(project, id)) {
      if (!e.to || !byId.has(e.to) || prev.has(e.to)) continue;
      prev.set(e.to, id);
      if (e.to === to) {
        const path = [to];
        let cur = id;
        while (cur !== null) { path.unshift(cur); cur = prev.get(cur); }
        return path;
      }
      queue.push(e.to);
    }
  }
  return null;
}

// Поддерево от узла на depth уровней рёбер (по умолчанию — целиком).
// Узлы возвращаются копиями; рёбра — только между вошедшими узлами.
export function getSubtree(project, id, depth = Infinity) {
  const byId = indexNodes(project);
  const nodes = [];
  const edges = [];
  if (!id || !byId.has(id)) return { nodes, edges };
  const d = depth == null ? Infinity : Math.max(0, asNumber(depth, 0));
  const visited = new Set([id]);
  let frontier = [id];
  for (let level = 0; level < d && frontier.length; level++) {
    const next = [];
    for (const nid of frontier) {
      for (const e of outgoingEdges(project, nid)) {
        if (!e.to || !byId.has(e.to) || visited.has(e.to)) continue;
        visited.add(e.to);
        next.push(e.to);
      }
    }
    frontier = next;
  }
  for (const nid of visited) {
    nodes.push(deepClone(byId.get(nid)));
    for (const e of outgoingEdges(project, nid)) {
      if (visited.has(e.to)) edges.push({ from: nid, ...e });
    }
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// applyOps — операции, единственный путь мутации проекта
// ---------------------------------------------------------------------------

// Временные id (tmp_…) из bulk-операций разрешаются в реальные по мере создания узлов.
function resolveLink(value, created) {
  if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(created, value)) return created[value];
  return value;
}

const NODE_STRING_FIELDS = ['chapterId', 'title', 'speakerId', 'locationId', 'text', 'emotion', 'next', 'notes', 'color'];
const CHARACTER_FIELDS = ['name', 'color', 'role', 'age', 'description', 'appearance', 'personality', 'speech', 'notes'];
const LOCATION_FIELDS = ['name', 'description', 'atmosphere', 'timeOfDay', 'notes'];
const CHAPTER_FIELDS = ['name', 'color'];
const META_FIELDS = ['title', 'author', 'description', 'createdAt', 'updatedAt'];

// Позиция по умолчанию для нового узла — рядом с центром имеющихся.
function defaultPositionFor(project) {
  const pts = asArray(project.nodes)
    .filter((n) => n && n.position)
    .map((n) => ({ x: asNumber(n.position.x), y: asNumber(n.position.y) }));
  if (!pts.length) return { x: 400, y: 300 };
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  // Небольший детерминированный сдвиг, чтобы новые узлы не ложились ровно друг на друга.
  const jitter = (pts.length % 5) * 24;
  return { x: Math.round(cx + jitter), y: Math.round(cy + jitter) };
}

function resolveNewId(project, rawId, prefix, collection, what, ctx) {
  let id = asString(rawId);
  if (!id || id.startsWith('tmp_')) {
    const real = uniqueId(project, prefix);
    if (id) ctx.created[id] = real;
    ctx.newIds.push(real);
    return real;
  }
  if (findEntity(collection, id)) throw new Error(`${what}: ${uiText("объект", "entry")} «${id}» ${uiText("уже существует", "already exists")}.`);
  ctx.newIds.push(id);
  return id;
}

function applyOneOp(project, op, ctx) {
  // tmp_-id, объявленные в этом же батче, разрешаем и в адресатах операций
  // (setChoices/setBranches/updateNode/deleteNode/connect по tmp_1 и т.п.).
  if (typeof op.id === 'string' || typeof op.to === 'string' || typeof op.from === 'string') {
    op = {
      ...op,
      id: typeof op.id === 'string' ? resolveLink(op.id, ctx.created) : op.id,
      to: typeof op.to === 'string' ? resolveLink(op.to, ctx.created) : op.to,
      from: typeof op.from === 'string' ? resolveLink(op.from, ctx.created) : op.from,
    };
  }
  const mark = (id) => { if (id) ctx.changed.add(id); };
  switch (op.op) {

    case 'updateNode': {
      const node = requireNode(project, asString(op.id));
      const patch = op.patch;
      if (!isObj(patch)) throw new Error(uiText("updateNode: patch должен быть объектом.", "updateNode: patch must be an object."));
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'id') continue; // id менять нельзя
        if (key === 'type') {
          if (!NODE_TYPES.includes(value)) throw new Error(`updateNode: ${uiText("недопустимый тип узла", "invalid node type")} «${value}».`);
          node.type = value;
        } else if (key === 'next') {
          node.next = asString(resolveLink(value, ctx.created));
        } else if (key === 'position') {
          const pos = isObj(value) ? value : {};
          node.position = {
            x: pos.x === undefined ? node.position.x : asNumber(pos.x, node.position.x),
            y: pos.y === undefined ? node.position.y : asNumber(pos.y, node.position.y),
          };
        } else if (key === 'voiceSeed') {
          if (value == null) delete node.voiceSeed;
          else if (Number.isInteger(value)) node.voiceSeed = value >>> 0;
          else throw new Error(uiText("Некорректный номер дубля.", "Invalid take seed."));
        } else if (key === 'choices') {
          node.choices = normalizeChoices(value, ctx.created);
        } else if (key === 'branches') {
          node.branches = normalizeBranches(value, ctx.created);
        } else if (key === 'effects') {
          node.effects = normalizeEffects(value);
        } else if (key === 'tags') {
          node.tags = asArray(value).filter((t) => typeof t === 'string');
        } else if (key === 'media') {
          const known = Object.keys(isObj(project.media) ? project.media : {});
          node.media = normalizeMediaList(value).filter((id) => known.includes(id));
          if (!node.media.includes(node.previewId)) node.previewId = node.media[0] || '';
        } else if (key === 'previewId') {
          const wanted = asString(value);
          node.previewId = node.media.includes(wanted) ? wanted : '';
        } else if (NODE_STRING_FIELDS.includes(key)) {
          node[key] = asString(value);
        } else {
          throw new Error(`updateNode: ${uiText("неизвестное поле", "unknown field")} «${key}».`);
        }
      }
      mark(node.id);
      break;
    }

    case 'addMedia': {
      const raw = op.media;
      if (!isObj(raw)) throw new Error(uiText("addMedia: ожидается объект изображения.", "addMedia: expected an image object."));
      const data = asString(raw.data);
      if (!data.startsWith('data:image/')) throw new Error(uiText("addMedia: изображение должно быть data-URL вида data:image/…", "addMedia: image must have a data URL of type data:image/…"));
      if (!isObj(project.media)) project.media = {};
      let id = asString(raw.id);
      if (!id || id.startsWith('tmp_') || project.media[id]) {
        const real = uniqueId(project, 'm_');
        if (id) ctx.created[id] = real;
        id = real;
      }
      project.media[id] = {
        id,
        name: asString(raw.name, 'image'),
        mime: asString(raw.mime, 'image/webp'),
        w: Math.max(0, Math.round(asNumber(raw.w))),
        h: Math.max(0, Math.round(asNumber(raw.h))),
        size: Math.max(0, Math.round(asNumber(raw.size))),
        data,
      };
      ctx.newIds.push(id);
      mark(id);
      break;
    }

    case 'deleteMedia': {
      const id = asString(op.id);
      if (!isObj(project.media) || !project.media[id]) {
        throw new Error(`deleteMedia: ${uiText("изображение", "image")} «${id || '—'}» ${uiText("не найдено", "not found")}.`);
      }
      delete project.media[id];
      for (const node of asArray(project.nodes)) {
        if (!node) continue;
        const before = node.media.length;
        node.media = node.media.filter((m) => m !== id);
        if (node.previewId === id || !node.media.includes(node.previewId)) {
          node.previewId = node.media[0] || '';
        }
        if (node.media.length !== before) mark(node.id);
      }
      mark(id);
      break;
    }

    case 'setNodeMedia': {
      const node = requireNode(project, asString(op.id));
      const known = Object.keys(isObj(project.media) ? project.media : {});
      node.media = normalizeMediaList(op.media).filter((id) => known.includes(id));
      const wanted = asString(op.previewId);
      node.previewId = node.media.includes(wanted) ? wanted : (node.media[0] || '');
      mark(node.id);
      break;
    }

    case 'createNode': {
      const raw = op.node;
      if (!isObj(raw)) throw new Error(uiText("createNode: ожидается объект узла.", "createNode: expected a node object."));
      if (raw.type !== undefined && !NODE_TYPES.includes(raw.type)) {
        throw new Error(`createNode: ${uiText("недопустимый тип узла", "invalid node type")} «${raw.type}».`);
      }
      const id = resolveNewId(project, raw.id, 'n_', project.nodes, 'createNode', ctx);
      const node = defaultNode({ ...raw, id }, ctx.created);
      if (!isObj(raw.position)) node.position = defaultPositionFor(project);
      const wasEmpty = project.nodes.length === 0 && !asString(project.startNodeId);
      project.nodes.push(node);
      // Первый узел в пустом проекте логично сделать стартовым.
      if (node.type !== 'note' && !project.startNodeId && (wasEmpty || project.nodes.every(n => n.id === id || n.type === 'note'))) project.startNodeId = id;
      mark(id);
      break;
    }

    case 'deleteNode': {
      const id = asString(op.id);
      const node = requireNode(project, id);
      const hasReconnect = op.reconnectTo !== undefined && op.reconnectTo !== null;
      const target = hasReconnect ? asString(op.reconnectTo) : asString(node.next);
      if (target === id) throw new Error(uiText("deleteNode: нельзя перенаправить связи на удаляемый узел.", "deleteNode: cannot redirect links to the node being deleted."));
      if (target && !findNode(project, target)) throw new Error(`deleteNode: ${uiText("узел для перенаправления", "redirect target")} «${target}» ${uiText("не найден", "not found")}.`);
      for (const other of asArray(project.nodes)) {
        if (!other || other === node) continue;
        let touched = false;
        if (other.next === id) { other.next = target; touched = true; }
        for (const c of asArray(other.choices)) {
          if (c && c.next === id) { c.next = target; touched = true; }
        }
        for (const b of asArray(other.branches)) {
          if (b && b.next === id) { b.next = target; touched = true; }
        }
        if (touched) mark(other.id);
      }
      project.nodes = project.nodes.filter((n) => n !== node);
      if (project.startNodeId === id) project.startNodeId = '';
      mark(id);
      break;
    }

    case 'retargetEdge': {
      const source = requireNode(project, asString(op.id));
      const target = requireNode(project, asString(op.to));
      const items = op.kind === 'choice' && source.type === 'choice' ? source.choices
        : op.kind === 'branch' && source.type === 'condition' ? source.branches : [];
      const link = items?.find(item => item.id === op.edgeId);
      if (!link) throw new Error(uiText("Переход не найден в исходном узле.", "Transition not found in source node."));
      link.next = target.id;
      mark(source.id);
      break;
    }

    case 'connect': {
      const from = requireNode(project, asString(op.from));
      const to = asString(resolveLink(asString(op.to), ctx.created));
      if (!to) throw new Error(uiText("connect: не указан целевой узел (to).", "connect: target node missing (to)."));
      if (!findNode(project, to)) throw new Error(`connect: ${uiText("целевой узел", "target node")} «${to}» ${uiText("не найден", "not found")}.`);
      if (from.type === 'end') throw new Error(uiText("connect: у узла-концовки не может быть исходящих связей.", "connect: ending nodes cannot have outgoing links."));
      if (from.type === 'choice') {
        const choiceText = asString(op.choiceText);
        if (op.choiceText !== undefined && op.choiceText !== null && choiceText !== '') {
          from.choices.push({ id: uid('o_'), text: choiceText, next: to, condition: asString(op.condition), effects: [], hint: '' });
        } else {
          from.next = to; // запасной переход, если ни один вариант недоступен
        }
      } else if (from.type === 'condition') {
        const bi = op.branchIndex;
        if (bi === 'else') {
          from.next = to;
        } else if (bi !== undefined && bi !== null) {
          const idx = Number(bi);
          if (!Number.isInteger(idx) || idx < 0 || idx >= from.branches.length) {
            throw new Error(`connect: ${uiText("в узле", "in node")} «${from.id}» ${uiText("нет ветви с индексом", "no branch with index")} ${bi}.`);
          }
          from.branches[idx].next = to;
        } else {
          from.branches.push({ id: uid('b_'), condition: asString(op.condition), next: to });
        }
      } else {
        from.next = to;
      }
      mark(from.id);
      break;
    }

    case 'disconnect': {
      const from = requireNode(project, asString(op.from));
      if (op.choiceId !== undefined && op.choiceId !== null) {
        const c = asArray(from.choices).find((x) => x && x.id === op.choiceId);
        if (!c) throw new Error(`disconnect: ${uiText("вариант", "choice")} «${op.choiceId}» ${uiText("не найден в узле", "not found in node")} «${from.id}».`);
        c.next = '';
      } else {
        from.next = '';
      }
      mark(from.id);
      break;
    }

    case 'setPositions': {
      const positions = op.positions;
      if (!isObj(positions)) throw new Error(uiText("setPositions: positions должен быть объектом {id: {x, y}}.", "setPositions: positions must be an object {id: {x, y}}."));
      for (const [id, p] of Object.entries(positions)) {
        const node = findNode(project, id);
        if (!node) continue; // узел уже удалён — просто пропускаем
        const x = Number(p && p.x);
        const y = Number(p && p.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error(`setPositions: ${uiText("некорректные координаты для узла", "invalid node coordinates")} «${id}».`);
        }
        node.position = { x, y };
        mark(id);
      }
      break;
    }

    case 'setNodeTexts': {
      if (!Array.isArray(op.items)) throw new Error(uiText("setNodeTexts: ожидается массив items.", "setNodeTexts: expected an array items."));
      const items = op.items;
      for (const item of items) {
        if (!isObj(item)) throw new Error(uiText("setNodeTexts: элементы items должны быть {id, text}.", "setNodeTexts: items must be {id, text}."));
        const node = requireNode(project, asString(item.id));
        if (typeof item.text !== 'string') throw new Error(`setNodeTexts: text ${uiText("для", "for")} «${item.id}» ${uiText("должен быть строкой", "must be a string")}.`);
        node.text = item.text;
        mark(node.id);
      }
      break;
    }

    case 'setChoices': {
      const node = requireNode(project, asString(op.id));
      if (!Array.isArray(op.choices)) throw new Error(uiText("setChoices: choices должен быть массивом.", "setChoices: choices must be an array."));
      node.choices = normalizeChoices(op.choices, ctx.created);
      mark(node.id);
      break;
    }

    case 'setBranches': {
      const node = requireNode(project, asString(op.id));
      if (!Array.isArray(op.branches)) throw new Error(uiText("setBranches: branches должен быть массивом.", "setBranches: branches must be an array."));
      node.branches = normalizeBranches(op.branches, ctx.created);
      mark(node.id);
      break;
    }

    case 'setEffects': {
      const node = requireNode(project, asString(op.id));
      if (!Array.isArray(op.effects)) throw new Error(uiText("setEffects: effects должен быть массивом.", "setEffects: effects must be an array."));
      const effects = normalizeEffects(op.effects);
      for (const e of effects) {
        if (!Object.prototype.hasOwnProperty.call(OP_LABELS, e.op)) {
          throw new Error(`setEffects: ${uiText("неизвестная операция", "unknown operation")} «${e.op}».`);
        }
      }
      node.effects = effects;
      mark(node.id);
      break;
    }

    case 'createCharacter': {
      if (!isObj(op.character)) throw new Error(uiText("createCharacter: ожидается объект персонажа.", "createCharacter: expected a character object."));
      const id = resolveNewId(project, op.character.id, 'c_', project.characters, 'createCharacter', ctx);
      project.characters.push(defaultCharacter({ ...op.character, id }));
      mark(id);
      break;
    }

    case 'updateCharacter': {
      const ch = requireEntity(project.characters, asString(op.id), uiText("Персонаж", "Character"));
      if (!isObj(op.patch)) throw new Error(uiText("updateCharacter: patch должен быть объектом.", "updateCharacter: patch must be an object."));
      for (const [key, value] of Object.entries(op.patch)) {
        if (key === 'id') continue;
        if (key === 'tags') ch.tags = asArray(value).filter((t) => typeof t === 'string');
        else if (key === 'voice') ch.voice = normalizeVoice(value);
        else if (CHARACTER_FIELDS.includes(key)) ch[key] = asString(value);
        else throw new Error(`updateCharacter: ${uiText("неизвестное поле", "unknown field")} «${key}».`);
      }
      mark(ch.id);
      break;
    }

    case 'deleteCharacter': {
      const id = asString(op.id);
      const ch = requireEntity(project.characters, id, uiText("Персонаж", "Character"));
      const reassign = op.reassignTo === undefined || op.reassignTo === null ? '' : asString(op.reassignTo);
      if (reassign && !findEntity(project.characters, reassign)) {
        throw new Error(`deleteCharacter: ${uiText("персонаж", "character")} «${reassign}» ${uiText("для переназначения не найден", "reassignment target not found")}.`);
      }
      for (const node of asArray(project.nodes)) {
        if (node && node.speakerId === id) { node.speakerId = reassign; mark(node.id); }
      }
      project.characters = project.characters.filter((c) => c !== ch);
      mark(id);
      break;
    }

    case 'createLocation': {
      if (!isObj(op.location)) throw new Error(uiText("createLocation: ожидается объект локации.", "createLocation: expected a location object."));
      const id = resolveNewId(project, op.location.id, 'l_', project.locations, 'createLocation', ctx);
      project.locations.push(defaultLocation({ ...op.location, id }));
      mark(id);
      break;
    }

    case 'updateLocation': {
      const loc = requireEntity(project.locations, asString(op.id), uiText("Локация", "Location"));
      if (!isObj(op.patch)) throw new Error(uiText("updateLocation: patch должен быть объектом.", "updateLocation: patch must be an object."));
      for (const [key, value] of Object.entries(op.patch)) {
        if (key === 'id') continue;
        if (key === 'tags') loc.tags = asArray(value).filter((t) => typeof t === 'string');
        else if (LOCATION_FIELDS.includes(key)) loc[key] = asString(value);
        else throw new Error(`updateLocation: ${uiText("неизвестное поле", "unknown field")} «${key}».`);
      }
      mark(loc.id);
      break;
    }

    case 'deleteLocation': {
      const id = asString(op.id);
      const loc = requireEntity(project.locations, id, uiText("Локация", "Location"));
      const reassign = op.reassignTo === undefined || op.reassignTo === null ? '' : asString(op.reassignTo);
      if (reassign && !findEntity(project.locations, reassign)) {
        throw new Error(`deleteLocation: ${uiText("локация", "location")} «${reassign}» ${uiText("для переназначения не найдена", "reassignment target not found")}.`);
      }
      for (const node of asArray(project.nodes)) {
        if (node && node.locationId === id) { node.locationId = reassign; mark(node.id); }
      }
      project.locations = project.locations.filter((l) => l !== loc);
      mark(id);
      break;
    }

    case 'createVariable': {
      if (!isObj(op.variable)) throw new Error(uiText("createVariable: ожидается объект переменной.", "createVariable: expected a variable object."));
      if (op.variable.type !== undefined && !VARIABLE_TYPES.includes(op.variable.type)) {
        throw new Error(`createVariable: ${uiText("недопустимый тип переменной", "invalid variable type")} «${op.variable.type}» (${uiText("допустимо", "allowed")} number/bool/string).`);
      }
      const id = resolveNewId(project, op.variable.id, 'v_', project.variables, 'createVariable', ctx);
      project.variables.push(defaultVariable({ ...op.variable, id }));
      mark(id);
      break;
    }

    case 'updateVariable': {
      const v = requireEntity(project.variables, asString(op.id), uiText("Переменная", "Variable"));
      if (!isObj(op.patch)) throw new Error(uiText("updateVariable: patch должен быть объектом.", "updateVariable: patch must be an object."));
      for (const [key, value] of Object.entries(op.patch)) {
        if (key === 'id') continue;
        if (key === 'type') {
          if (!VARIABLE_TYPES.includes(value)) throw new Error(`updateVariable: ${uiText("недопустимый тип", "invalid type")} «${value}».`);
          v.type = value;
        } else if (key === 'name' || key === 'description') {
          v[key] = asString(value);
        } else if (key === 'initial') {
          v.initial = value;
        } else {
          throw new Error(`updateVariable: ${uiText("неизвестное поле", "unknown field")} «${key}».`);
        }
      }
      mark(v.id);
      break;
    }

    case 'deleteVariable': {
      const id = asString(op.id);
      const v = requireEntity(project.variables, id, uiText("Переменная", "Variable"));
      project.variables = project.variables.filter((x) => x !== v);
      mark(id);
      break;
    }

    case 'createChapter': {
      if (!isObj(op.chapter)) throw new Error(uiText("createChapter: ожидается объект главы.", "createChapter: expected a chapter object."));
      const id = resolveNewId(project, op.chapter.id, 'ch_', project.chapters, 'createChapter', ctx);
      project.chapters.push(defaultChapter({ ...op.chapter, id }));
      mark(id);
      break;
    }

    case 'updateChapter': {
      const ch = requireEntity(project.chapters, asString(op.id), uiText("Глава", "Chapter"));
      if (!isObj(op.patch)) throw new Error(uiText("updateChapter: patch должен быть объектом.", "updateChapter: patch must be an object."));
      for (const [key, value] of Object.entries(op.patch)) {
        if (key === 'id') continue;
        if (key === 'collapsed') ch.collapsed = value === true;
        else if (CHAPTER_FIELDS.includes(key)) ch[key] = asString(value);
        else throw new Error(`updateChapter: ${uiText("неизвестное поле", "unknown field")} «${key}».`);
      }
      mark(ch.id);
      break;
    }

    case 'deleteChapter': {
      const id = asString(op.id);
      const ch = requireEntity(project.chapters, id, uiText("Глава", "Chapter"));
      const moveTo = op.moveNodesTo === undefined || op.moveNodesTo === null ? '' : asString(op.moveNodesTo);
      if (moveTo && !findEntity(project.chapters, moveTo)) {
        throw new Error(`deleteChapter: ${uiText("глава", "chapter")} «${moveTo}» ${uiText("для переноса узлов не найдена", "destination chapter not found")}.`);
      }
      for (const node of asArray(project.nodes)) {
        if (node && node.chapterId === id) { node.chapterId = moveTo; mark(node.id); }
      }
      project.chapters = project.chapters.filter((c) => c !== ch);
      mark(id);
      break;
    }

    case 'setStart': {
      const id = asString(op.id);
      if (!findNode(project, id)) throw new Error(`setStart: ${uiText("узел", "node")} «${id || '—'}» ${uiText("не найден", "not found")}.`);
      project.startNodeId = id;
      mark(id);
      break;
    }

    case 'setMeta': {
      if (!isObj(op.patch)) throw new Error(uiText("setMeta: patch должен быть объектом.", "setMeta: patch must be an object."));
      for (const key of META_FIELDS) {
        if (op.patch[key] !== undefined) project.meta[key] = asString(op.patch[key]);
      }
      mark('meta');
      break;
    }

    case 'setVoice': {
      const voice = normalizeVoice(op.voice);
      if (!voice && !(op.voice === null && (op.nodeId || op.id))) {
        throw new Error(uiText("setVoice: ожидается объект голоса.", "setVoice: expected a voice object."));
      }
      if (op.nodeId) {
        const node = requireNode(project, asString(op.nodeId));
        if (voice) node.voice = voice;
        else delete node.voice;
        mark(node.id);
      } else if (op.id) {
        const ch = requireEntity(project.characters, asString(op.id), uiText("Персонаж", "Character"));
        ch.voice = voice;
        mark(ch.id);
      } else {
        project.voice = voice;
        mark('voice');
      }
      break;
    }

    default:
      throw new Error(`${uiText("Неизвестная операция", "Unknown operation")} «${asString(op.op) || '—'}».`);
  }
}

// Voice edits replace the complete normalized descriptor. Sharing it across
// undo snapshots avoids copying embedded WAVs for every unrelated text edit.
function cloneRecordForEdit(record) {
  if (!record?.voice) return deepClone(record);
  const { voice, ...rest } = record;
  return { ...deepClone(rest), voice };
}

function cloneRecordsForEdit(records) {
  if (!Array.isArray(records)) return records;
  const copies = deepClone(records.map(record => record?.voice ? { ...record, voice: null } : record));
  for (let i = 0; i < records.length; i++) {
    if (records[i]?.voice) copies[i].voice = records[i].voice;
  }
  return copies;
}

// Атомарное применение списка операций: работаем на глубокой копии,
// при ошибке оригинальный объект не меняется вовсе.
export function applyOps(project, ops) {
  if (!isObj(project)) return { ok: false, error: uiText("Некорректный проект: ожидается объект.", "Invalid project: expected an object.") };
  const list = ops == null ? [] : Array.isArray(ops) ? ops : [ops];
  if (list.some((o) => !isObj(o))) return { ok: false, error: uiText("Каждая операция должна быть объектом с полем op.", "Each operation must be an object with field op.") };

  // Text edits only touch the addressed records. Store history keeps the old
  // root fields, so every mutating branch operates on its own draft.
  let work;
  if (list.every(op => op.op === 'updateNode' || op.op === 'setNodeTexts')) {
    const ids = new Set(list.flatMap(op => op.op === 'updateNode' ? [op.id] : asArray(op.items).map(item => item?.id)));
    work = { ...project, nodes: project.nodes.map(node => ids.has(node?.id) ? cloneRecordForEdit(node) : node) };
  } else {
    // Media operations add/remove complete entries. Their data URLs and
    // metadata are immutable; only the dictionary itself needs a fresh copy.
    const {media, voice, characters, nodes, ...content} = project;
    work = deepClone(content);
    work.nodes = cloneRecordsForEdit(nodes);
    work.characters = cloneRecordsForEdit(characters);
    work.voice = voice;
    if (media) work.media = { ...media };
  }
  // created — карта tmp_→реальный id для разрешения ссылок внутри батча,
  // newIds — упорядоченный список реальных id всех созданных объектов (наружу как created[]).
  const ctx = { changed: new Set(), created: {}, newIds: [] };
  try {
    for (const op of list) applyOneOp(work, op, ctx);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // Второй проход: ссылки на tmp_-id, объявленные ПОЗЖЕ в батче (forward references).
  if (Object.keys(ctx.created).length) {
    const fix = (v) => (typeof v === 'string' && Object.prototype.hasOwnProperty.call(ctx.created, v) ? ctx.created[v] : v);
    for (const n of work.nodes || []) {
      if (!n || typeof n !== 'object') continue;
      n.next = fix(n.next);
      for (const c of n.choices || []) if (c) c.next = fix(c.next);
      for (const b of n.branches || []) if (b) b.next = fix(b.next);
    }
    work.startNodeId = fix(work.startNodeId);
  }

  // Успех: переносим состояние в оригинальный объект (ссылка вызывающего сохраняется).
  for (const key of Object.keys(work)) project[key] = work[key];
  return { ok: true, changed: [...ctx.changed], created: [...ctx.newIds] };
}

// ---------------------------------------------------------------------------
// Store — состояние приложения, undo/redo, группы правок
// ---------------------------------------------------------------------------

function describeOps(ops) {
  const first = Array.isArray(ops) ? ops[0] : ops;
  const name = asString(first && first.op);
  if (Array.isArray(ops) && ops.length > 1) return `${ops.length} ${uiText("операций", "operations")}`;
  return name || uiText("правка", "edit");
}

export class Store {
  constructor() {
    this.project = createEmptyProject();
    this.filePath = null;
    this.dirty = false;
    this.selection = { kind: null, id: null };
    this.settings = {}; // заполняется app.js
    this._undo = [];        // [{ snapshot, label, groupKey, at, changed, open }]
    this._redo = [];
    this._subscribers = new Set();
    this.generation = 0;
    this.revision = 0;
    this.documentKey = uid('draft_');
    this._groupSeq = 0;
    this._openGroup = null;
  }

  // Единственный путь мутации проекта. Группа (group) склеивает правки
  // в пределах 800 мс в одну запись undo.
  apply(ops, opts = {}) {
    const list = ops == null ? [] : Array.isArray(ops) ? ops : [ops];
    if (!list.length) return { ok: true, changed: [], created: [] };

    const before = { ...this.project };
    const result = applyOps(this.project, list);
    if (!result.ok) return result;

    const label = asString(opts.label) || describeOps(list);
    const now = Date.now();
    const last = this._undo[this._undo.length - 1];
    const inOpenGroup = Boolean(this._openGroup) && last === this._openGroup.entry;
    const groupable = !inOpenGroup
      && last
      && opts.group != null
      && last.groupKey != null
      && last.groupKey === String(opts.group)
      && (now - last.at) <= GROUP_WINDOW_MS;

    if (inOpenGroup) {
      this._openGroup.entry.changed = true;
      this._openGroup.entry.at = now;
    } else if (groupable) {
      last.at = now; // продлеваем окно группы
      last.changed = true;
    } else {
      this._pushUndo({
        snapshot: before,
        label,
        groupKey: opts.group == null ? null : String(opts.group),
        at: now,
        changed: true,
        open: false,
      });
    }

    this._redo = [];
    this.revision++;
    this.dirty = true;
    this._validateSelection();
    this._notify({ type: 'change', label });
    return { ok: true, changed: result.changed, created: result.created };
  }

  // Явная транзакция (drag, серия правок ИИ): все правки до endGroup — одна запись undo.
  beginGroup(label = '') {
    if (this._openGroup) this.endGroup(); // вложенность не поддерживаем — закрываем предыдущую
    const entry = {
      snapshot: { ...this.project },
      label: asString(label) || uiText("Группа правок", "Grouped edits"),
      groupKey: `__tx${++this._groupSeq}`,
      at: Date.now(),
      changed: false,
      open: true,
    };
    this._openGroup = { entry };
    this._pushUndo(entry);
  }

  endGroup() {
    const open = this._openGroup;
    if (!open) return;
    this._openGroup = null;
    const entry = open.entry;
    entry.open = false;
    entry.at = Date.now();
    if (!entry.changed) {
      // Ни одной правки не случилось — пустую запись в историю не оставляем.
      const i = this._undo.indexOf(entry);
      if (i >= 0) this._undo.splice(i, 1);
    }
  }

  undo() {
    if (!this._undo.length) return { ok: false, error: uiText("Отменять нечего", "Nothing to undo") };
    if (this._openGroup) this.endGroup();
    const entry = this._undo.pop();
    this._redo.push({
      snapshot: { ...this.project },
      label: entry.label,
      groupKey: null,
      at: Date.now(),
      changed: true,
      open: false,
    });
    this.project = entry.snapshot;
    this.revision++;
    this.dirty = true;
    this._validateSelection();
    this._notify({ type: 'project', label: entry.label });
    return { ok: true, label: entry.label };
  }

  redo() {
    if (!this._redo.length) return { ok: false, error: uiText("Повторять нечего", "Nothing to redo") };
    if (this._openGroup) this.endGroup();
    const entry = this._redo.pop();
    this._undo.push({
      snapshot: { ...this.project },
      label: entry.label,
      groupKey: null,
      at: Date.now(),
      changed: true,
      open: false,
    });
    if (this._undo.length > HISTORY_LIMIT) this._undo.shift();
    this.project = entry.snapshot;
    this.revision++;
    this.dirty = true;
    this._validateSelection();
    this._notify({ type: 'project', label: entry.label });
    return { ok: true, label: entry.label };
  }

  canUndo() { return this._undo.length > 0; }
  canRedo() { return this._redo.length > 0; }

  clearHistory() {
    this._undo = [];
    this._redo = [];
    this._openGroup = null;
  }

  // Замена проекта целиком (открытие файла, новый проект): история сбрасывается.
  setProject(project, opts = {}) {
    if (!isObj(project) || !Array.isArray(project.nodes)) return false;
    this.generation++;
    this.revision++;
    this.documentKey = opts.documentKey || opts.filePath || uid('draft_');
    this.project = this._clone(project);
    this.filePath = typeof opts.filePath === 'string' ? opts.filePath : null;
    this.dirty = opts.dirty === true;
    this.selection = { kind: null, id: null };
    this.clearHistory();
    this._notify({ type: 'project' });
    return true;
  }

  setSelection(sel) {
    const kinds = ['node', 'character', 'location', 'variable', 'chapter'];
    if (isObj(sel) && kinds.includes(sel.kind) && sel.id) {
      this.selection = { kind: sel.kind, id: String(sel.id) };
    } else {
      this.selection = { kind: null, id: null };
    }
    this._notify({ type: 'selection' });
  }

  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    this._subscribers.add(fn);
    return () => { this._subscribers.delete(fn); };
  }

  markSaved(filePath, revision = this.revision) {
    if (typeof filePath === 'string' && filePath) this.filePath = filePath;
    this.dirty = revision !== this.revision;
    if (this._undo.length) this._undo[this._undo.length - 1].groupKey = null;
  }

  snapshot() { return this._clone(this.project); }

  // Восстановление снимка как одной undo-записи («Отменить правки ИИ»).
  restoreSnapshot(snap, label = uiText("Восстановление снимка", "Restore snapshot")) {
    if (!isObj(snap) || !Array.isArray(snap.nodes)) return { ok: false, error: uiText("Некорректный снимок проекта", "Invalid project snapshot") };
    const text = asString(label) || uiText("Восстановление снимка", "Restore snapshot");
    this._pushUndo({
      snapshot: { ...this.project },
      label: text,
      groupKey: null,
      at: Date.now(),
      changed: true,
      open: false,
    });
    this._redo = [];
    this.project = deepClone(snap);
    this.revision++;
    this.dirty = true;
    this._validateSelection();
    this._notify({ type: 'project', label: text });
    return { ok: true };
  }

  newId(prefix = 'n_') { return uniqueId(this.project, prefix); }

  // --- внутреннее ---

  _pushUndo(entry) {
    this._undo.push(entry);
    if (this._undo.length > HISTORY_LIMIT) this._undo.shift();
  }

  _clone(project) { return deepClone(project); }

  // Выбор мог «повиснуть» на удалённом объекте — молча сбрасываем; событие
  // 'change'/'project' само заставит интерфейс перечитать selection.
  _validateSelection() {
    const sel = this.selection;
    if (!isObj(sel) || sel.kind === null || !sel.id) return;
    const collections = {
      node: this.project.nodes,
      character: this.project.characters,
      location: this.project.locations,
      variable: this.project.variables,
      chapter: this.project.chapters,
    };
    const list = collections[sel.kind];
    if (!list || !findEntity(list, sel.id)) this.selection = { kind: null, id: null };
  }

  _notify(evt) {
    for (const fn of [...this._subscribers]) {
      try { fn(evt); } catch (e) { devLog(uiText("ошибка подписчика store:", "subscriber error store:"), e); }
    }
  }
}

export const store = new Store();
