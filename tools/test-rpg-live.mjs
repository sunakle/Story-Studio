// Opt-in paid acceptance run, only synthetic projects reach the configured model.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createEmptyProject } from '../src/js/model.js';
import { createRpgExample } from '../src/js/rpg-example.js';
import { gameSettings, getMapTile, isMapBlocked, validateGame } from '../src/js/rpg-model.js';
import { playtestGame } from '../src/js/ai-rpg-inspection.js';

const checkHarness=process.argv.includes('--check-budget-ui');
if (checkHarness===process.argv.includes('--live')) throw Error('Select --live for paid tests or --check-budget-ui for the local HTTP 429 check.');
const root = fileURLToPath(new URL('../', import.meta.url));
// The second run is opt-in after separate approval for its own 16-call budget.
const retryUnfinished=process.argv.includes('--retry-unfinished');
const budget=checkHarness ? {total:1,perTask:0} : retryUnfinished ? {total:16,perTask:8} : {total:70,perTask:10};
const liveDirectory=path.join(root,'.release-work','rpg-manifest','live');
const out=checkHarness ? path.join(path.dirname(liveDirectory),'harness-check') : retryUnfinished ? path.join(liveDirectory,'retry') : liveDirectory;
const require = createRequire(import.meta.url);
const { _electron:electron } = require(process.env.STORYFORGE_PLAYWRIGHT || 'playwright-core');
const config = checkHarness ? {preset:'anthropic',model:'deepseek-local-fixture',baseUrl:'http://127.0.0.1',apiKey:'blocked'} :
  JSON.parse(await fs.readFile(path.join(process.env.LOCALAPPDATA,'StoryForge','User Data','settings.json'),'utf8')).ai;
const anthropic = config.preset === 'anthropic';
const route = anthropic ? '/messages' : '/chat/completions';
const url = new URL(config.baseUrl.replace(/\/+$/, '') + route);
if (!checkHarness && (!config.apiKey || !['api.deepseek.com','api.zexkora.cc'].includes(url.hostname) || url.protocol!=='https:' || !/deepseek/i.test(config.model)))
  throw Error('No configured DeepSeek connection on the expected DeepSeek/Zexkora host.');
