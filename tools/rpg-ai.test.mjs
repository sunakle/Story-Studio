import test from 'node:test';
import assert from 'node:assert/strict';
import { createAI } from '../src/js/ai.js';
import { Store } from '../src/js/model.js';
import { createRpgExample } from '../src/js/rpg-example.js';
import { getMapTile, interact, isMapBlocked, move, startGame } from '../src/js/rpg-model.js';

function fixture(respond) {
  const store = new Store();
  const game = createRpgExample();
  assert.equal(store.apply({op:'setRpgGame',game}).ok,true);
  let turns = 0;
  globalThis.window = {sf:{ai:{abort(){},async chat({body}) {
    const last = body.messages.filter(m => m.role==='tool').at(-1);
    return respond(turns++,last ? JSON.parse(last.content) : null, body, store);
  }},history:{read:() => [],write:() => {}}}};
  const app = createAI({root:null,store,scope:'rpg',ui:{escapeHTML:String,settings:{ai:{baseUrl:'http://localhost/v1',model:'fixture'}},
    workbench:{current:()=>'rpg',navigationRevision:()=>0,flushDesigns:()=>true,
      assistantContext:()=>({surface:'sidebar',view:'rpg',rpgMapId:'garden',rpgEventId:'keeper'})}}});
  return {store,app,game};
}
const call = (name,args) => ({ok:true,toolCalls:[{id:crypto.randomUUID(),name,arguments:JSON.stringify(args)}]});
const end = {ok:true,content:'Updated'};

test('game chat can set walk cadence and create, patch, inspect and undo project HUD panels', async () => {
  const panel = {id:'score',title:'Очки',text:'{очки}',position:'bottom-right'};
  const {store,app,game} = fixture((n,last) => {
    if (n===0) return call('get_rpg_game',{view:'settings'});
    if (n===1) {
      assert.deepEqual(last,{stepMs:180,panels:[]});
      return call('edit_rpg_game',{actions:[
        {action:'setMovement',stepMs:120},
        {action:'panel',panelId:'score',title:'Очки',text:'{очки}'},
        {action:'panel',panelId:'score',position:'bottom-right'}
      ]});
    }
    if (n===2) { assert.ok(last.ok); return call('get_rpg_game',{view:'settings'}); }
    assert.deepEqual(last,{stepMs:120,panels:[panel]});
    return end;
  });
  assert.equal((await app.send('Ускорь героя и выведи счёт в углу.')).error,null);
  assert.deepEqual(store.project.rpgGame.panels,[panel]);
  assert.equal(store.project.rpgGame.walkStepMs,120);
  store.undo();
  assert.deepEqual(store.project.rpgGame,game);
});

test('a malformed HUD in a mixed chat edit rolls back the walk change as well', async () => {
  const {store,app,game} = fixture(n => n===0 ? call('edit_rpg_game',{actions:[
    {action:'setMovement',stepMs:300},{action:'panel',panelId:'quest',title:'Quest',text:'Progress',position:'center'}
  ]}) : end);
  assert.ok((await app.send('Change speed and HUD')).error);
  assert.deepEqual(store.project.rpgGame,game);
});

test('large HUD settings page through complete panel texts in the game chat', async () => {
  const panels = Array.from({length:16},(_,i) => ({id:'panel_'+i,title:'Panel',text:'x'.repeat(600),position:'top-left'}));
  const seen = [];
  const {store,app,game} = fixture((n,last) => {
    if (!n) return call('get_rpg_game',{view:'settings'});
    assert.equal(last.total,panels.length);
    seen.push(...last.panels);
    return last.nextOffset === null ? end : call('get_rpg_game',{view:'settings',offset:last.nextOffset});
  });
  assert.ok(store.apply({op:'setRpgGame',game:{...game,panels}}).ok);
  assert.equal((await app.send('Прочитай все игровые панели.')).error,null);
  assert.deepEqual(seen,panels);
});
const edits = [
  {action:'paint',mapId:'garden',x:3,y:6,tile:25,blocked:true},
  {action:'event',mapId:'garden',eventId:'keeper',code:'say "Edited from chat"'}
];

test('game coauthors and the lead receive game memory, selection, and only game tools', async () => {
  const store = new Store();
  store.apply({op:'setScreenplay',text:'PRIVATE_SCREENPLAY'});
  store.apply({op:'setRpgGame',game:createRpgExample()});
  const bodies = [];
  globalThis.window = {sf:{
    ai:{chat:async ({body}) => { bodies.push(body); return end; }},
    history:{read:(_key,scope) => [{role:'user',content:scope === 'rpg' ? 'Remember the old bridge' : 'PRIVATE_CHAT'}],write(){}},
  }};
  const app = createAI({root:null,scope:'rpg',store,ui:{escapeHTML:String,
    settings:{ai:{model:'lead',teamMode:true,teamModels:'coauthor',baseUrl:'http://localhost/v1'}},
    workbench:{assistantContext:() => ({view:'rpg',rpgEventId:'keeper',workspaceId:'PRIVATE_CANVAS'})},
  }});
  assert.equal((await app.send('Plan the crossing')).error,null);
  assert.deepEqual(bodies.map(b => b.model),['coauthor','lead']);
  for (const body of bodies) {
    const prompt = JSON.stringify(body.messages);
    for (const token of ['Remember the old bridge','keeper','garden']) assert.ok(prompt.includes(token));
    assert.doesNotMatch(prompt,/PRIVATE_/);
  }
  assert.deepEqual(bodies[1].tools.map(tool => tool.function.name),['get_rpg_game','edit_rpg_game','get_engine_reference','playtest_rpg_game']);
});

