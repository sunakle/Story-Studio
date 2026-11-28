import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/js/model.js';
import { createGame, createMap, parseEvent, setMapCell } from '../src/js/rpg-model.js';
import { describeRpgContext, RPG_ASSISTANT_MANIFEST } from '../src/js/rpg-assistant-guide.js';

function scene() {
  const game = createGame(), room = createMap('library', 'Библиотека', 2, 2);
  const guard = {id:'keeper',name:'Библиотекарь',x:-12,y:4,sprite:218,trigger:'action',code:'say "Книга у меня."'};
  setMapCell(room, guard.x, guard.y, {tile:0});
  room.events.push(guard);
  game.maps.push(room);
  return {game,room,guard,project:{meta:{title:'Тест'},rpgGame:game}};
}

test('camera, NPC, game spawn and current request are individually identified', () => {
  const {game,guard,project} = scene();
  const editor = {mode:'event',zoom:1.5,viewport:{minX:-16,minY:-4,maxX:2,maxY:8},eventTab:'blocks'};
  const origin = {rpgMapId:'library',rpgEventId:'keeper',rpgViewCenter:{x:-12,y:4},rpgEditor:editor,task:'Уточни эту реплику'};
  const ctx = describeRpgContext(project,origin);
  assert.deepEqual(ctx.focus.center,{x:-12,y:4});
  assert.deepEqual(ctx.focus.centerCell,{tile:0,blocked:false,eventId:'keeper'});
  assert.deepEqual(ctx.focus.editor,editor);
  assert.equal(ctx.focus.mapName,'Библиотека');
  assert.equal(ctx.focus.selectedEvent.codePreview,guard.code);
  assert.equal(ctx.focus.task,'Уточни эту реплику');
  assert.deepEqual(ctx.start,game.start);
  assert.notEqual(ctx.focus.mapId,ctx.start.mapId);
});

test('an empty project has a named first-map target and no claimed saved map or selection', () => {
  const ctx = describeRpgContext(new Store().project,{rpgMapId:'map_1'});
  assert.equal(ctx.initialized,false);
  assert.deepEqual(ctx.maps,[]);
  assert.equal(ctx.initialMapId,ctx.focus.mapId);
  assert.equal(ctx.focus.mapName,null);
  assert.equal(ctx.focus.selectedEvent,null);
  assert.equal(ctx.start,null);
  assert.equal(ctx.stepMs,180);
});

test('obsolete focus never resolves to another map or similarly named event', () => {
  const {project,game,room,guard} = scene();
  game.maps[0].events.push({...guard,x:0,y:0});
  for (const origin of [{rpgMapId:'gone',rpgEventId:'keeper'}, {rpgMapId:room.id}, {rpgEventId:'keeper'}]) {
    assert.equal(describeRpgContext(project,origin).focus.selectedEvent,null);
  }
});

test('long event code is bounded and unrelated workspaces, assets and histories stay out of the snapshot', () => {
  const {project,guard} = scene();
  guard.code='say "abc"\n'.repeat(1000);
  Object.assign(project,{screenplay:'PRIVATE_SCREENPLAY',gigmaWorkspaces:['PRIVATE_CANVAS'],aiChat:['PRIVATE_HISTORY']});
  const ctx = describeRpgContext(project,{rpgMapId:'library',rpgEventId:'keeper'});
  assert.equal(ctx.focus.selectedEvent.codePreview.length,350);
  assert.equal(ctx.focus.selectedEvent.codeLength,guard.code.length);
  assert.doesNotMatch(JSON.stringify(ctx),/PRIVATE_/);
});

test('focus survives pagination and reports changed settings and current event source', () => {
  const {project,game,room,guard} = scene();
  game.maps.unshift(...Array.from({length:40}, (_,i) => createMap('page_'+i,'Карта '+i)));
  const origin = {rpgMapId:room.id,rpgEventId:guard.id};
  const before = describeRpgContext(project,origin);
  assert.equal(before.maps.length,30);
  assert.equal(before.mapCount,42);
  assert.equal(before.focus.selectedEvent.name,guard.name);
  game.walkStepMs=240;
  game.panels=[{id:'score',title:'Счёт',text:'{score}',position:'top-right'}];
  guard.code='say "Другая фраза"';
  const after = describeRpgContext(project,origin);
  assert.equal(after.stepMs,240);
  assert.deepEqual(after.panels,[{id:'score',title:'Счёт',position:'top-right'}]);
  assert.notEqual(before.focus.selectedEvent.codePreview,after.focus.selectedEvent.codePreview);
});

test('worked dialogue example in the manifest compiles with the real event parser', () => {
  const source = RPG_ASSISTANT_MANIFEST.match(/^if met_guard == true\n[\s\S]+?^end$/m)?.[0];
  const [branch] = parseEvent(source);
  assert.equal(branch.op,'if');
  assert.equal(branch.key,'met_guard');
  assert.deepEqual(branch.else.map(e=>e.op),['say','set']);
});