const step = (action,count=1) => ({action,count});
const run = (game,steps,position={}) => playtestGame(game,{...position,steps});
const garden = game => game.maps.find(m=>m.id==='garden');
const original = createRpgExample();
const cases = [
  {id:'cadence',prompt:'Сделай ходьбу героя равномерной, один шаг за 240 мс. Проверь три шага вправо со старта. Геометрию карты сохрани.',
    check(g){const p=run(g,[step('right',3)]);assert.equal(p.stepMs,240);assert.equal(p.end.x,8);assert.deepEqual(g.maps,original.maps);return {x:p.end.x,stepMs:p.stepMs};}},
  {id:'dialogue',prompt:'Поменяй только первое приветствие смотрителя сада на «Добро пожаловать в архив!». Сохрани выдачу ключа и его другую реплику при повторной встрече. Проверь обе встречи.',
    check(g){const p=run(g,[step('up'),step('interact'),step('advance'),step('interact')]);assert.equal(p.trace[1].dialogue,'Добро пожаловать в архив!');assert.equal(p.variables.has_key,true);assert.match(p.end.dialogue,/Ключ уже|have the key/i);return {first:p.trace[1].dialogue,second:p.end.dialogue,vars:p.variables};}},
  {id:'hud',prompt:'Добавь в правый верхний угол игры панель с заголовком «Инвентарь» и текстом «Ключ: {has_key}». Проверь, что меняется после разговора со смотрителем.',
    check(g){const pre=run(g,[]).panels.find(p=>p.title==='Инвентарь'),post=run(g,[step('up'),step('interact'),step('advance')]).panels.find(p=>p.title==='Инвентарь');assert.equal(pre.position,'top-right');assert.equal(pre.text,'Ключ: —');assert.equal(post.text,'Ключ: true');return {pre,post};}},
  {id:'wall',prompt:'Заблокируй клетку справа от старта в саду, сохрани её рисунок. Попробуй в неё войти. Соседний проход слева должен работать.',
    check(g){const p=run(g,[step('right'),step('left')]);assert.equal(p.trace[0].x,5);assert.equal(p.end.x,4);assert.ok(isMapBlocked(garden(g),6,6));assert.equal(getMapTile(garden(g),6,6),getMapTile(garden(original),6,6));return p.trace;}},
  {id:'negative',prompt:'Нарисуй горизонтальную дорожку из пяти проходимых тайлов травы от (-10,-3) до (-6,-3) в саду. Игрок должен пройти по ней. Остальную карту оставь как есть.',
    check(g){const p=run(g,[step('right',4)],{mapId:'garden',x:-10,y:-3});assert.equal(p.end.x,-6);assert.equal(getMapTile(garden(g),-11,-3),null);assert.equal(getMapTile(garden(g),-5,-3),null);return {end:p.end,tiles:p.trace.map(s=>getMapTile(garden(g),s.x,s.y))};}},
  {id:'room',prompt:'Создай локацию «Архив» с ID archive и полом 6 на 5 клеток. Поставь в саду в (4,6) напольную дверь в (2,2) архива. Проверь переход от старта.',
    check(g){assert.equal(g.maps.find(m=>m.id==='archive')?.name,'Архив');const p=run(g,[step('left')]);assert.equal(p.end.mapId,'archive');assert.deepEqual([p.end.x,p.end.y],[2,2]);return p.end;}},
  {id:'scope',prompt:'В каком окне я сейчас и какая карта открыта? Назови старт героя, а также координаты смотрителя. Ничего не меняй.',
    check(g,text){assert.deepEqual(g,original);assert.match(text,/игров.{0,8} движ|game engine/i);assert.match(text,/garden|сад/i);assert.match(text,/5\D{1,12}6/);assert.match(text,/5\D{1,12}5/);return {unchanged:true};}},
  {id:'source',prompt:'Посмотри в исходном коде этой сборки, как проигрыватель обрабатывает удержание клавиши и повтор Windows. Назови файл и конкретный механизм. Ничего не меняй.',
    check(g,text,tools){assert.deepEqual(g,original);assert.ok(tools.includes('get_engine_reference'));assert.match(text,/rpg-player/);assert.match(text,/repeat|held|keydown/i);return {readSource:true,unchanged:true};}},
  {id:'playthrough',prompt:'Сам пройди от старта к смотрителю, получи ключ, открой мастерскую и вернись через выход в сад. Дай итоговую локацию и координаты. Игру менять не нужно.',
    check(g,text,tools,calls){
      assert.deepEqual(g,original);assert.ok(tools.includes('playtest_rpg_game'));
      const attempts=calls.filter(c=>c.name==='playtest_rpg_game').flatMap(c=>{
        try{return [playtestGame(g,c.args)];}catch{return [];}
      });
      const route=attempts.find(p=>p.start.mapId===g.start.mapId && p.start.x===g.start.x && p.start.y===g.start.y &&
        p.variables.has_key===true && p.trace.some(s=>s.mapId==='workshop') && p.end.mapId==='garden' && p.end.x===10 && p.end.y===6);
      assert.ok(route,'No continuous, independently reproducible round trip from spawn in the tool history.');
      assert.match(text,/garden|сад/i);assert.match(text,/10\D{1,15}6/);return {steps:route.trace.length,end:route.end,vars:route.variables,unchanged:true};
    }},
];
const ids = process.argv.slice(2).filter(v=>!['--live','--retry-unfinished','--check-budget-ui'].includes(v));
if(retryUnfinished && ids.length)throw Error('The opt-in repeat covers only the two unfinished tasks.');
const selectedIds = checkHarness ? ['hud'] : retryUnfinished ? ['hud','playthrough'] : ids;
const selected = selectedIds.length ? cases.filter(c=>selectedIds.includes(c.id)) : cases;
if (!selected.length || selectedIds.some(id=>!cases.some(c=>c.id===id))) throw Error('Unknown test ID.');
await fs.mkdir(out,{recursive:true});
const budgetFile=path.join(out,'network-count.json'); // Includes retries and prior runs in this acceptance session.
let total=(await fs.readFile(budgetFile,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT') return 0;throw e;}));
let persistCount=Promise.resolve();
const clients=new Map();
const server=http.createServer(async(req,res)=>{
  const client=clients.get(anthropic ? req.headers['x-api-key'] : req.headers.authorization?.replace(/^Bearer /,''));
  if(!client || req.method!=='POST' || req.url!=='/v1'+route){res.writeHead(403);res.end();return;}
  if(total>=budget.total || client.calls>=budget.perTask){
    res.writeHead(429);
    const limit=total>=budget.total ? 'session' : 'task';
    res.end('Live acceptance '+limit+' call budget reached');return;
  }
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),95000);
  res.on('close',()=>{if(!res.writableEnded)controller.abort();});
  try{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=Buffer.concat(chunks);
    const data=JSON.parse(body);
    assert.equal(data.model,config.model);
    assert.ok((anthropic ? data.system : data.messages[0].content).startsWith('Ты — игровой ассистент StoryForge.'));
    const count=++total;client.calls++;
    persistCount=persistCount.then(()=>fs.writeFile(budgetFile,JSON.stringify(count)));
    await persistCount;
    const previous=anthropic ? data.messages.filter(m=>m.role==='assistant').flatMap(m=>m.content.filter(c=>c.type==='tool_use')
      .map(c=>({id:c.id,name:c.name,args:c.input}))) : data.messages.filter(m=>m.role==='assistant' && m.tool_calls)
      .flatMap(m=>m.tool_calls.map(c=>({id:c.id,name:c.function.name,args:JSON.parse(c.function.arguments)})));
    for(const {id,name,args} of previous)if(!client.actions.has(id))client.actions.set(id,{name,args});
    client.tools=[...new Set([...client.actions.values()].map(c=>c.name))];
    const auth=anthropic ? {'anthropic-version':req.headers['anthropic-version'],'x-api-key':config.apiKey} : {Authorization:'Bearer '+config.apiKey};
    const reply=await fetch(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...auth},
      body,signal:controller.signal});
    res.writeHead(reply.status,{'content-type':reply.headers.get('content-type') || 'application/json'});
    if(reply.body){for await(const chunk of Readable.fromWeb(reply.body))res.write(chunk);}
    res.end();
  } catch (error) {if(!res.headersSent)res.writeHead(503);res.end('Test transport interrupted');}
  finally{clearTimeout(timeout);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));

