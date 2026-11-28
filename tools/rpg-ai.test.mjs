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
  const app = createAI({root:null,store,ui:{escapeHTML:String,settings:{ai:{baseUrl:'http://localhost/v1',model:'fixture'}},
    workbench:{current:()=>'rpg',navigationRevision:()=>0,flushDesigns:()=>true,
      assistantContext:()=>({surface:'sidebar',view:'rpg',rpgMapId:'garden',rpgEventId:'keeper'})}}});
  return {store,app,game};
}
const call = (name,args) => ({ok:true,toolCalls:[{id:crypto.randomUUID(),name,arguments:JSON.stringify(args)}]});
const end = {ok:true,content:'Updated'};
const edits = [
  {action:'paint',mapId:'garden',x:3,y:6,tile:25,blocked:true},
  {action:'event',mapId:'garden',eventId:'keeper',code:'say "Edited from chat"'}
];

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
