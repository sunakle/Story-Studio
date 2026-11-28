import { t } from './i18n.js';
import { rpgAtlas, rpgDefaults } from './rpg-assets.js';

const identifier = /^[\p{L}_][\p{L}\p{N}_-]{0,63}$/u;
const validId = id => typeof id === 'string' && identifier.test(id) && !['__proto__','constructor','prototype'].includes(id);
const integer = (n, low, high) => Number.isInteger(n) && n >= low && n <= high;
const tileId = id => integer(id, 0, rpgAtlas.count - 1);
const inSeed = (map, x, y) => x >= 0 && x < map.width && y >= 0 && y < map.height;
const indexOf = (map, x, y) => y * map.width + x;
const cellKey = (x, y) => x + ',' + y;
export const validMapCoordinate = n => integer(n, -1_000_000_000, 1_000_000_000);
const maxDepth = 24;
const maxLines = 512;
const gotoInstruction = /^goto\s+(\S+)\s+(-?\d+)\s+(-?\d+)$/u;

function fail(ru, en) { throw new Error(t(ru, en)); }

export const walkTiming = Object.freeze({min:60, max:1000, default:180});
export const hudPositions = Object.freeze(['top-left','top-right','bottom-left','bottom-right']);
export const hudLimits = Object.freeze({count:16, title:80, text:600});

export function gameSettings(game) {
  const {walkStepMs = walkTiming.default, panels = []} = game ?? {};
  return {stepMs:walkStepMs, panels};
}

export function hudText(text, variables) {
  return text.replace(/\{([\p{L}_][\p{L}\p{N}_-]{0,63})\}/gu, (_, key) =>
    validId(key) && Object.hasOwn(variables,key) ? String(variables[key]) : '—');
}

function validateSettings(game) {
  const {stepMs,panels} = gameSettings(game);
  if (!integer(stepMs,walkTiming.min,walkTiming.max))
    fail('Длительность шага должна быть целым числом от 60 до 1000 мс.', 'Step duration must be an integer from 60 to 1000 ms.');
  if (!Array.isArray(panels) || panels.length > hudLimits.count)
    fail('В игре может быть до 16 панелей.', 'A game can have up to 16 panels.');
  const ids = new Set();
  for (const panel of panels) {
    if (!validId(panel?.id) || ids.has(panel.id)) fail('Каждой панели нужен уникальный идентификатор.', 'Each panel needs a unique ID.');
    if (typeof panel.title !== 'string' || !panel.title.trim() || panel.title.length > hudLimits.title)
      fail('Введите заголовок панели длиной до 80 символов.', 'Enter a panel title up to 80 characters.');
    if (typeof panel.text !== 'string' || panel.text.length > hudLimits.text || !hudPositions.includes(panel.position))
      fail('Проверьте угол экрана и текст панели (до 600 символов).', 'Check the screen corner and panel text (up to 600 characters).');
    ids.add(panel.id);
  }
}

// Keep the original rectangle in place, including all its saved tile indices.
// Cells drawn beyond it use absolute coordinates and allocate only painted space.
export function getMapTile(map, x, y) {
  if (!validMapCoordinate(x) || !validMapCoordinate(y)) return null;
  if (inSeed(map, x, y)) return map.tiles[indexOf(map, x, y)];
  return map.cells?.[cellKey(x, y)]?.tile ?? null;
}

export function isMapBlocked(map, x, y, seedWalls) {
  if (inSeed(map, x, y)) {
    const index = indexOf(map, x, y);
    return seedWalls ? seedWalls.has(index) : map.blocked.includes(index);
  }
  return map.cells?.[cellKey(x, y)]?.blocked === true;
}

export function setMapCell(map, x, y, change) {
  if (!validMapCoordinate(x) || !validMapCoordinate(y)) fail('Проверьте координаты клетки.', 'Invalid cell coordinates.');
  const tile = change.tile, blocked = change.blocked;
  if ((tile !== undefined && tile !== null && !tileId(tile)) || (blocked !== undefined && typeof blocked !== 'boolean')) {
    fail('Проверьте тайл и препятствие.', 'Invalid tile or collision flag.');
  }
  const oldTile = getMapTile(map, x, y);
  const newTile = tile === undefined ? oldTile : tile;
  const oldBlocked = isMapBlocked(map, x, y);
  const newBlocked = blocked ?? (tile === null ? false : oldBlocked);
  if (oldTile === newTile && oldBlocked === newBlocked) return false;
  if (inSeed(map, x, y)) {
    const index = indexOf(map, x, y);
    map.tiles[index] = newTile;
    if (oldBlocked && !newBlocked) map.blocked.splice(map.blocked.indexOf(index), 1);
    if (!oldBlocked && newBlocked) map.blocked.push(index);
  } else {
    const key = cellKey(x, y);
    if (newTile !== null || newBlocked) {
      map.cells ??= {};
      map.cells[key] = {...(newTile !== null && {tile:newTile}), ...(newBlocked && {blocked:true})};
    } else {
      delete map.cells[key];
    }
  }
  return true;
}

