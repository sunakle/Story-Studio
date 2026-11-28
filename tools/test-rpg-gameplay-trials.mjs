// Runs scripted provider actions through the real editor; the independent player assertions decide the result.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createEmptyProject} from '../src/js/model.js';
import {makeTrialGame,scenarios} from './rpg-gameplay-scenarios.mjs';

const require=createRequire(import.meta.url);
const {_electron:electron}=require(process.env.STORYFORGE_PLAYWRIGHT || 'playwright-core');
const root=fileURLToPath(new URL('../',import.meta.url));
const arg=name=>process.argv.includes(name)?process.argv[process.argv.indexOf(name)+1]:null;
const directory=path.resolve(root,arg('--report-dir') || '.release-work/rpg-manifest/offline');
const only=arg('--only')?.split(',');
const selected=scenarios.filter(s=>!only || only.includes(s.id));
assert.ok(selected.length,'No matching tests');
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'StoryForge-GameplayTrials-'));
const fixtures=new Map();
const report={mode:'Локальный сценарный API, реальные инструменты, редактор, проигрыватель Electron и файлы .sfproj',
  version:require('../package.json').version,started:new Date().toISOString(),total:selected.length,results:[]};
let app,page,active;

const server=http.createServer(async(req,res)=>{
  try {
    assert.ok(active,'Unexpected provider request');
    const chunks=[];
    for await(const chunk of req) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks));
    const user=body.messages.findLast(m=>m.role==='user');
    active.origin=JSON.stringify(user?.content);
    assert.ok(active.origin.includes(active.scenario.prompt),'Wrong project or user request');
    const last=body.messages.at(-1);
    if(last.role==='tool'){
      const call=active.calls.find(c=>c.id===last.tool_call_id);
      assert.ok(call,'Unexpected tool result');
      call.result=JSON.parse(last.content);
    }
    const step=active.scenario.steps[active.calls.length];
    let answer={content:'Проверка '+active.scenario.id+' завершена.'},reason='stop';
    if(step){
      const id=active.scenario.id+'_'+active.calls.length;
      assert.ok(body.tools.some(t=>t.function.name===step.name),'Unavailable tool '+step.name);
      active.calls.push({id,...step});
      answer={tool_calls:[{index:0,id,type:'function',function:{name:step.name,arguments:JSON.stringify(step.args)}}]};
      reason='tool_calls';
    } else active.terminal=true;
    if(body.stream){
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.end('data: '+JSON.stringify({choices:[{index:0,delta:answer,finish_reason:reason}]})+'\n\ndata: [DONE]\n\n');
    } else {
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({choices:[{message:{role:'assistant',...answer},finish_reason:reason}]}));
    }
  } catch(e){
    if(active)active.serverError=e.message;
    res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:e.message}}));
  }
});

async function writeReport(){
  report.passed=report.results.filter(r=>r.status==='pass').length;
  report.failed=report.results.filter(r=>r.status==='fail').length;
  const md=['# Игровые испытания StoryForge','',report.mode+'.','',
    'Сборка '+report.runtime.version+' · '+report.runtime.executable,'',
    report.passed+' из '+report.total+' пройдено. Ошибок: '+report.failed+'.','',...report.results.flatMap(r=>[
      '## '+r.id+' · '+r.status,'',r.prompt,'',
      ...r.calls.map(c=>'- '+c.name+' → '+(c.result?.error || (c.result?'выполнено':'ответ не получен'))),
      ...r.observed.map(line=>'- '+line),...(r.error?['- Ошибка: '+r.error]:[]),
      ...r.screenshots.map(s=>'- [Скриншот]('+s+')'),'',])].join('\n');
  await fs.writeFile(path.join(directory,'results.json'),JSON.stringify(report,null,2));
  await fs.writeFile(path.join(directory,'results.md'),md);
}

async function launch(){
  const env={...process.env,SF_USERDATA:profile};
  delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:process.env.STORYFORGE_EXE||require('electron'),
    args:[...(process.env.STORYFORGE_EXE?[]:['.']),'--user-data-dir='+profile],cwd:root,env});
  report.runtime=await app.evaluate(({app})=>({version:app.getVersion(),executable:process.execPath,packaged:app.isPackaged}));
  page=await app.firstWindow();
  page.setDefaultTimeout(5500);
  page.on('pageerror',e=>{if(active)active.rendererErrors.push(e.message);});
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.unmaximize();w.setContentSize(1480,880);});
}
async function quit(){
  if(!app)return;
  const current=app; app=null;
  const proc=current.process();
  const closed=current.waitForEvent('close',{timeout:7000}).catch(()=>{if(proc.exitCode===null)proc.kill();});
  await current.evaluate(({app})=>{setImmediate(()=>app.exit(0));}).catch(()=>{});
  await closed;
}
async function openGame(fixture,first=false){
  if(!first){
    await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},fixture.file);
    await page.keyboard.press('Control+o');
  }
  await page.waitForFunction(title=>document.querySelector('#projectTitle')?.value===title,fixture.title);
  const existing=page.locator('[data-tab-kind="rpg"]');
  if(await existing.count())await existing.first().click();
  else {await page.locator('#newWorkspaceTab').click();await page.locator('[data-start="rpg"]').click();}
  if(!await page.locator('#rpgAiInput').isVisible())await page.locator('.rpg-editor [data-cmd="ai"]').click();
  await page.locator('#rpgAiInput').waitFor();
}

