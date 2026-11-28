import test from 'node:test';
import assert from 'node:assert/strict';
import source from '../src/native/rpg-source.cjs';
import {playtestGame} from '../src/js/ai-rpg-inspection.js';
import {createRpgExample} from '../src/js/rpg-example.js';
import {createMap,setMapCell} from '../src/js/rpg-model.js';

const game = createRpgExample();
const step = (action,count=1) => ({action,count});
const reach = eventId => ({action:'reachEvent',eventId});

test('walk the complete key and door quest by event ID in one playtest and compare HUD',()=>{
  const copy = structuredClone(game);
  copy.panels = [{id:'key',position:'top-left',title:'Key',text:'{has_key}'}];
  const result = playtestGame(copy,{steps:[reach('keeper'),step('interact'),step('advance'),
    reach('locked_door'),step('interact'),reach('exit')]});
  assert.equal(result.initialPanels[0].text,'—');
  assert.equal(result.panels[0].text,'true');
  assert.equal(result.variables.has_key,true);
  assert.equal(result.trace[0].action,'up');
  assert.equal(result.trace[0].blockedBy,'actor');
  assert.equal(result.trace[1].eventId,'keeper');
  assert.ok(result.trace[1].dialogue);
  assert.equal(result.trace.at(-2).mapId,'workshop');
  assert.deepEqual([result.trace.at(-1).eventId,result.end.mapId,result.end.x,result.end.y],['exit','garden',10,6]);
});

test('a route avoids foreign triggers, blocking actors and walls, including on sparse negative tiles',()=>{
  const map = createMap('sparse','Sparse');
  for (let y=0;y<=2;y++) for(let x=-3;x<=1;x++) setMapCell(map,x,y,{tile:0});
  map.events = [
    {id:'hazard',name:'Trap',x:-1,y:1,sprite:0,trigger:'touch',code:'say "Wrong path!"'},
    {id:'target',name:'Guide',x:-2,y:1,sprite:0,trigger:'action',code:'say "Hello"'}
  ];
  setMapCell(map,-1,2,{blocked:true});
  const copy = {version:1,maps:[map],start:{mapId:'sparse',x:0,y:1,sprite:0}};
  const result = playtestGame(copy,{steps:[reach('target'),step('interact')]});
  assert.equal(result.end.dialogue,'Hello');
  assert.equal(result.trace.some(r=>r.x===-1 && r.y===1),false);
  assert.equal(result.trace.some(r=>r.x===-1 && r.y===2),false);
  assert.equal(result.trace.length,5);
  setMapCell(map,-1,0,{blocked:true});
  assert.throws(()=>playtestGame(copy,{steps:[reach('target')]}),/No safe route/);
});

test('reachEvent rejects wrong map, pending dialogue, unknown ID and exhausted total input allowance',()=>{
  for (const [steps,reason] of [
    [[reach('exit')],/Unknown event/],
    [[reach('not_here')],/Unknown event/],
    [[reach('keeper'),step('interact'),reach('locked_door')],/dialogue/],
    [[step('up',64),reach('locked_door')],/remaining actions/],
    [[{action:'reachEvent',eventId:'keeper',count:2}],/count 1/],
    [[{action:'reachEvent'}],/eventId/],
  ]) assert.throws(()=>playtestGame(game,{steps}),reason);
  const result = playtestGame(game,{facing:'up',steps:[reach('keeper')]});
  assert.deepEqual(result.trace,[]);
});

test('standing on a touch trigger requires leaving and entering for the script to run',()=>{
  const map = createMap('plate','Plate',2,1);
  map.events = [{id:'plate',name:'Plate',x:0,y:0,sprite:0,trigger:'touch',code:'set clicked = true'}];
  const copy = {version:1,maps:[map],start:{mapId:'plate',x:0,y:0,sprite:0}};
  const result = playtestGame(copy,{steps:[reach('plate')]});
  assert.equal(result.variables.clicked,true);
  assert.deepEqual(result.trace.map(row=>row.action),['right','left']);
});

test('long before and after HUD sections are independently available by page',()=>{
  const copy = structuredClone(game);
  copy.panels = Array.from({length:16},(_,index)=>({id:'panel_'+index,title:'HUD',position:'top-left',text:'x'.repeat(594)+'{key}'}));
  assert.equal(playtestGame(copy).counts.initialPanels,16);
  for (const detail of ['initialPanels','panels']) {
    let offset=0;
    const ids=[];
    do {
      const page=playtestGame(copy,{detail,offset});
      ids.push(...page.items.map(item=>item.id));
      assert.ok(JSON.stringify(page).length<6000);
      offset=page.nextOffset;
    } while(offset!==null);
    assert.deepEqual(ids,copy.panels.map(p=>p.id));
  }
});