test('Save As copies completed game turns and a late provider reply stays out of the next project', async () => {
  const store = new Store();
  const saved = new Map();
  let release, notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const calls = [];
  globalThis.window = {sf:{
    ai:{abort(){},async chat({body}) {
      calls.push(body);
      if (body.messages.at(-1).content.endsWith('pending turn')) {
        notifyStarted(); await blocked;
        return call('edit_rpg_game',{actions:edits});
      }
      return end;
    }},
    history:{read:(key,scope) => saved.get(scope + '/' + key) || [], write:(rows,key,scope) => saved.set(scope + '/' + key,rows)},
  }};
  const app = createAI({root:null,scope:'rpg',store,ui:{escapeHTML:String,settings:{ai:{model:'lead',baseUrl:'http://localhost/v1'}}}});
  assert.equal((await app.send('first project')).error,null);
  const pending = app.send('pending turn');
  await started;
  store.markSaved('first.sfproj');
  await app.projectPathChanged();
  assert.deepEqual(saved.get('rpg/first.sfproj').map(m=>m.content),['first project','Updated']);
  const original = store.snapshot();
  store.setProject(original,{filePath:'second.sfproj'});
  try {
    assert.equal((await app.send('second project')).error,null);
    assert.doesNotMatch(JSON.stringify(calls.at(-1).messages),/first project|pending turn/);
  } finally { release(); await pending; }
  assert.deepEqual(store.project,original);
  assert.deepEqual(saved.get('rpg/second.sfproj').map(m=>m.content),['second project','Updated']);
});

test('game chat gets its selection, edits a map and canonical event code, can play and undo the complete turn',async () => {
  const {store,app,game} = fixture((n,last,body) => {
    if (!n) {
      assert.ok(body.tools.some(t => t.function.name === 'edit_rpg_game'));
      assert.match(JSON.stringify(body.messages),/keeper/);
      return call('get_rpg_game',{view:'code',mapId:'garden',eventId:'keeper'});
    }
    if (n===1) { assert.match(last.code,/has_key/); return call('edit_rpg_game',{actions:edits}); }
    if (n===2) { assert.equal(last.ok,true); return call('get_rpg_game',{view:'tiles',mapId:'garden',x:3,y:6}); }
    assert.deepEqual(last.blocked,[[3,6]]);
    return end;
  });
  const result = await app.send('Edit the selected game event and map.');
  assert.equal(result.error,null);
  const updated = store.project.rpgGame, player = startGame(updated);
  move(updated,player,0,-1); interact(updated,player);
  assert.equal(player.dialogue,'Edited from chat');
  store.undo();
  assert.deepEqual(store.project.rpgGame,game);
});

test('game chat reads and paints outside the seed, moves the spawn there and erases a tile without changing the original room', async () => {
  const x=-2075, y=4100, mapId='garden';
  const {store,app,game} = fixture((n,last) => {
    switch (n) {
      case 0: return call('get_rpg_game',{view:'tiles',mapId,x,y,width:4});
      case 1:
        assert.deepEqual(last.rows,[[null,null,null,null]]);
        return call('edit_rpg_game',{actions:[
          {action:'paint',mapId,x,y,width:4,tile:25},
          {action:'paint',mapId,x:x+2,y,blocked:true},
          {action:'start',mapId,x,y},
          {action:'erase',mapId,x:x+3,y},
        ]});
      case 2:
        assert.equal(last.ok,true);
        return call('get_rpg_game',{view:'tiles',mapId,x,y,width:4});
      case 3:
        assert.deepEqual(last.rows,[[25,25,25,null]]);
        assert.deepEqual(last.blocked,[[x+2,y]]);
        return call('get_rpg_game',{view:'maps'});
      default:
        assert.deepEqual(last.items[0].bounds,{minX:x,maxX:15,minY:0,maxY:y});
        return end;
    }
  });
  assert.equal((await app.send('Extend the current map to a distant tile')).error,null);
  const world=store.project.rpgGame, state=startGame(world);
  assert.equal(getMapTile(world.maps[0],x,y),25);
  assert.equal(isMapBlocked(world.maps[0],x+2,y),true);
  move(world,state,1,0); move(world,state,1,0);
  assert.deepEqual([state.x,state.y],[x+1,y]);
  store.undo();
  assert.deepEqual(store.project.rpgGame,game);
});

test('a failed game edit or a concurrent author edit cannot leak or overwrite staged work', async () => {
  for (const conflict of [false,true]) {
    const {store,app,game} = fixture((n,last,_body,store) => {
      if (n===0) return call('edit_rpg_game',{actions:edits});
      if (n===1 && !conflict) return call('edit_rpg_game',{actions:[{action:'event',mapId:'garden',eventId:'keeper',code:'goto missing 0 0'}]});
      if (conflict) {
        const manual = structuredClone(store.project.rpgGame);
        manual.maps[0].name='Manual';
        store.apply({op:'setRpgGame',game:manual});
      }
      return end;
    });
    const result = await app.send('Improve this map');
    assert.ok(result.error);
    const expected = structuredClone(game);
    if (conflict) expected.maps[0].name='Manual';
    assert.deepEqual(store.project.rpgGame,expected);
  }
});