async function saveGame(file){
  await page.locator('[data-rpg-canvas]').focus();
  const previous=(await fs.stat(file)).mtimeMs;
  await page.keyboard.press('Control+s');
  for(let i=0;i<100;i++){
    await delay(35);
    if((await fs.stat(file)).mtimeMs!==previous)return JSON.parse(await fs.readFile(file,'utf8')).rpgGame;
  }
  throw Error('Не дождался записи .sfproj');
}

async function measureCadence(dialog,ms){
  return dialog.evaluate((d,ms)=>{
    const canvas=d.querySelector('canvas');
    const press=(type,repeat=false)=>canvas.dispatchEvent(new KeyboardEvent(type,{key:'ArrowRight',code:'ArrowRight',bubbles:true,cancelable:true,repeat}));
    const restart=()=>d.querySelector('[data-player="restart"]').click();
    const nativeRAF=window.requestAnimationFrame,nativeCancel=window.cancelAnimationFrame;
    const descriptor=Object.getOwnPropertyDescriptor(performance,'now');
    let time=performance.now(),seq=0;
    const frames=new Map();
    window.requestAnimationFrame=cb=>{frames.set(++seq,cb);return seq;};
    window.cancelAnimationFrame=id=>frames.delete(id);
    Object.defineProperty(performance,'now',{configurable:true,value:()=>time});
    const tick=dt=>{time+=dt;const pending=[...frames.values()];frames.clear();for(const cb of pending)cb(time);};
    function hold(repeats,interval){
      restart();const initial=Number(canvas.dataset.x);
      press('keydown');let elapsed=0;const dx=()=>Number(canvas.dataset.x)-initial;
      const offsets=[dx()];
      for(const target of [ms-1,ms+1,2*ms+1,3*ms+1]){
        while(elapsed<target){
          if(repeats)press('keydown',true);
          const dt=Math.min(interval,target-elapsed);
          tick(dt);elapsed+=dt;
        }
        offsets.push(dx());
      }
      press('keyup');for(let i=0;i<60;i++)tick(16);
      return [...offsets,dx()];
    }
    function stalled(){
      restart();const initial=Number(canvas.dataset.x),dx=()=>Number(canvas.dataset.x)-initial;
      press('keydown');const offsets=[dx()];
      // Miss nearly a full step during a single slow render. The next step
      // should take its full duration instead of "catching up" in 15 ms.
      tick(ms-15);tick(ms);offsets.push(dx());
      for(let elapsed=0;elapsed<ms-1;){
        const dt=Math.min(8,ms-1-elapsed);tick(dt);elapsed+=dt;
      }
      offsets.push(dx());tick(2);offsets.push(dx());press('keyup');return offsets;
    }
    try{return {regular:hold(false,8),autoRepeat:hold(true,8),lowRefresh:hold(false,31),stalled:stalled()};}
    finally{
      restart();window.requestAnimationFrame=nativeRAF;window.cancelAnimationFrame=nativeCancel;
      if(descriptor)Object.defineProperty(performance,'now',descriptor);else delete performance.now;
    }
  },ms);
}

function testContext(fixture,record){
  let dialog=page.locator('dialog.rpg-player');
  const obs=text=>record.observed.push(text);
  return {
    before:fixture.before,origin:active.origin,reply:i=>record.calls[i]?.result,
    saved:()=>saveGame(fixture.file),
    async undo(){await page.locator('[data-rpg-canvas]').focus();await page.keyboard.press('Control+z');obs('Один шаг отмены');},
    async redo(){await page.locator('[data-rpg-canvas]').focus();await page.keyboard.press('Control+y');obs('Один шаг повтора');},
    async play(){await page.locator('.rpg-editor [data-cmd="play"]').click();await page.waitForFunction(()=>document.querySelector('dialog.rpg-player canvas')?.width===320);obs('Играть → открыт проигрыватель');},
    async restart(){await dialog.locator('[data-player="restart"]').click();obs('Перезапуск игры');},
    async at(map,x,y){await dialog.locator('canvas[data-map="'+map+'"][data-x="'+x+'"][data-y="'+y+'"]').waitFor();obs('Позиция '+map+' ('+x+', '+y+')');},
    async key(key){await page.keyboard.press(key);if(key.startsWith('Arrow'))await delay(220);},
    async line(text){const line=dialog.locator('.rpg-play-dialogue p');await line.waitFor();assert.equal(await line.innerText(),text);obs('Реплика «'+text+'»');},
    async noDialogue(){await dialog.locator('.rpg-play-dialogue').waitFor({state:'hidden'});obs('Диалог закрыт');},
    async panel(id,text){const panel=dialog.locator('[data-panel-id="'+id+'"]');await panel.waitFor();assert.equal(await panel.locator('span').innerText(),text);obs('Панель '+id+' показывает «'+text+'»');},
    async noPanel(id){assert.equal(await dialog.locator('[data-panel-id="'+id+'"]').count(),0);obs('Панель '+id+' удалена');},
    async shot(id){const file='evidence/'+id+'.png';await dialog.screenshot({path:path.join(directory,file)});record.screenshots.push(file);},
    async cadence(ms){
      const tracks=await measureCadence(dialog,ms);record.cadence=tracks;
      for(const [name,positions] of Object.entries(tracks)){
        assert.deepEqual(positions,name==='stalled'?[1,2,2,3]:[1,1,2,3,4,4],name);
        obs(ms+' мс, '+name+' → '+positions.join(', '));
      }
    },
    async reopen(){
      await quit();await launch();await openGame(fixture,true);
      dialog=page.locator('dialog.rpg-player');
      obs('Проект повторно открыт в новом процессе Electron');
    },
  };
}