test('a long interpolated HUD panel can be fully reassembled inside the chat result limit',()=>{
  const copy = structuredClone(game);
  const value = ('🏕️' + '\n\t"').repeat(110);
  const text = '{story}'.repeat(14);
  copy.panels = [{id:'book',position:'top-left',title:'📕',text}];
  copy.maps[0].events.find(e=>e.id==='keeper').code = 'set story = ' + JSON.stringify(value);
  const steps = [reach('keeper'),step('interact')];
  assert.equal(playtestGame(copy,{steps}).counts.panels,1);
  let offset=0, result='';
  do {
    const page = playtestGame(copy,{steps,detail:'panels',offset});
    assert.ok(JSON.stringify(page).length<6000);
    for (const part of page.items) {
      assert.equal(part.textOffset,result.length);
      assert.equal(part.textLength,value.length*14);
      assert.ok(!/[\uD800-\uDBFF]$/.test(part.text));
      result += part.text;
    }
    offset=page.nextOffset;
  } while(offset!==null);
  assert.equal(result,value.repeat(14));
});
test('engine source catalog resolves every entry in this build and reports real line positions',async()=>{
  const {modules} = await source.readRpgSource();
  for (const {id} of modules) {
    const result = await source.readRpgSource({module:id});
    assert.ok(result.lines.length);
    assert.equal(result.lines[0].line,1);
    if (result.nextOffset!==null) assert.equal((await source.readRpgSource({module:id,offset:result.nextOffset})).lines[0].line,result.nextOffset+1);
  }
  const {lines} = await source.readRpgSource({module:'model',query:'export function interact'});
  assert.equal(lines.length,1);
  assert.match(lines[0].text,/function interact/);
});
test('reject unknown files, filename traversal and invalid offsets',async()=>{
  for (const module of ['../settings.json','constructor','__proto__','/model']) await assert.rejects(source.readRpgSource({module}));
  await assert.rejects(source.readRpgSource({module:'model',offset:-1}));
});
test('cross-module search locates a symbol in the implementation and its callers; common queries paginate',async()=>{
  const found=await source.readRpgSource({query:'firstWalkableCell'});
  for(const id of ['model','editor','inspection']) assert.ok(found.matches.some(match=>match.module===id));
  const first=await source.readRpgSource({query:'return'});
  assert.ok(first.nextOffset>0);
  const second=await source.readRpgSource({query:'return',offset:first.nextOffset});
  const identifiers=result=>result.matches.map(entry=>entry.module+':'+entry.line);
  assert.ok(identifiers(second).every(entry=>!identifiers(first).includes(entry)));
  assert.deepEqual(await source.readRpgSource({query:'missingSymbolInFixture42'}),{matches:[],nextOffset:null});
});
test('the locked door stays closed on a fresh attempt',()=>{
  const result=playtestGame(game,{x:10,y:6,facing:'up',steps:[step('interact')]});
  assert.equal(result.end.mapId,'garden');
  assert.ok(result.end.dialogue);
  assert.deepEqual(result.variables,{});
});
test('play official two-room example from spawn to the keeper, through the door, and back',()=>{
  const before=JSON.stringify(game);
  const result=playtestGame(game,{steps:[step('up'),step('interact'),step('advance'),step('right',5),step('up'),step('interact'),step('down')]});
  assert.equal(result.variables.has_key,true);
  assert.ok(result.trace[1].dialogue);
  assert.deepEqual(result.trace.slice(-2).map(s=>[s.mapId,s.x,s.y]),[['workshop',5,6],['garden',10,6]]);
  assert.equal(before,JSON.stringify(game));
});
test('HUD follows dialogue variables and speed is the saved movement interval',()=>{
  const copy=structuredClone(game);
  copy.walkStepMs=240;
  copy.panels=[{id:'quest',title:'Quest',text:'Key = {has_key}',position:'top-left'}];
  const result=playtestGame(copy,{steps:[step('up'),step('interact'),step('advance')]});
  assert.equal(result.panels[0].text,'Key = true');
  assert.equal(result.stepMs,240);
  assert.equal(playtestGame(copy).panels[0].text,'Key = —');
});
test('isolated play does not spawn in a wall, off-map, inside an actor or with a partial coordinate',()=>{
  for (const options of [{x:0,y:0},{mapId:'missing'},{x:5,y:5},{x:550,y:600},{x:5},{facing:'north'}]) assert.throws(()=>playtestGame(game,options));
  assert.equal(playtestGame(game,{mapId:'workshop'}).start.mapId,'workshop');
});
test('simulation bounds repeated inputs and rejects unknown actions',()=>{
  for (const steps of [[step('right',65)],[step('left',32),step('right',33)],[step('warp')],[step('left',0)]]) assert.throws(()=>playtestGame(game,{steps}));
  assert.equal(playtestGame(game,{steps:[step('right',64)],detail:'trace'}).total,64);
});

test('a one-cell room with a touch event opens like the editor Play command',()=>{
  const copy=structuredClone(game);
  const room=createMap('landing','Landing');
  room.events.push({id:'plate',name:'Pressure plate',x:0,y:0,sprite:0,trigger:'touch',code:'say "Click"'});
  copy.maps.push(room);
  const result=playtestGame(copy,{mapId:'landing'});
  assert.deepEqual([result.start.x,result.start.y,result.start.dialogue],[0,0,null]);
});
