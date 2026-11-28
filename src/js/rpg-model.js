import { t } from './i18n.js';
import { rpgAtlas, rpgDefaults } from './rpg-assets.js';

const identifier = /^[\p{L}_][\p{L}\p{N}_-]{0,63}$/u;
const validId = id => typeof id === 'string' && identifier.test(id) && !['__proto__','constructor','prototype'].includes(id);
const integer = (n, low, high) => Number.isInteger(n) && n >= low && n <= high;
const tileId = id => integer(id, 0, rpgAtlas.count - 1);
const inBounds = (map, x, y) => integer(x, 0, map.width - 1) && integer(y, 0, map.height - 1);
const indexOf = (map, x, y) => y * map.width + x;
const maxDepth = 24;
const maxLines = 512;

function fail(ru, en) { throw new Error(t(ru, en)); }
function scriptError(line, ru, en) {
  throw new Error(t('Строка ', 'Line ') + line + ' · ' + t(ru, en));
}

function scalar(value) {
  return typeof value === 'boolean' || Number.isFinite(value) || (typeof value === 'string' && value.length <= 4096);
}

function literal(source, line) {
  try {
    const value = JSON.parse(source);
    if (scalar(value)) return value;
  } catch { /* Show a DSL error with the original line number. */ }
  scriptError(line, 'Ожидается число, true, false или строка в двойных кавычках.', 'Use a number, true, false or a double-quoted string.');
}

export function parseEvent(source) {
  if (typeof source !== 'string' || source.length > 32768) fail('Код события должен быть текстом до 32 768 символов.', 'Event code must be text of at most 32,768 characters.');
  const lines = source.split(/\r\n|[\r\n]/);
  if (lines.length > maxLines) fail('В событии допускается до 512 строк.', 'Events support up to 512 lines.');
  const program = [], stack = [];
  let body = program;
  for (let i = 0; i < lines.length; i++) {
    const line = i + 1, text = lines[i].trim();
    if (!text) continue;
    let match;
    if ((match = /^say\s+(.+)$/u.exec(text))) {
      const value = literal(match[1], line);
      if (typeof value !== 'string') scriptError(line, 'Реплика должна быть строкой.', 'A dialogue line must be a string.');
      body.push({op:'say', text:value});
    } else if ((match = /^(if|set)\s+([^\s=]+)\s*(==|=)\s*(.+)$/u.exec(text))) {
      const [, op, key, operator, raw] = match;
      if (!validId(key)) scriptError(line, 'Проверьте имя переменной.', 'Invalid variable name.');
      if (operator !== (op === 'if' ? '==' : '=')) scriptError(line, 'Используйте == для условия и = для присваивания.', 'Use == for tests and = for assignments.');
      const value = literal(raw, line);
      if (op === 'set') body.push({op, key, value});
      else {
        if (stack.length >= maxDepth) scriptError(line, 'Слишком много вложенных условий.', 'Too many nested conditions.');
        const block = {op, key, value, then:[], else:[]};
        body.push(block);
        stack.push({block, parent:body, line});
        body = block.then;
      }
    } else if (text === 'else') {
      const current = stack.at(-1);
      if (!current || body === current.block.else) scriptError(line, 'Лишний else.', 'Unexpected else.');
      body = current.block.else;
    } else if (text === 'end') {
      if (!stack.length) scriptError(line, 'Лишний end.', 'Unexpected end.');
      body = stack.pop().parent;
    } else if ((match = /^goto\s+(\S+)\s+(\d+)\s+(\d+)$/u.exec(text))) {
      const [, mapId, rawX, rawY] = match;
      const x = Number(rawX), y = Number(rawY);
      if (!validId(mapId) || !integer(x, 0, 127) || !integer(y, 0, 127)) scriptError(line, 'Проверьте идентификатор локации и координаты перехода.', 'Invalid destination map or coordinates.');
      body.push({op:'goto', mapId, x, y});
    } else scriptError(line, 'Ожидается say, set, if, else, end или goto.', 'Expected say, set, if, else, end or goto.');
  }
  if (stack.length) scriptError(stack.at(-1).line, 'Закройте условие командой end.', 'Close the condition with end.');
  return program;
}

