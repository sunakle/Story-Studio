import assert from 'node:assert/strict';
import { createMap, getMapTile, isMapBlocked } from '../src/js/rpg-model.js';
import { rpgDefaults } from '../src/js/rpg-assets.js';

const hall = 'hall';
const read = (view, args = {}) => ({name:'get_rpg_game', args:{view, ...args}});
const edit = (...actions) => ({name:'edit_rpg_game', args:{actions}});
const onMap = (action, args = {}) => ({action, mapId:hall, ...args});
const actor = (id, name, x, y, code, trigger = 'action') =>
  onMap('event', {eventId:id, name, x, y, code, trigger, sprite:rpgDefaults.npc});
const say = text => 'say ' + JSON.stringify(text);
const source = (args={}) => ({name:'get_engine_reference',args});
const simulate = (...actions) => ({name:'playtest_rpg_game',args:{steps:actions.map(action=>typeof action==='string'?{action}:action)}});
const reach = eventId => ({action:'reachEvent',eventId});
async function playTrace(t, trace) {
  const keys={up:'ArrowUp',down:'ArrowDown',left:'ArrowLeft',right:'ArrowRight',interact:'Space',advance:'Space'};
  for(const step of trace){
    assert.ok(keys[step.action],'Route should expand into movement or interaction');
    await t.key(keys[step.action]);
    await t.at(step.mapId,step.x,step.y);
    if(typeof step.dialogue==='string')await t.line(step.dialogue);
    if(step.dialogue===null)await t.noDialogue();
  }
}

