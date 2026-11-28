import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, createEmptyProject, migrateProject } from '../src/js/model.js';
import { advance, createGame, createMap, firstWalkableCell, forEachMapCell, formatEvent, getMapBounds, getMapTile, interact, isMapBlocked, move, parseEvent, setMapCell, startGame, validateGame } from '../src/js/rpg-model.js';
import { rpgAtlas, rpgDefaults } from '../src/js/rpg-assets.js';
import { gameSettings, hudText } from '../src/js/rpg-model.js';

test('Existing projects keep their cadence, and HUD substitutions are plain scalar text', () => {
  const game = createGame();
  assert.deepEqual(gameSettings(game),{stepMs:180,panels:[]});
  assert.equal(Object.hasOwn(validateGame(game),'panels'),false);
  const vars = Object.assign(Object.create({absent:77}),{score:0,'идёт':false,key:'<img>'});
  assert.equal(hudText('{score} {идёт} {key} {absent} {constructor}',vars),'0 false <img> — —');
  assert.equal(hudText('{score + 1}',vars),'{score + 1}');
});

test('Game settings validate speed, HUD positions, IDs, sizes and older project saves', () => {
  const game = createGame();
  const hud = {id:'quest',title:'Ключ',position:'top-right',text:'{ключ}'};
  for (const ms of [60,180,1000]) assert.equal(validateGame({...game,walkStepMs:ms}).walkStepMs,ms);
  for (const ms of [null,'180',59,1001,120.5]) assert.throws(() => validateGame({...game,walkStepMs:ms}));
  for (const panels of [null,{},[hud,hud],[{...hud,title:' '}],[{...hud,text:'x'.repeat(601)}],[{...hud,position:'center'}],
    [{...hud,id:'constructor'}],Array.from({length:17},(_,i)=>({...hud,id:'hud_'+i}))]) {
    assert.throws(() => validateGame({...game,panels}));
  }
  const store = new Store();
  assert.ok(store.apply({op:'setRpgGame',game:{...game,panels:[hud],walkStepMs:80}}).ok);
  const reopened = migrateProject(JSON.parse(JSON.stringify(store.project))).project;
  assert.deepEqual(gameSettings(reopened.rpgGame),{stepMs:80,panels:[hud]});
});

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
  for (const invalid of ['say 12', 'end', 'else', 'set __proto__ = true', 'set x = {}', 'if ok = true', 'say "текст" + 1', 'goto map_1 -1.5 2', 'if ok == false\nelse\nelse\nend']) {
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

test('Legacy courtyard expands in every direction while preserving old indices and door scripts', () => {
  const game = courtyard();
  const yard = game.maps[0];
  const oldTiles = [...yard.tiles], oldWalls = [...yard.blocked], oldEvents = structuredClone(yard.events);
  const dist = 2_000_000;
  for (const [x,y] of [[-1,0],[0,-1],[5,0],[0,3],[dist,-dist],[dist+1,-dist]]) {
    assert.equal(setMapCell(yard,x,y,{tile:rpgDefaults.path}),true);
    assert.equal(getMapTile(yard,x,y),rpgDefaults.path);
    assert.equal(setMapCell(yard,x,y,{tile:rpgDefaults.path}),false);
  }
  assert.equal(getMapTile(yard,-1,1),null);
  assert.deepEqual(yard.tiles,oldTiles);
  assert.deepEqual(yard.blocked,oldWalls);
  assert.deepEqual(yard.events,oldEvents);
  assert.deepEqual(getMapBounds(yard),{minX:-1,minY:-dist,maxX:dist+1,maxY:3});
  assert.equal(Object.keys(yard.cells).length,6);
  const read=[];
  forEachMapCell(yard,(x,y,tile,blocked)=>read.push([x,y,tile,blocked]));
  assert.equal(read.length,21);
  assert.ok(JSON.stringify(game).length < 2000);
  const store = new Store();
  assert.ok(store.apply({op:'setRpgGame',game}).ok);
  const extra = structuredClone(game);
  setMapCell(extra.maps[0],-5,-6,{tile:rpgDefaults.path,blocked:true});
  assert.ok(store.apply({op:'setRpgGame',game:extra}).ok);
  store.undo();
  assert.deepEqual(store.project.rpgGame,game);
  store.redo();
  assert.deepEqual(migrateProject(JSON.parse(JSON.stringify(store.project))).project.rpgGame,extra);
});

test('all tile IDs from the 1.8.1 tileset survive reopening with their original map and event references', () => {
  const fixture = createEmptyProject();
  // Fixed numeric IDs are the file format used by previously saved games.
  const map = {id:'old_map',name:'Old map',width:12,height:23,
    tiles:Array.from({length:276},(_,i)=>i),blocked:[126],
    cells:{'-8,6':{tile:264}},events:[{id:'gate',name:'Door',x:1,y:0,sprite:85,trigger:'action',code:'goto old_map -8 6'}]};
  fixture.rpgGame = {version:1,maps:[map],start:{mapId:map.id,x:0,y:0,sprite:230}};
  const {project} = migrateProject(JSON.parse(JSON.stringify(fixture)));
  assert.deepEqual(project.rpgGame,fixture.rpgGame);
  const actor = startGame(project.rpgGame);
  move(project.rpgGame,actor,1,0);
  interact(project.rpgGame,actor);
  assert.deepEqual([actor.x,actor.y,actor.sprite],[-8,6,230]);
});

test('Signed transfers, collisions and events share the same sparse coordinates as the editor', () => {
  const game = createGame(), map = game.maps[0];
  assert.equal(map.tiles.length,1);
  setMapCell(map,-1,0,{tile:rpgDefaults.path});
  setMapCell(map,-3000,27000,{tile:rpgDefaults.ground});
  setMapCell(map,-3000,26999,{tile:rpgDefaults.wall,blocked:true});
  const back = formatEvent([{op:'goto',mapId:map.id,x:-3000,y:27000}]);
  assert.deepEqual(parseEvent(back),[{op:'goto',mapId:map.id,x:-3000,y:27000}]);
  map.events.push({id:'bridge',name:'Bridge',x:-1,y:0,sprite:rpgDefaults.door,trigger:'touch',code:back});
  const state=startGame(game);
  move(game,state,0,1);
  assert.deepEqual([state.x,state.y],[0,0]);
  move(game,state,-1,0);
  assert.deepEqual([state.x,state.y],[-3000,27000]);
  move(game,state,0,-1);
  assert.deepEqual([state.x,state.y],[-3000,27000]);
  assert.ok(isMapBlocked(map,-3000,26999));
  assert.ok(!isMapBlocked(map,-1,26999));

  setMapCell(map,0,0,{tile:null});
  assert.deepEqual(getMapBounds(map),{minX:-3000,minY:0,maxX:-1,maxY:27000});
  assert.deepEqual(firstWalkableCell(map,true),{x:-3000,y:27000});
  assert.throws(()=>validateGame(game));
  Object.assign(game.start,{x:-3000,y:27000});
  validateGame(game);
  setMapCell(map,-3000,26999,{tile:null});
  assert.equal(map.cells['-3000,26999'],undefined);
  assert.equal(getMapTile(map,-3000,26999),null);
});

test('Sparse cells reject malformed coordinates and preserve distinct event positions', () => {
  for (const [key,cell] of [['0,0',{tile:0}],['-0,1',{tile:0}],['1,2,3',{tile:0}],['99999999999,0',{tile:0}],['3,5',{}],['7,5',{tile:-1}],['0,-1',{blocked:1}]]) {
    const game = createGame();
    game.maps[0].cells = {[key]:cell};
    assert.throws(() => validateGame(game));
  }
  const game = courtyard(), yard = game.maps[0];
  setMapCell(yard,-4,1,{tile:rpgDefaults.ground});
  // A row-major index would alias (-4,1) and the original actor at (1,0).
  yard.events.push({...yard.events[0],id:'second_actor',x:-4,y:1});
  validateGame(game);
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