async function trial(s,index){
  const fixture=fixtures.get(s.id),time=performance.now();
  const record={id:s.id,prompt:s.prompt,expectedRejection:!!s.rejected,calls:[],observed:[],screenshots:[]};
  report.results.push(record);
  active={scenario:s,calls:record.calls,rendererErrors:[]};
  try{
    await openGame(fixture,index===0);
    const panel=page.locator('#rpgAiBody');
    assert.equal(await panel.locator('.msg-user').count(),0,'New project inherited chat messages');
    // Use the normalized on-disk project as the baseline, including old-file defaults.
    fixture.before=await saveGame(fixture.file);
    if(s.selectEvent){
      await page.locator('.rpg-editor [data-mode="event"]').click();
      const point=await page.locator('[data-rpg-canvas]').evaluate((el,[x,y])=>{
        const r=el.getBoundingClientRect(),size=Number(el.dataset.cellSize);
        return {x:r.left+(x+.5-Number(el.dataset.worldLeft))*size,y:r.top+(y+.5-Number(el.dataset.worldTop))*size};
      },s.selectEvent);
      await page.mouse.click(point.x,point.y);
      record.observed.push('Выбрано событие на клетке '+s.selectEvent.join(', '));
    }
    await panel.locator('.chat-input').fill(s.prompt);
    await panel.locator('[data-ai-act="send"]').click();
    for(let i=0;i<300 && !active.terminal && !active.serverError;i++)await delay(30);
    assert.ok(active.terminal,active.serverError||'Local model did not complete the round trip');
    if(s.rejected)await panel.locator('.chat-status').filter({hasText:'Правки отменены'}).waitFor();
    else await panel.getByText('Проверка '+s.id+' завершена.',{exact:true}).waitFor();
    for(const call of record.calls){
      assert.ok(call.result,'Missing tool response '+call.name);
      if(!s.rejected)assert.ok(!call.result.error,call.name+': '+call.result.error);
    }
    const context=testContext(fixture,record);context.game=await context.saved();
    await s.check(context);assert.deepEqual(active.rendererErrors,[]);
    record.status='pass';
  }catch(e){
    record.status='fail';record.error=e.message;
    record.rendererErrors=active.rendererErrors;
    record.visibleStatus=await page.locator('#rpgAiBody .chat-status').allTextContents().catch(()=>[]);
    const file='evidence/fail-'+s.id+'.png';
    if(await page.screenshot({path:path.join(directory,file),timeout:1200}).then(()=>true,()=>false))record.screenshots.push(file);
  }finally{
    const close=page.locator('dialog.rpg-player [data-player="close"]');
    if(await close.isVisible().catch(()=>false))await close.click().catch(()=>{});
    record.durationMs=Math.round(performance.now()-time);
    console.log(record.status.toUpperCase(),s.id,record.error || record.durationMs+' ms');
    active=null;await writeReport();
  }
}

try{
  await fs.mkdir(path.join(directory,'evidence'),{recursive:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  for(const s of selected){
    const game=makeTrialGame();s.seed?.(game);
    const title='QA · '+s.id,file=path.join(profile,s.id+'.sfproj');
    await fs.writeFile(file,JSON.stringify(createEmptyProject({meta:{title},rpgGame:game})));
    fixtures.set(s.id,{title,file});
  }
  await fs.writeFile(path.join(profile,'settings.json'),JSON.stringify({lastPath:fixtures.get(selected[0].id).file,
    language:'ru',resumeLastProject:true,autosave:false,ai:{preset:'custom',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',
    model:'local-trial',allowDelete:true,maxTokens:4096}}));
  await launch();
  for(const [index,s] of selected.entries())await trial(s,index);
  report.finished=new Date().toISOString();await writeReport();
  if(report.failed)process.exitCode=1;
}finally{
  await quit();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await fs.rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:250});
}