export function makeTrialGame() {
  return {version:1, maps:[createMap(hall, 'Площадь', 13, 8, rpgDefaults.ground)],
    start:{mapId:hall, x:2, y:3, sprite:rpgDefaults.hero}};
}
const getMap = game => game.maps.find(map => map.id === hall);
export const scenarios = [
  {
    id:'orientation', prompt:'Где я нахожусь и откуда стартует игрок? Ничего не меняй.',
    steps:[read('maps')],
    check:async t => {
      const maps = t.reply(0);
      assert.equal(maps.items[0].name, 'Площадь');
      assert.match(t.origin, /hall/);
      assert.match(t.origin, /rpg/i);
      assert.deepEqual(maps.start, t.before.start);
      await t.play(); await t.at(hall,2,3);
    },
  },
  {
    id:'negative-path', prompt:'Продли дорожку влево за границу площади до x=-3 на строке y=3.',
    steps:[read('tiles',{mapId:hall,x:-3,y:3,width:6}), edit(onMap('paint',{x:-3,y:3,width:6,height:1,tile:rpgDefaults.path}))],
    check:async t => {
      assert.equal(t.reply(0).rows[0][0], null);
      const map=getMap(t.game);
      for(let x=-3;x<3;x++) assert.equal(getMapTile(map,x,3),rpgDefaults.path);
      await t.play(); for(let x=1;x>=-3;x--) { await t.key('ArrowLeft'); await t.at(hall,x,3); }
      await t.key('ArrowLeft'); await t.at(hall,-3,3);
    },
  },
  {
    id:'collision', prompt:'Поставь стену сразу справа от старта, оставь обход снизу.',
    steps:[edit(onMap('paint',{x:3,y:3,blocked:true})), read('tiles',{mapId:hall,x:2,y:3,width:3,height:2})],
    check:async t => {
      assert.deepEqual(t.reply(1).blocked, [[3,3]]);
      assert.ok(isMapBlocked(getMap(t.game),3,3));
      await t.play(); await t.key('ArrowRight'); await t.at(hall,2,3);
      for(const dir of ['ArrowDown','ArrowRight','ArrowRight','ArrowUp']) await t.key(dir);
      await t.at(hall,4,3);
    },
  },
  {
    id:'erase', prompt:'Сотри одну клетку справа от героя, соседние не трогай.',
    steps:[edit(onMap('erase',{x:3,y:3}))],
    check:async t => {
      assert.equal(getMapTile(getMap(t.game),3,3),null);
      assert.equal(getMapTile(getMap(t.game),4,3),rpgDefaults.ground);
      await t.play(); await t.key('ArrowRight'); await t.at(hall,2,3);
    },
  },
  {
    id:'spawn', prompt:'Поставь игрока в точку 9,5 и назначь ему новый спрайт.',
    steps:[read('palette'),edit(onMap('start',{x:9,y:5,sprite:218}))],
    check:async t => {
      assert.ok(t.reply(0).count>218); assert.equal(t.game.start.sprite,218);
      await t.play(); await t.at(hall,9,5); await t.key('ArrowDown'); await t.at(hall,9,6);
    },
  },
  {
    id:'conversation', prompt:'Сверху от старта поставь архивариуса: две фразы «Добро пожаловать!» и «Архив открыт.»',
    steps:[edit(actor('archivist','Архивариус',2,2,say('Добро пожаловать!')+'\n'+say('Архив открыт.')))],
    check:async t => {
      await t.play(); await t.key('ArrowUp'); await t.at(hall,2,3); await t.key('Space'); await t.line('Добро пожаловать!');
      await t.key('ArrowRight'); await t.at(hall,2,3); await t.key('Space'); await t.line('Архив открыт.');
      await t.shot('conversation'); await t.key('Space'); await t.noDialogue(); await t.key('ArrowRight'); await t.at(hall,3,3);
    },
  },
  {
    id:'branch-revisit', prompt:'При первом разговоре продавец слева выдаёт билет, при повторном говорит, что билет уже получен.',
    steps:[edit(actor('seller','Продавец',1,3,'if ticket == true\n'+say('Билет уже у тебя.')+'\nelse\n'+say('Вот твой билет.')+'\nset ticket = true\nend'))],
    check:async t => {
      await t.play(); await t.key('ArrowLeft'); await t.key('Space'); await t.line('Вот твой билет.');
      await t.key('Space'); await t.key('Space'); await t.line('Билет уже у тебя.');
      await t.restart(); await t.key('ArrowLeft'); await t.key('Space'); await t.line('Вот твой билет.');
    },
  },
  {
    id:'key-door', prompt:'Сделай комнату «Архив». Дверь справа пускает только с ключом от хранителя сверху. В архиве добавь выход обратно.',
    steps:[edit({action:'addMap',mapId:'archive',name:'Архив',width:5,height:5},
      actor('keeper','Хранитель',2,2,say('Бери ключ.')+'\nset key = true'),
      actor('gate','Дверь',3,3,'if key == true\ngoto archive 1 1\nelse\n'+say('Заперто.')+'\nend','touch'),
      {...actor('exit','Выход',2,1,'goto hall 2 3','touch'),mapId:'archive'})],
    check:async t => {
      await t.play(); await t.key('ArrowRight'); await t.line('Заперто.'); await t.key('Space'); await t.key('ArrowLeft');
      await t.key('ArrowUp'); await t.key('Space'); await t.line('Бери ключ.'); await t.key('Space');
      await t.key('ArrowRight'); await t.at('archive',1,1); await t.shot('archive'); await t.key('ArrowRight'); await t.at(hall,2,3);
    },
  },
  {
    id:'target-event', prompt:'У двух событий одинаковое имя. Поменяй реплику только у второго, справа, на «Восточный пост».',
    selectEvent:[3,3], seed:g => {for(const [id,x] of [['west',1],['east',3]]) getMap(g).events.push({id,name:'Страж',x,y:3,sprite:218,trigger:'action',code:say('Караул.')});},
    steps:[read('events',{mapId:hall}),read('code',{mapId:hall,eventId:'east'}),edit(onMap('event',{eventId:'east',code:say('Восточный пост')}))],
    check:async t => {
      assert.deepEqual(t.reply(0).items.map(e=>e.id),['west','east']);
      assert.match(t.origin,/east/);
      assert.deepEqual(getMap(t.game).events[0],getMap(t.before).events[0]);
      await t.play(); await t.key('ArrowLeft'); await t.key('Space'); await t.line('Караул.'); await t.key('Space');
      await t.key('ArrowRight'); await t.key('Space'); await t.line('Восточный пост');
    },
  },
  {
    id:'source-walking',prompt:'Прочитай исходник проигрывателя и найди, какая переменная определяет момент следующего шага. Карту оставь как есть.',
    steps:[source(),source({module:'player',query:'step.start + stepMs'}),read('settings')],
    check:async t=>{
      assert.ok(t.reply(0).modules.some(m=>m.id==='player'));
      assert.match(t.reply(1).lines[0].text,/step.start \+ stepMs/);
      assert.equal(t.reply(2).stepMs,180);assert.deepEqual(t.game,t.before);
      await t.play();await t.cadence(180);
    },
  },
  {
    id:'simulation-collision',prompt:'Поставь стену передо мной и проверь обход вокруг неё. Покажи на какой клетке я окажусь.',
    steps:[edit(onMap('paint',{x:3,y:3,blocked:true})),simulate('right','up','right','right','down')],
    check:async t=>{
      assert.deepEqual(t.reply(1).trace.map(s=>[s.x,s.y]),[[2,3],[2,2],[3,2],[4,2],[4,3]]);
      await t.play();for(const step of t.reply(1).trace){
        await t.key('Arrow'+step.action[0].toUpperCase()+step.action.slice(1));await t.at(step.mapId,step.x,step.y);
      }
    },
  },
  {
    id:'simulation-variables',prompt:'Установи табло счёта. Диалог с торговцем должен выдать пять монет и показать их в игре. Проверь действия на черновике.',
    steps:[edit({action:'panel',panelId:'coins',title:'Кошелёк',text:'Монеты: {coins}',position:'bottom-left'},
      actor('vendor','Торговец',3,3,say('За работу!')+'\nset coins = 5')), simulate('right','interact','advance')],
    check:async t=>{
      assert.equal(t.reply(1).trace[1].dialogue,'За работу!');assert.equal(t.reply(1).variables.coins,5);
      const panel=t.reply(1).panels.find(p=>p.id==='coins');assert.equal(panel.text,'Монеты: 5');
      await t.play();await t.key('ArrowRight');await t.key('Space');await t.line(t.reply(1).trace[1].dialogue);
      await t.key('Space');await t.panel('coins',panel.text);
    },
  },
  {
    id:'routed-hud',prompt:'В дальнем углу площади поставь торговца, который даст пять монет. Покажи мне счёт до и после разговора. Проверь с места старта, обойдя стену.',
    steps:[edit(onMap('paint',{x:3,y:2,width:1,height:3,blocked:true}),
      {action:'panel',panelId:'coins',title:'Кошелёк',text:'Монеты: {coins}',position:'top-right'},
      actor('merchant','Торговец',5,3,say('Держи пять монет!')+'\nset coins = 5')),
      simulate(reach('merchant'),'interact','advance')],
    check:async t=>{
      const run=t.reply(1);
      const initial=run.initialPanels.find(panel=>panel.id==='coins');
      const final=run.panels.find(panel=>panel.id==='coins');
      assert.equal(initial.text,'Монеты: —');assert.equal(final.text,'Монеты: 5');
      assert.equal(run.variables.coins,5);
      assert.ok(run.trace.some(step=>step.y===1 || step.y===5),'Route must go around the wall');
      assert.ok(run.trace.some(step=>step.eventId==='merchant' && step.dialogue==='Держи пять монет!'));
      await t.play();await t.at(hall,2,3);await t.panel('coins',initial.text);
      await playTrace(t,run.trace);await t.panel('coins',final.text);await t.shot('routed-hud');
    },
  },
  {
    id:'routed-key-return',prompt:'Пройди от старта до закрытой двери, найди ключ у смотрителя, войди в кладовую и вернись через выход. Проверь это одним прохождением.',
    steps:[edit({action:'addMap',mapId:'cellar',name:'Кладовая',width:6,height:5},
      onMap('paint',{x:4,y:2,width:1,height:3,blocked:true}),
      actor('keeper','Смотритель',2,5,say('Вот ключ от кладовой.')+'\nset has_key = true'),
      actor('gate','Вход',7,3,'if has_key == true\ngoto cellar 1 1\nelse\n'+say('Нужен ключ.')+'\nend','touch'),
      {...actor('exit','Выход',3,1,'goto hall 2 3','touch'),mapId:'cellar'}),
      simulate(reach('gate'),'advance',reach('keeper'),'interact','advance',reach('gate'),reach('exit'))],
    check:async t=>{
      const run=t.reply(1);
      assert.equal(run.variables.has_key,true);
      const events=run.trace.filter(step=>step.dialogue || step.mapId==='cellar' && step.eventId==='gate' || step.eventId==='exit');
      assert.deepEqual(events.map(step=>[step.eventId,step.mapId,step.dialogue??null]),[
        ['gate','hall','Нужен ключ.'],['keeper','hall','Вот ключ от кладовой.'],['gate','cellar',null],['exit','hall',null],
      ]);
      assert.deepEqual([run.end.mapId,run.end.x,run.end.y],['hall',2,3]);
      await t.play();await t.at(hall,2,3);
      await playTrace(t,run.trace);
      await t.at(hall,2,3);await t.shot('routed-return');
    },
  },
  {
    id:'simulation-clean-run',prompt:'Покажи, что новая проверка прохождения начинается с чистого состояния. Не переноси монеты предыдущего прохождения.',
    steps:[edit(actor('token','Монета',3,3,'set coins = 1','touch')),simulate('right'),simulate()],
    check:async t=>{
      assert.equal(t.reply(1).variables.coins,1);assert.equal(t.reply(2).variables.coins,undefined);
      await t.play();await t.at(hall,2,3);await t.key('ArrowRight');await t.at(hall,3,3);await t.restart();await t.at(hall,2,3);
    },
  },
  {
    id:'reopen',prompt:'Создай табличку справа от старта со словами «Старый маяк» и информационную панель. Сохрани игру для следующего запуска.',
    steps:[edit(actor('sign','Табличка',3,3,say('Старый маяк')),{action:'setMovement',stepMs:150},
      {action:'panel',panelId:'area',title:'Локация',text:'Берег',position:'bottom-left'})],
    check:async t=>{
      await t.reopen();assert.deepEqual(await t.saved(),t.game);await t.play();await t.at(hall,2,3);await t.panel('area','Берег');
      await t.key('ArrowRight');await t.key('Space');await t.line('Старый маяк');await t.shot('reopened-sign');
    },
  },
  {
    id:'transaction-undo', prompt:'Одной правкой переименуй площадь в «Двор» и поставь стену.',
    steps:[edit(onMap('renameMap',{name:'Двор'}),onMap('paint',{x:3,y:3,blocked:true}))],
    check:async t => {
      assert.equal(getMap(t.game).name,'Двор'); assert.ok(isMapBlocked(getMap(t.game),3,3));
      await t.undo(); const undone=await t.saved(); assert.deepEqual(undone,t.before);
      await t.redo(); assert.deepEqual(await t.saved(),t.game);
      await t.play(); await t.key('ArrowRight'); await t.at(hall,2,3);
    },
  },
  ...[
    ['reject-code','опечатка в коде события', actor('broken','Ошибка',1,3,'if quest == true\nsay "Ошибка"')],
    ['reject-destination','дверь ведёт на несуществующую карту',actor('broken','Ошибка',1,3,'goto unknown 2 3')],
    ['reject-range','просят отдать невозможный темп шага', {action:'setMovement',stepMs:0}],
  ].map(([id,reason,bad])=>({id,prompt:'Проверь откат всей пачки, если '+reason+'.',
    steps:[edit(onMap('renameMap',{name:'Не должно сохраниться'}),bad)], rejected:true,
    check:async t => { assert.ok(t.reply(0).error); assert.deepEqual(t.game,t.before); await t.play(); await t.at(hall,2,3); },
  })),
  ...[90,180,330].map(ms=>({id:'speed-'+ms,prompt:'Настрой ходьбу с постоянным шагом ровно '+ms+' мс.',
    steps:[edit({action:'setMovement',stepMs:ms}),read('settings')],
    check:async t => {
      assert.equal(t.reply(1).stepMs,ms);
      await t.play(); await t.cadence(ms);
    },
  })),
  {
    id:'hud', prompt:'Добавь две отдельные панели: задание слева сверху и счёт справа сверху. При шаге вправо счёт становится 7.',
    steps:[edit({action:'panel',panelId:'quest',title:'Задание',text:'Отыщи архив',position:'top-left'},
      {action:'panel',panelId:'score',title:'Очки',text:'Счёт: {score}',position:'top-right'},
      actor('reward','Награда',3,3,'set score = 7','touch')),read('settings')],
    check:async t => {
      assert.equal(t.reply(1).panels.length,2);
      await t.play(); await t.panel('quest','Отыщи архив'); await t.panel('score','Счёт: —');
      await t.key('ArrowRight'); await t.panel('score','Счёт: 7'); await t.shot('hud');
      await t.restart(); await t.panel('score','Счёт: —');
    },
  },
  {
    id:'hud-edit', prompt:'Перенеси панель счёта вниз и удали подсказку, остальные данные сохрани.',
    seed:g=>{g.panels=[{id:'score',title:'Очки',text:'Счёт: {score}',position:'top-right'},{id:'hint',title:'Подсказка',text:'Сюда',position:'top-left'}];},
    steps:[edit({action:'panel',panelId:'score',position:'bottom-right'},{action:'deletePanel',panelId:'hint'})],
    check:async t => {
      assert.deepEqual(t.game.panels,[{...t.before.panels[0],position:'bottom-right'}]);
      await t.play(); await t.panel('score','Счёт: —'); await t.noPanel('hint');
    },
  },
];
