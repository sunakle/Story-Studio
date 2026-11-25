import { t } from './i18n.js';
import { autoLayout, NODE_TYPES, nodeCardHeight, outgoingEdges, parseCondition, uid } from './model.js';

function fail(ru, en) {
  throw new Error(t(ru, en));
}

export function readScreenplay(text, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) {
    fail('Неверное смещение текста.', 'Invalid screenplay offset.');
  }
  // Leave enough room for JSON escaping and metadata in a tool response.
  let end = Math.min(text.length, offset + 4000);
  while (JSON.stringify(text.slice(offset, end)).length > 5400) {
    end = offset + Math.floor((end - offset) * 0.8);
  }
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
  return { offset, nextOffset: end < text.length ? end : null, length: text.length, text: text.slice(offset, end) };
}

export function editScreenplay(current, { mode, find, text }) {
  if (typeof text !== 'string') fail('Требуется текст.', 'Text is required.');
  if (mode === 'append') return current + text;
  if (mode !== 'replace' || typeof find !== 'string' || !find) {
    fail('Для замены укажите точный исходный фрагмент.', 'Provide the exact original passage to replace.');
  }
  const start = current.indexOf(find);
  if (start < 0 || current.indexOf(find, start + 1) >= 0) {
    fail('Фрагмент не найден или встречается несколько раз. Уточните цитату.', 'Passage missing or ambiguous. Supply a unique excerpt.');
  }
  return current.slice(0, start) + text + current.slice(start + find.length);
}

