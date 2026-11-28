import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, createEmptyProject, migrateProject } from '../src/js/model.js';
import { advance, createGame, createMap, formatEvent, interact, move, parseEvent, startGame, validateGame } from '../src/js/rpg-model.js';
import { rpgAtlas, rpgDefaults } from '../src/js/rpg-assets.js';

function courtyard() {
  const yard = createMap('yard', 'Двор', 5, 3);
  const attic = createMap('attic', 'Чердак', 2, 2);
  const npc = {
    id: 'keeper', name: 'Мастер', x: 1, y: 0, sprite: rpgDefaults.npc, trigger: 'action',
    code: 'if Ключ == false\n  say "Держи ключ."\n  set Ключ = true\nelse\n  say "Уже виделись."\nend'
  };
  const door = {
    id: 'stairs', name: 'Лестница', x: 2, y: 1, sprite: rpgDefaults.door, trigger: 'touch',
    code: 'if Ключ == true\n  if замок == false\n    say "Дверь открыта."\n    goto attic 0 0\n  end\nelse\n  say "Заперто."\nend'
  };
  yard.blocked = [0, 5];
  yard.events = [npc, door];
  return {version: 1, maps: [yard, attic], start: {mapId: yard.id, x: 1, y: 1, sprite: rpgDefaults.hero}};
}

test('Event source and nested blocks describe the same typed values', () => {
  const ast = [
    {op: 'set', key: 'день', value: 2},
    {op: 'if', key: 'день', value: 2, then: [
      {op: 'if', key: 'заперт', value: false, then: [{op: 'say', text: 'Он сказал "привет"\n🌙'}], else: [{op: 'goto', mapId: 'улица', x: 5, y: 3}]}
    ], else: [{op: 'set', key: 'глава', value: 'финал'}]}
  ];
  const code = formatEvent(ast);
  assert.deepEqual(parseEvent(code.replaceAll('\n', '\r\n')), ast);
  assert.equal(formatEvent(parseEvent(code)), code);
  assert.deepEqual(parseEvent('  \n'), []);
  for (const invalid of ['say 12', 'end', 'else', 'set __proto__ = true', 'set x = {}', 'if ok = true', 'say "текст" + 1', 'goto map_1 -1 2', 'if ok == false\nelse\nelse\nend']) {
    assert.throws(() => parseEvent(invalid));
  }
  assert.throws(() => parseEvent('say "Начало"\nif x == 3'), /2/);
  assert.throws(() => formatEvent([{op: 'set', key: 'a\nsay "text"', value: true}]));
});

test('Walking, action facing, touch, pauses and cross-map transfers run completely offline', () => {
  const game = courtyard();
  const state = startGame(game);
  move(game, state, -1, 0);
  assert.equal(state.x, 1, 'wall blocks movement');
  move(game, state, 1, 0);
  assert.equal(state.dialogue, 'Заперто.');
  move(game, state, 1, 0);
  assert.equal(state.x, 2, 'dialogue pauses movement');
  advance(game, state);
  move(game, state, -1, 0);
  move(game, state, 0, -1);
  assert.equal(state.y, 1, 'actors can be faced but occupy their tile');
  interact(game, state);
  assert.equal(state.dialogue, 'Держи ключ.');
  assert.equal(state.vars.Ключ, undefined);
  advance(game, state);
  assert.equal(state.vars.Ключ, true);
  interact(game, state);
  assert.equal(state.dialogue, 'Уже виделись.');
  advance(game, state);
  move(game, state, 1, 0);
  assert.equal(state.dialogue, 'Дверь открыта.');
  assert.equal(state.mapId, 'yard');
  advance(game, state);
  assert.deepEqual([state.mapId, state.x, state.y], ['attic', 0, 0]);
  assert.equal(state.vars.Ключ, true);
  assert.equal(startGame(game).vars.Ключ, undefined, 'playtest starts clean');
});

test('World validation catches unreachable starts, bad tiles, broken transfers and invalid code', () => {
  validateGame(createGame());
  for (const breakGame of [
    g => { g.start.x = 0; },
    g => { g.start.y = 0; },
    g => { g.maps[0].tiles[0] = rpgAtlas.count; },
    g => { delete g.maps[0].tiles[0]; },
    g => { g.maps[0].events[0].code = 'if x == true\ngoto missing 0 0\nend'; },
    g => { g.maps[0].events[0].code = 'goto yard 0 0'; },
    g => { g.maps[0].events[0].code = 'set flag ='; },
    g => { g.maps[0].blocked.push(7); },
    g => { g.maps[0].events.push({...g.maps[0].events[0], id: 'other'}); },
    g => { g.maps[1].id = 'yard'; }
  ]) {
    const game = courtyard();
    breakGame(game);
    assert.throws(() => validateGame(game));
  }
});

test('Project edits detach externally supplied games, survive reopening, and undo as a single change', () => {
  const legacy = createEmptyProject();
  delete legacy.rpgGame;
  const store = new Store();
  store.setProject(migrateProject(legacy).project);
  assert.equal(store.project.rpgGame, null);
  const game = courtyard();
  assert.ok(store.apply([{op: 'setRpgGame', game}, {op: 'setScreenplay', text: 'Глава 1'}]).ok);
  const savedTile = game.maps[0].tiles[0];
  game.maps[0].tiles[0] = (savedTile + 1) % rpgAtlas.count;
  assert.equal(store.project.rpgGame.maps[0].tiles[0], savedTile);
  assert.deepEqual(migrateProject(JSON.parse(JSON.stringify(store.project))).project.rpgGame, courtyard());
  const revision = store.revision;
  assert.ok(store.apply({op: 'setRpgGame', game: courtyard()}).ok);
  assert.equal(store.revision, revision);
  const invalidGame = courtyard();
  invalidGame.maps[0].events[0].code = 'goto nonexistent 0 0';
  assert.equal(store.apply([{op: 'setScreenplay', text: 'Черновик'}, {op: 'setRpgGame', game: invalidGame}]).ok, false);
  assert.equal(store.project.screenplay, 'Глава 1');
  assert.equal(store.project.rpgGame.maps[0].events[0].name, 'Мастер');
  assert.ok(store.undo().ok);
  assert.equal(store.project.rpgGame, null);
  assert.equal(store.project.screenplay, '');
  assert.ok(store.redo().ok);
  assert.deepEqual(store.project.rpgGame, courtyard());
  assert.equal(store.project.screenplay, 'Глава 1');
});
