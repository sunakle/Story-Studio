import test from 'node:test';
import assert from 'node:assert/strict';
import { createAI } from '../src/js/ai.js';
import { Store } from '../src/js/model.js';
import { createRpgExample } from '../src/js/rpg-example.js';
import { interact, move, startGame } from '../src/js/rpg-model.js';

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