async function exercise(spec) {
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'StoryForge-DeepSeek-QA-'));
  const secret=randomUUID(),client={calls:0,tools:[],actions:new Map()};
  const title='QA '+spec.id, projectFile=path.join(profile,'fixture.sfproj');
  let app;
  const result={id:spec.id,prompt:spec.prompt,model:config.model,protocol:anthropic?'anthropic':'openai',startedAt:new Date().toISOString()};
  try{
    clients.set(secret,client);
    await fs.writeFile(projectFile,JSON.stringify(createEmptyProject({meta:{title},rpgGame:createRpgExample()})));
    await fs.writeFile(path.join(profile,'settings.json'),JSON.stringify({language:'ru',resumeLastProject:true,lastPath:projectFile,
      ai:{baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',model:config.model,preset:config.preset,apiKey:secret,maxTokens:4096}}));
    const env={...process.env,SF_USERDATA:profile};delete env.ELECTRON_RUN_AS_NODE;
    app=await electron.launch({executablePath:require('electron'),args:['.','--user-data-dir='+profile],cwd:root,env});
    const page=await app.firstWindow();
    await page.waitForFunction(expected=>document.querySelector('#projectTitle')?.value===expected,title);
    const location=new URL(page.url());location.searchParams.set('selftest','1');await page.goto(location.toString());
    await page.waitForFunction(()=>Boolean(window.__sfTest?.store));
    await page.locator('#newWorkspaceTab').click();
    await page.locator('[data-start="rpg"]').click();
    const pane=page.locator('#rpgAiBody');
    if(!await pane.locator('.chat-input').isVisible())await page.locator('.rpg-editor [data-cmd="ai"]').click();
    await pane.locator('.chat-input').fill(spec.prompt);
    await pane.locator('[data-ai-act="send"]').click();
    await page.waitForFunction(() => {
      const pane=document.querySelector('#rpgAiBody');
      const status=pane.querySelector('.chat-status')?.textContent || '';
      return pane.querySelector('[data-ai-act="send"]:enabled') &&
        (pane.querySelector('.msg-assistant .msg-bubble') || (status && !status.startsWith('Ctrl+Enter')));
    },null,{timeout:450000});
    result.answer=(await pane.locator('.msg-assistant .msg-bubble').allInnerTexts()).filter(Boolean).join('\n');
    result.status=await pane.locator('.chat-status').textContent();
    const game=await page.evaluate(()=>window.__sfTest.store.project.rpgGame);
    result.gameChanged=JSON.stringify(game)!==JSON.stringify(original);
    if(!result.status.startsWith('Ctrl+Enter'))throw Error(result.status);
    validateGame(game);result.observed=spec.check(game,result.answer,client.tools,[...client.actions.values()]);
    result.passed=true;
  }catch(error){result.passed=false;result.error=String(error.message).replaceAll(profile,'<QA profile>').slice(0,1200);}
  finally{
    Object.assign(result,{finishedAt:new Date().toISOString(),calls:client.calls,tools:client.tools,actions:[...client.actions.values()]});
    clients.delete(secret);
    await fs.writeFile(path.join(out,spec.id+'-'+Date.now()+'.json'),JSON.stringify(result,null,2));
    console.log(spec.id,result.passed?'PASS':'FAIL',client.calls,'calls',result.error || '');
    if(app)await app.close().catch(()=>app.process().kill());
    if(path.dirname(path.resolve(profile))===path.resolve(os.tmpdir()) && path.basename(profile).startsWith('StoryForge-DeepSeek-QA-'))
      await fs.rm(profile,{recursive:true,force:true,maxRetries:4}).catch(()=>{});
  }
  if(checkHarness){
    const caught=client.calls===0 && result.gameChanged===false && /HTTP 429.*task call budget/.test(result.error);
    console.log('Local HTTP 429 observer',caught?'PASS':'FAIL');return caught;
  }
  return result.passed;
}
const results=[];
try {
  const queue=[...selected];
  async function worker(){while(queue.length && total<budget.total)results.push(await exercise(queue.shift()));}
  await Promise.all([worker(),worker()]);
  for(const spec of queue){
    await fs.writeFile(path.join(out,spec.id+'-'+Date.now()+'.json'),JSON.stringify({id:spec.id,prompt:spec.prompt,model:config.model,
      protocol:anthropic?'anthropic':'openai',skipped:true,calls:0,reason:'Session call budget exhausted before this task.'},null,2));
  }
} finally {await new Promise(resolve=>server.close(resolve));}
if(results.length!==selected.length || results.includes(false))process.exitCode=1;
