import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { newDocument, newNode } from '../src/gigma/artwork-model.js';
import { createEmptyProject } from '../src/js/model.js';

const require = createRequire(import.meta.url);
const { _electron:electron } = require(process.env.STORYFORGE_PLAYWRIGHT || 'playwright-core');
const root = fileURLToPath(new URL('../', import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(),'StoryForge-CanvasConflict-'));
const file = path.join(profile,'design.sfproj');
const title = 'Canvas conflict fixture';
const design = newDocument(title);
const sheet = design.pages[0];
sheet.view = {x:115,y:90,zoom:0.3};
const photo = newNode('image',84,110,270,180);
photo.name = 'Test photo';
photo.image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8lq/FwMDAxAAGABOqAZN4qLblAAAAAElFTkSuQmCC';
photo.animation = {type:'bounce',durationMs:900,loop:true};
sheet.nodes.push(photo);
let app, page, frame, finalResponse, phase, mockError;
function reply(res,content) {
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify({content,stop_reason:content[0].type==='tool_use' ? 'tool_use' : 'end_turn'}));
}
const provider = http.createServer(async (req,res) => {
  try {
    assert.equal(req.url,'/v1/messages');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const {messages}=JSON.parse(Buffer.concat(chunks));
    const result=messages.at(-1).content.find(part=>part.type==='tool_result');
    if (result) {
      const outcome=JSON.parse(result.content);
      assert.deepEqual(outcome.objectIds,[photo.id]);
      finalResponse=res;
      return;
    }
    const input=phase==='view'
      ? {action:'animate',objectId:photo.id,animation:{type:'bounce',squashX:0.25}}
      : {action:'update',objectId:photo.id,name:'Model rename'};
    reply(res,[{type:'tool_use',id:'edit-'+phase,name:'edit_artwork',input}]);
  } catch (error) {
    mockError=error; res.writeHead(500); res.end();
  }
});
async function startTurn(next) {
  phase=next;
  finalResponse=null;
  await page.locator('#aiInput').fill(next==='view' ? 'Измени отскок этой картинки' : 'Переименуй картинку');
  await page.locator('[data-ai-act="send"]').click();
  for(let i=0;i<200 && !finalResponse && !mockError;i++) await delay(50);
  if(mockError) throw mockError;
  assert.ok(finalResponse,'Timed out waiting for the staged design edit');
}
async function finishTurn() {
  reply(finalResponse,[{type:'text',text:'Applied '+phase}]);
  await page.waitForFunction(() => {
    const status=document.querySelector('.chat-status')?.textContent.trim() || '';
    return document.querySelector('[data-ai-act="send"]') && !document.querySelector('[data-ai-act="stop"]') && !/^Шаг |^Step /i.test(status);
  });
  return page.locator('.chat-status').innerText();
}
async function saveAndInspect(predicate) {
  await page.locator('#aiInput').focus(); await page.keyboard.press('Control+s');
  let sheet;
  for(let i=0;i<100;i++) {
    const project=JSON.parse(await fs.readFile(file,'utf8'));
    sheet=project.gigmaWorkspaces.find(item=>item.id==='gg_assistant').document.pages[0];
    if(predicate(sheet)) return sheet;
    await delay(50);
  }
  assert.fail('Project file did not reflect the expected edit');
}
try {
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  await fs.writeFile(file,JSON.stringify(createEmptyProject({meta:{title},gigmaWorkspaces:[{id:'gg_assistant',name:title,document:design}]})));
  await fs.writeFile(path.join(profile,'settings.json'),JSON.stringify({resumeLastProject:true,lastPath:file,language:'ru',
    ai:{preset:'anthropic',baseUrl:'http://127.0.0.1:'+provider.address().port+'/v1',model:'fixture'}}));
  const env={...process.env,SF_USERDATA:profile}; delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:process.env.STORYFORGE_EXE || require('electron'),
    args:[...(process.env.STORYFORGE_EXE ? [] : ['.']),'--user-data-dir='+profile],env,cwd:root});
  page=await app.firstWindow(); page.setDefaultTimeout(10000);
  await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];win.unmaximize();win.setContentSize(1440,900);});
  await page.waitForFunction(title=>document.querySelector('#projectTitle')?.value===title,title);
  await page.locator('#newWorkspaceTab').click(); await page.locator('[data-start="assistant"]').click();
  frame=page.frameLocator('.gigma-panel:not([hidden]) iframe');
  await frame.getByRole('button',{name:'Выбрать слой '+photo.name,exact:true}).waitFor();
  assert.equal(await frame.locator('.selection').count(),0,'Fixture opens with nothing selected');
  await startTurn('view');
  await frame.getByTitle('Увеличить',{exact:true}).click();
  const status=await finishTurn();
  assert.equal(await page.getByText('Applied view',{exact:true}).count(),1,'Camera-only change discarded the edit: '+status);
  const saved=await saveAndInspect(sheet=>sheet.nodes[0].animation.squashX===0.25);
  assert.equal(saved.nodes.length,1); assert.equal(saved.nodes[0].id,photo.id);
  assert.equal(saved.view.zoom,0.375,'AI action should retain author zoom');
  assert.equal(await frame.getByTitle('Масштаб 100%',{exact:true}).innerText(),'38%','Canvas should stay at the author’s zoom');
  assert.deepEqual(saved.nodes[0].animation,{...photo.animation,squashX:0.25});
  await startTurn('rename');
  await frame.getByRole('button',{name:'Выбрать слой '+photo.name,exact:true}).click();
  const input=frame.getByLabel('Имя слоя',{exact:true});
  await input.fill('Author rename'); await input.press('Enter');
  await frame.getByRole('button',{name:'Выбрать слой Author rename',exact:true}).waitFor();
  const error=await finishTurn();
  assert.match(error,/измен|отмен|конфликт|changed|conflict/i);
  assert.equal(await page.getByText('Applied rename',{exact:true}).count(),0,'Must not report a conflicting edit as applied');
  await saveAndInspect(sheet=>sheet.nodes[0].name==='Author rename' && sheet.nodes[0].animation.squashX===0.25);
  console.log('PASS: a reopened, unselected photo accepts an AI edit during zoom; simultaneous renames retain the author edit.');
} finally {
  if(app) {
    const process=app.process();
    const closed=app.waitForEvent('close',{timeout:6000}).catch(()=>{if(process.exitCode===null) process.kill();});
    await app.evaluate(({app})=>{setImmediate(()=>app.exit());}).catch(()=>{}); await closed;
  }
  provider.closeAllConnections(); provider.close();
  const owned=await fs.realpath(profile);
  assert.equal(path.dirname(owned),await fs.realpath(os.tmpdir()));
  assert.match(path.basename(owned),/^StoryForge-CanvasConflict-/);
  await fs.rm(owned,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