export function getMapBounds(map) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  forEachMapCell(map,(x,y) => {
    minX = Math.min(minX,x); maxX = Math.max(maxX,x);
    minY = Math.min(minY,y); maxY = Math.max(maxY,y);
  });
  return minX === Infinity ? {minX:0,minY:0,maxX:0,maxY:0} : {minX,minY,maxX,maxY};
}

// Useful for a zoomed-out overview: cost depends on authored cells, not the
// distance between two islands of terrain.
export function forEachMapCell(map, visit) {
  const walls = new Set(map.blocked);
  for (let i = 0; i < map.tiles.length; i++) {
    const tile = map.tiles[i], blocked = walls.has(i);
    if (tile !== null || blocked) visit(i % map.width, Math.floor(i / map.width), tile, blocked);
  }
  for (const key in map.cells) {
    const [x,y] = key.split(',').map(Number);
    const cell = map.cells[key];
    visit(x,y,cell.tile ?? null,cell.blocked === true);
  }
}

export function firstWalkableCell(map, avoidTouch = false) {
  const occupied = new Set(map.events.filter(e => avoidTouch || e.trigger === 'action').map(e => cellKey(e.x,e.y)));
  const walls = new Set(map.blocked);
  for (let i = 0; i < map.tiles.length; i++) {
    const x = i % map.width, y = Math.floor(i / map.width);
    if (map.tiles[i] !== null && !walls.has(i) && !occupied.has(cellKey(x,y))) return {x,y};
  }
  for (const key in map.cells) {
    const cell = map.cells[key];
    if (cell.tile === undefined || cell.blocked || occupied.has(key)) continue;
    const [x,y] = key.split(',').map(Number);
    return {x,y};
  }
  return null;
}
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
    } else if ((match = gotoInstruction.exec(text))) {
      const [, mapId, rawX, rawY] = match;
      const x = Number(rawX), y = Number(rawY);
      if (!validId(mapId) || !validMapCoordinate(x) || !validMapCoordinate(y)) scriptError(line, 'Проверьте идентификатор локации и координаты перехода.', 'Invalid destination map or coordinates.');
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
      else if (b.op === 'goto' && validId(b.mapId) && validMapCoordinate(b.x) && validMapCoordinate(b.y)) lines.push(indent + 'goto ' + b.mapId + ' ' + b.x + ' ' + b.y);
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

export function createMap(id, name, width = 1, height = 1, fill = rpgDefaults.ground) {
  if (!validId(id) || !integer(width, 1, 128) || !integer(height, 1, 128) || !tileId(fill)) fail('Проверьте идентификатор, размеры и покрытие локации.', 'Check the map ID, dimensions and floor tile.');
  return {id, name, width, height, tiles:Array(width * height).fill(fill), blocked:[], events:[]};
}

export function createGame() {
  const map = createMap('map_1', t('Первая локация', 'First location'));
  return {version:1, maps:[map], start:{mapId:map.id, x:Math.floor(map.width / 2), y:Math.floor(map.height / 2), sprite:rpgDefaults.hero}};
}

export function addRpgMap(game, map) {
  game.maps.push(map);
  if (game.maps.length === 1) {
    game.start = {mapId:map.id, x:0, y:0, sprite:game.unplacedHeroSprite ?? rpgDefaults.hero};
    delete game.unplacedHeroSprite;
  }
}

// Mutate the editor/AI transaction's working copy. Preserve the other events,
// including doors with dialogue, as well as the formatting of their scripts.
export function deleteRpgMap(game, mapId) {
  const index = game.maps.findIndex(map => map.id === mapId);
  if (index < 0) fail('Локация уже удалена.', 'The map no longer exists.');
  game.maps.splice(index,1);
  const changes = {removedTransfers:0, newStartMapId:null, addedStartFloor:false};
  for (const map of game.maps) {
    for (const event of map.events) {
      if (!event.code.includes(mapId)) continue;
      const lines = event.code.split(/(\r\n|\r|\n)/);
      for (let i=0; i<lines.length; i+=2) {
        if (gotoInstruction.exec(lines[i].trim())?.[1] === mapId) {
          lines[i] = '';
          if (i+1 < lines.length) lines[i+1] = '';
          changes.removedTransfers++;
        }
      }
      event.code = lines.join('');
    }
  }
  if (game.start?.mapId !== mapId) return changes;
  if (!game.maps.length) {
    game.unplacedHeroSprite = game.start.sprite;
    game.start = null;
    return changes;
  }
  for (const avoidTouch of [true,false]) {
    for (const map of game.maps) {
      const cell = firstWalkableCell(map,avoidTouch);
      if (cell) {
        Object.assign(game.start,{mapId:map.id,...cell});
        changes.newStartMapId = map.id;
        return changes;
      }
    }
  }
  // All painted cells in every room are occupied or blocked. Use a blank
  // cell without moving actors, clearing a wall, or replacing terrain.
  const map = game.maps[0];
  let x = 0;
  while (getMapTile(map,x,0) !== null || isMapBlocked(map,x,0)) x++;
  setMapCell(map,x,0,{tile:rpgDefaults.ground});
  Object.assign(game.start,{mapId:map.id,x,y:0});
  changes.newStartMapId = map.id;
  changes.addedStartFloor = true;
  return changes;
}

function passable(map, x, y) {
  return getMapTile(map, x, y) !== null && !isMapBlocked(map, x, y)
    && !map.events.some(e => e.x === x && e.y === y && e.trigger === 'action');
}

export function validateGame(game) {
  if (game?.version !== 1 || !Array.isArray(game.maps) || game.maps.length > 128) fail('В игре версии 1 может быть до 128 локаций.', 'A version 1 game supports up to 128 maps.');
  validateSettings(game);
  if (!game.maps.length) {
    if (game.start !== null || (game.unplacedHeroSprite !== undefined && !tileId(game.unplacedHeroSprite)))
      fail('Проверьте старт героя в игре без локаций.', 'Invalid player spawn in an empty game.');
    return game;
  }
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
    if (!Array.isArray(map.tiles) || map.tiles.length !== area || !Array.from(map.tiles).every(v => v === null || tileId(v))) fail('Проверьте размеры карты и номера тайлов.', 'Check the map size and tile IDs.');
    if (map.cells !== undefined) {
      const cells = map.cells;
      if (!cells || (Object.getPrototypeOf(cells) !== Object.prototype && Object.getPrototypeOf(cells) !== null)) fail('Повреждены клетки карты.', 'Invalid map cells.');
      for (const key of Object.keys(cells)) {
        const [x,y] = key.split(',').map(Number);
        const cell = cells[key];
        if (!validMapCoordinate(x) || !validMapCoordinate(y) || key !== cellKey(x,y) || inSeed(map,x,y) ||
            !cell || Array.isArray(cell) || typeof cell !== 'object' ||
            (cell.tile !== undefined && !tileId(cell.tile)) || (cell.blocked !== undefined && cell.blocked !== true) ||
            (cell.tile === undefined && cell.blocked !== true) ||
            Object.keys(cell).some(k => k !== 'tile' && k !== 'blocked')) fail('Повреждена клетка карты.', 'Invalid map cell.');
        cellCount++;
      }
    }
    if (cellCount > 1048576) fail('В игре допускается до 1 048 576 заполненных клеток.', 'A game supports up to 1,048,576 stored cells.');
    if (!Array.isArray(map.blocked) || map.blocked.length > area) fail('Некорректный слой препятствий.', 'Invalid collision layer.');
    const blocked = new Set(map.blocked);
    if (blocked.size !== map.blocked.length || !Array.from(blocked).every(index => integer(index, 0, area - 1))) fail('Клетки препятствий должны быть уникальны и находиться внутри карты.', 'Blocked cells must be unique and inside the map.');
    if (!Array.isArray(map.events)) fail('Некорректный список событий.', 'Invalid event list.');
    eventCount += map.events.length;
    if (eventCount > 8192) fail('В игре допускается до 8192 событий.', 'A game supports up to 8192 events.');
    const ids = new Set(), occupied = new Set();
    const actors = new Set();
    maps.set(map.id, {map, blocked, actors});
    for (const e of map.events) {
      if (!validId(e?.id) || ids.has(e.id) || !named(e.name) || !tileId(e.sprite) || getMapTile(map, e.x, e.y) === null || !['action','touch'].includes(e.trigger)) fail('Проверьте имя, спрайт и триггер события. Событие должно стоять на нарисованном тайле.', 'Check the event name, sprite and trigger. Place events on painted terrain.');
      ids.add(e.id);
      const key = cellKey(e.x, e.y);
      if (occupied.has(key)) fail('Здесь уже есть событие.', 'Only one event can occupy a cell.');
      if (e.trigger === 'touch' && isMapBlocked(map,e.x,e.y,blocked)) fail('Триггер входа должен быть на проходимой клетке.', 'A touch event requires a walkable cell.');
      if (e.trigger === 'action') actors.add(key);
      occupied.add(key);
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
    if (!dest || getMapTile(dest.map,point.x,point.y) === null || isMapBlocked(dest.map,point.x,point.y,dest.blocked) || dest.actors.has(cellKey(point.x,point.y))) {
      throw new Error(eventName + ' · ' + t('Точка назначения должна быть на свободной клетке существующей локации.', 'Destination must be a walkable cell on an existing map.'));
    }
  }
  return game;
}

export function startGame(game) {
  validateGame(game);
  if (!game.maps.length) fail('Создайте локацию перед запуском игры.', 'Create a map before playing.');
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