// The blocks use the same grammar as hand-written code. Validate before turning
// strings into source, so a malformed block cannot insert another instruction.
export function formatEvent(program) {
  const lines = [];
  function emit(blocks, depth) {
    if (!Array.isArray(blocks) || depth > maxDepth) fail('Некорректная группа блоков.', 'Invalid block group.');
    const indent = '  '.repeat(depth);
    for (const b of blocks) {
      if (lines.length >= maxLines || !b) fail('Некорректное событие или слишком много команд.', 'Invalid event or too many instructions.');
      if (b.op === 'say' && typeof b.text === 'string' && scalar(b.text)) lines.push(indent + 'say ' + JSON.stringify(b.text));
      else if (b.op === 'set' && validId(b.key) && scalar(b.value)) lines.push(indent + 'set ' + b.key + ' = ' + JSON.stringify(b.value));
      else if (b.op === 'goto' && validId(b.mapId) && integer(b.x, 0, 127) && integer(b.y, 0, 127)) lines.push(indent + 'goto ' + b.mapId + ' ' + b.x + ' ' + b.y);
      else if (b.op === 'if' && validId(b.key) && scalar(b.value) && Array.isArray(b.else)) {
        lines.push(indent + 'if ' + b.key + ' == ' + JSON.stringify(b.value));
        emit(b.then, depth + 1);
        if (b.else.length) { lines.push(indent + 'else'); emit(b.else, depth + 1); }
        lines.push(indent + 'end');
      } else fail('Проверьте поля блока события.', 'Check the fields in this event block.');
    }
  }
  emit(program, 0);
  const result = lines.join('\n');
  if (lines.length > maxLines || result.length > 32768) fail('Событие слишком длинное.', 'Event is too long.');
  return result;
}

export function createMap(id, name, width = 16, height = 12, fill = rpgDefaults.ground) {
  if (!validId(id) || !integer(width, 1, 128) || !integer(height, 1, 128) || !tileId(fill)) fail('Проверьте идентификатор, размеры и покрытие локации.', 'Check the map ID, dimensions and floor tile.');
  return {id, name, width, height, tiles:Array(width * height).fill(fill), blocked:[], events:[]};
}

export function createGame() {
  const map = createMap('map_1', t('Первая локация', 'First location'));
  return {version:1, maps:[map], start:{mapId:map.id, x:Math.floor(map.width / 2), y:Math.floor(map.height / 2), sprite:rpgDefaults.hero}};
}

function passable(map, x, y) {
  return inBounds(map, x, y) && !map.blocked.includes(indexOf(map, x, y))
    && !map.events.some(e => e.x === x && e.y === y && e.trigger === 'action');
}