// Generate real IDs before resolving edges so choices may reference later scenes.
export function planStoryGraph(project, { nodes: entries, after, chapter }) {
  if (!Array.isArray(entries) || !entries.length) fail('Нужен список узлов.', 'Provide an ordered list of nodes.');
  const existing = new Map(project.nodes.map(node => [node.id, node]));
  const ids = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.key !== 'string' || !/^[\p{L}\p{N}_-]{1,80}$/u.test(entry.key) || !NODE_TYPES.includes(entry.type)) {
      fail('Проверьте ключ и тип узла.', 'Invalid node key or type.');
    }
    const id = 'n_script_' + entry.key;
    if (ids.has(entry.key) || existing.has(id) || existing.has(entry.key)) {
      fail('Ключ занят, измените существующий узел или выберите другой ключ: ' + entry.key,
        'Key exists, update the existing node or choose another key: ' + entry.key);
    }
    ids.set(entry.key, id);
  }
  function target(value) {
    if (ids.has(value)) return ids.get(value);
    if (existing.has(value)) return value;
    fail('Целевой узел не найден: ' + value, 'Unknown target node: ' + value);
  }
  const anchor = after && existing.get(after);
  if (after && (!anchor || !['scene', 'line', 'jump'].includes(anchor.type) || anchor.next)) {
    fail('Для продолжения нужен существующий узел со свободным переходом.', 'Continue from an existing node with an unused next link.');
  }
  const ops = [];
  function entityLookup(records, op, field, prefix) {
    const all = records.slice();
    return nameOrId => {
      if (!nameOrId) return '';
      if (typeof nameOrId !== 'string' || !nameOrId.trim()) fail('Ожидается имя или ID.', 'Expected a name or ID.');
      const name = nameOrId.trim();
      const exact = all.find(record => record.id === name);
      if (exact) return exact.id;
      const matches = all.filter(record => record.name.trim().toLowerCase() === name.toLowerCase());
      if (matches.length > 1) fail('Уточните ID для «' + name + '».', 'Specify the ID for “' + name + '”.');
      if (matches.length) return matches[0].id;
      const record = { id: uid(prefix), name };
      all.push(record);
      ops.push({ op, [field]: record });
      return record.id;
    };
  }
  const characterId = entityLookup(project.characters, 'createCharacter', 'character', 'c_');
  const locationId = entityLookup(project.locations, 'createLocation', 'location', 'l_');
  const chapterId = entityLookup(project.chapters, 'createChapter', 'chapter', 'ch_');
  const defaultChapter = chapter || anchor?.chapterId || project.chapters[0]?.id;
  const variables = new Set(project.variables.map(variable => variable.name));
  function checkedCondition(expression = '') {
    const parsed = parseCondition(expression);
    if (!parsed.ok) throw new Error(parsed.error);
    const missing = parsed.names.find(name => !variables.has(name));
    if (missing) fail('Сначала создайте переменную ' + missing, 'Create the variable first: ' + missing);
    return expression;
  }
  const following = [];
  let nextPlayable = '';
  for (let i = entries.length - 1; i >= 0; i--) {
    following[i] = nextPlayable;
    if (entries[i].type !== 'note') nextPlayable = ids.get(entries[i].key);
  }
  const created = entries.map((entry, index) => {
    const node = {
      id: ids.get(entry.key), type: entry.type, text: entry.text || '', title: entry.title || '',
      speakerId: characterId(entry.speaker), locationId: locationId(entry.location),
      chapterId: chapterId(entry.chapter || defaultChapter), emotion: entry.emotion || '',
    };
    if (!node.text && !node.title && ['scene', 'line', 'note'].includes(node.type)) {
      fail('Добавьте текст или название узла: ' + entry.key, 'Supply text or a title for: ' + entry.key);
    }
    if ((entry.type !== 'choice' && entry.choices?.length) || (entry.type !== 'condition' && entry.branches?.length)) {
      fail('Тип узла не соответствует переходам.', 'Node type does not match its links.');
    }
    if (entry.type === 'choice') {
      if (!Array.isArray(entry.choices) || !entry.choices.length || entry.next) {
        fail('Укажите варианты выбора и их цели.', 'Specify choice options and their targets.');
      }
      node.choices = entry.choices.map(choice => {
        if (!choice || typeof choice.text !== 'string' || !choice.text.trim()) fail('Варианту нужен текст.', 'Choice option needs text.');
        return { id: uid('o_'), text: choice.text, next: target(choice.to), condition: checkedCondition(choice.condition) };
      });
    } else if (entry.type === 'condition') {
      if (!Array.isArray(entry.branches) || !entry.branches.length) fail('Укажите условные ветки.', 'Specify conditional branches.');
      node.branches = entry.branches.map(branch => ({ id: uid('b_'), condition: checkedCondition(branch.condition), next: target(branch.to) }));
      if (entry.next) node.next = target(entry.next);
    } else if (entry.type === 'end' || entry.type === 'note') {
      if (entry.next) fail('У заметок и концовок нет перехода.', 'Notes and endings do not have a next link.');
    } else if (entry.next !== undefined) {
      node.next = entry.next ? target(entry.next) : '';
    } else {
      node.next = following[index];
    }
    return node;
  });
  const first = created.find(node => node.type !== 'note');
  if (!first) fail('Нужен хотя бы один игровой узел.', 'Include a playable node.');
  const section = { nodes: created, startNodeId: first.id };
  const newIds = new Set(ids.values());
  const reached = new Set([first.id]);
  for (const id of reached) {
    for (const edge of outgoingEdges(section, id)) {
      if (newIds.has(edge.to)) reached.add(edge.to);
    }
  }
  for (const node of created) {
    if (node.type !== 'note' && !reached.has(node.id)) fail('Нет пути к узлу ' + node.id, 'No route to node ' + node.id);
  }

  const { positions } = autoLayout(section);
  const offsetX = anchor ? project.nodes.reduce((x,n) => Math.max(x,n.position.x + 360),anchor.position.x) : 0;
  const offsetY = anchor ? anchor.position.y : project.nodes.reduce((y,n) => Math.max(y,n.position.y + nodeCardHeight(n) + 100),0);
  for (const node of created) {
    const spot = positions[node.id];
    node.position = { x: offsetX + spot.x, y: offsetY + spot.y };
    ops.push({ op: 'createNode', node });
  }
  if (anchor) ops.push({ op: 'connect', from: anchor.id, to: first.id });
  const last = created.filter(node => node.type !== 'note').at(-1);
  const result = { count: created.length, first: first.id, last: last.id };
  const named = Object.fromEntries(ids);
  if (JSON.stringify(named).length < 5000) result.ids = named;
  else result.idPrefix = 'n_script_';
  return { ops, result };
}