export function validateGame(game) {
  if (game?.version !== 1 || !Array.isArray(game.maps) || !integer(game.maps.length, 1, 128)) fail('Игра должна содержать от 1 до 128 локаций версии 1.', 'A version 1 game must contain 1–128 maps.');
  const maps = new Map(), destinations = [];
  let cellCount = 0, eventCount = 0, codeSize = 0;
  const named = name => typeof name === 'string' && name.trim().length > 0 && name.length <= 160;
  function collect(blocks, eventName) {
    for (const block of blocks) {
      if (block.op === 'goto') destinations.push({point:block, eventName});
      if (block.op === 'if') { collect(block.then, eventName); collect(block.else, eventName); }
    }
  }
  for (const map of game.maps) {
    if (!validId(map?.id) || maps.has(map.id) || !named(map.name)) fail('Проверьте название и уникальный идентификатор локации.', 'Each map needs a name and a unique ID.');
    if (!integer(map.width, 1, 128) || !integer(map.height, 1, 128)) fail('Размеры карты должны быть от 1 до 128 клеток.', 'Map dimensions must be between 1 and 128.');
    const area = map.width * map.height;
    cellCount += area;
    if (cellCount > 1048576 || !Array.isArray(map.tiles) || map.tiles.length !== area || !Array.from(map.tiles).every(tileId)) fail('Проверьте размеры карты и номера тайлов.', 'Check the map size and tile IDs.');
    if (!Array.isArray(map.blocked) || map.blocked.length > area) fail('Некорректный слой препятствий.', 'Invalid collision layer.');
    const blocked = new Set(map.blocked);
    maps.set(map.id, {map, blocked});
    if (blocked.size !== map.blocked.length || !Array.from(blocked).every(index => integer(index, 0, area - 1))) fail('Клетки препятствий должны быть уникальны и находиться внутри карты.', 'Blocked cells must be unique and inside the map.');
    if (!Array.isArray(map.events)) fail('Некорректный список событий.', 'Invalid event list.');
    eventCount += map.events.length;
    if (eventCount > 8192) fail('В игре допускается до 8192 событий.', 'A game supports up to 8192 events.');
    const ids = new Set(), occupied = new Set();
    for (const e of map.events) {
      if (!validId(e?.id) || ids.has(e.id) || !named(e.name) || !tileId(e.sprite) || !inBounds(map, e.x, e.y) || !['action','touch'].includes(e.trigger)) fail('Проверьте название, идентификатор, спрайт, клетку и триггер события.', 'Check the event name, ID, sprite, position and trigger.');
      ids.add(e.id);
      const index = indexOf(map, e.x, e.y);
      if (occupied.has(index)) fail('Здесь уже есть событие.', 'Only one event can occupy a cell.');
      if (e.trigger === 'touch' && blocked.has(index)) fail('Триггер входа должен быть на проходимой клетке.', 'A touch event requires a walkable cell.');
      if (e.trigger === 'action') blocked.add(index);
      occupied.add(index);
      if (typeof e.code !== 'string') fail('Код события должен быть текстом.', 'Event code must be text.');
      codeSize += e.code.length;
      if (codeSize > 4194304) fail('Превышен общий объём кода событий.', 'Event code exceeds the total size limit.');
      try { collect(parseEvent(e.code), e.name); }
      catch (err) { throw new Error(map.name + ' / ' + e.name + ' · ' + err.message); }
    }
  }
  if (!tileId(game.start?.sprite)) fail('Проверьте спрайт игрока.', 'Invalid player sprite.');
  destinations.push({point:game.start, eventName:t('Старт игрока', 'Player start')});
  for (const {point, eventName} of destinations) {
    const dest = maps.get(point.mapId);
    if (!dest || !inBounds(dest.map, point.x, point.y) || dest.blocked.has(indexOf(dest.map, point.x, point.y))) {
      throw new Error(eventName + ' · ' + t('Точка назначения должна быть на свободной клетке существующей локации.', 'Destination must be a walkable cell on an existing map.'));
    }
  }
  return game;
}

export function startGame(game) {
  validateGame(game);
  return {...game.start, facing:{dx:0,dy:1}, vars:Object.create(null), dialogue:null, pending:[]};
}

function run(state) {
  while (state.pending.length) {
    const b = state.pending.pop();
    if (b.op === 'say' && b.text.length) {
      state.dialogue = b.text;
      break;
    }
    if (b.op === 'set') state.vars[b.key] = b.value;
    if (b.op === 'goto') Object.assign(state, {mapId:b.mapId, x:b.x, y:b.y});
    if (b.op === 'if') {
      const value = Object.hasOwn(state.vars, b.key) ? state.vars[b.key] : false;
      state.pending.push(...[...(value === b.value ? b.then : b.else)].reverse());
    }
  }
  return state;
}

function fireEvent(state, event) {
  if (event) { state.pending = parseEvent(event.code).reverse(); run(state); }
  return state;
}

export function move(game, state, dx, dy) {
  if (state.dialogue !== null || !Number.isInteger(dx) || !Number.isInteger(dy) || Math.abs(dx) + Math.abs(dy) !== 1) return state;
  state.facing = {dx, dy};
  const map = game.maps.find(m => m.id === state.mapId);
  const x = state.x + dx, y = state.y + dy;
  if (!passable(map, x, y)) return state;
  state.x = x; state.y = y;
  return fireEvent(state, map.events.find(e => e.x === x && e.y === y && e.trigger === 'touch'));
}

export function interact(game, state) {
  if (state.dialogue !== null) return advance(game, state);
  const map = game.maps.find(m => m.id === state.mapId);
  const x = state.x + state.facing.dx, y = state.y + state.facing.dy;
  return fireEvent(state, map.events.find(e => e.x === x && e.y === y && e.trigger === 'action'));
}

export function advance(_game, state) {
  if (state.dialogue !== null) { state.dialogue = null; run(state); }
  return state;
}
