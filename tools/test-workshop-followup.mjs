import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createEmptyProject } from '../src/js/model.js';
import projectFiles from '../project-files.cjs';

const require = createRequire(import.meta.url);
const { _electron:electron } = require(process.env.STORYFORGE_PLAYWRIGHT || 'playwright-core');
const root = fileURLToPath(new URL('../', import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'StoryForge-Followup-'));
const file = path.join(profile, 'photo.sfproj');
const title = 'Photo follow-up fixture';
const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8lq/FwMDAxAAGABOqAZN4qLblAAAAAElFTkSuQmCC', 'base64');
const incomplete = '{"name":"' + 'x'.repeat(191);
let phase = 'create', attempts = 0, protocolError, layer, app, page;

// Exercise the native Anthropic transport used by the gateway, including tool
// arguments that arrive in fragments and a complete SSE message carrying bad JSON.
function stream(response, calls, reply) {
  const events = [{type:'message_start',message:{role:'assistant',content:[]}}];
  for (const [index, call] of calls.entries()) {
    events.push({type:'content_block_start',index,content_block:{type:'tool_use',id:call.id,name:call.name,input:{}}});
    for (let pos=0; pos<call.args.length; pos+=17) {
      events.push({type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:call.args.slice(pos,pos+17)}});
    }
    events.push({type:'content_block_stop',index});
  }
  if (reply) events.push({type:'content_block_start',index:0,content_block:{type:'text',text:reply}}, {type:'content_block_stop',index:0});
  events.push({type:'message_delta',delta:{stop_reason:calls.length ? 'tool_use' : 'end_turn'}},{type:'message_stop'});
  response.writeHead(200, {'Content-Type':'text/event-stream'});
  response.end(events.map(event => 'data: '+JSON.stringify(event)+'\n\n').join(''));
}
const api = http.createServer(async (request, response) => {
  try {
    assert.equal(request.url,'/v1/messages');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const {messages,stream:streaming} = JSON.parse(Buffer.concat(chunks));
    const blocks = messages.flatMap(message => message.content);
    assert.ok(!blocks.some(block => block.id === 'bad-from-disk' || block.tool_use_id === 'bad-from-disk'),
      'Damaged tool exchange must be left out of the provider request');
    const result = messages.at(-1).content.find(part => part.type === 'tool_result');
    if (result) {
      const outcome = JSON.parse(result.content);
      assert.equal(outcome.ok,true, result.content);
      assert.equal(outcome.objectIds.length,1);
      if (phase === 'create') layer = outcome.objectIds[0];
      else assert.equal(outcome.objectIds[0],layer,'Only edit the existing image');
      return stream(response,[], 'Completed '+phase);
    }
    attempts++;
    if (!streaming) {
      assert.equal(attempts,2,'Only the interrupted step should be repeated without streaming');
      response.writeHead(200,{'Content-Type':'application/json'});
      const input=phase === 'broken' ? incomplete : {
        action:'animate',objectId:layer,animation:{type:'bounce',durationMs:600,loop:true,squashX:.25}
      };
      return response.end(JSON.stringify({content:[{type:'tool_use',id:'retry-edit',name:'edit_artwork',input}],stop_reason:'tool_use'}));
    }
    if (phase === 'create') {
      assert.ok(messages.at(-1).content.some(part => part.type === 'image'));
      return stream(response,[{id:'create-image',name:'place_project_image',args:JSON.stringify({
        target:'canvas',attachment:0,name:'Orange',animation:{type:'bounce',durationMs:900,loop:true}
      })}]);
    }
    if (phase === 'broken' || (phase === 'retime' && attempts === 1)) {
      return stream(response,[
        {id:'discard-edit',name:'edit_artwork',args:JSON.stringify({action:'update',objectId:layer,name:'Uncommitted rename'})},
        {id:'unfinished',name:'edit_artwork',args:incomplete},
      ]);
    }
    return stream(response,[{id:'edit-'+phase,name:'edit_artwork',args:JSON.stringify({
      action:'animate',objectId:layer,animation:{type:'bounce',durationMs:phase === 'retime' ? 600 : 450,loop:true,squashX:.25}
    })}]);
  } catch (error) {
    protocolError = error;
    response.writeHead(500);
    response.end('Fixture contract error');
  }
});
async function launch() {
  const env = {...process.env,SF_USERDATA:profile};
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({executablePath:process.env.STORYFORGE_EXE || require('electron'),
    args:[...(process.env.STORYFORGE_EXE ? [] : ['.']), '--user-data-dir='+profile],cwd:root,env});
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  await app.evaluate(({BrowserWindow}) => { const win=BrowserWindow.getAllWindows()[0]; win.unmaximize(); win.setContentSize(1440,900); });
  await page.waitForFunction(name => document.querySelector('#projectTitle')?.value === name,title).catch(async error => {
    const details = await page.evaluate(() => ({ready:document.readyState,loadedTitle:document.querySelector('#projectTitle')?.value,
      startupError:document.querySelector('body > div > pre')?.textContent?.slice(0,400)}));
    throw new Error('Fixture failed to open: '+JSON.stringify(details),{cause:error});
  });
  await page.locator('#newWorkspaceTab').click();
  await page.locator('[data-start="assistant"]').click();
}
async function close() {
  if (!app) return;
  const instance = app;
  app = null;
  const child = instance.process();
  const closed = instance.waitForEvent('close',{timeout:8000}).catch(() => { if (child.exitCode === null) child.kill(); });
  await instance.evaluate(({app}) => { setImmediate(() => app.exit(0)); }).catch(() => {});
  await closed;
}
async function submit(stage, prompt) {
  phase=stage;
  attempts=0;
  await page.locator('#aiInput').fill(prompt);
  await page.locator('[data-ai-act="send"]').click();
  await page.waitForFunction(({prompt,stage}) => {
    const status=document.querySelector('.chat-status')?.textContent;
    const composer=document.querySelector('#aiInput');
    if (!status || !composer || /^Шаг |^Step /i.test(status)) return false;
    const reply=Array.from(document.querySelectorAll('.msg-assistant .msg-bubble')).some(el => el.textContent.trim()==='Completed '+stage);
    return reply || (composer.value===prompt && !/Ctrl\+Enter/i.test(status));
  },{prompt,stage});
  if (protocolError) throw protocolError;
  if (stage !== 'broken') {
    assert.equal(await page.getByText('Completed '+stage,{exact:true}).count(),1,await page.locator('.chat-status').innerText());
  }
}
async function verifyLayer(duration) {
  await page.locator('#aiInput').focus();
  await page.keyboard.press('Control+s');
  let nodes;
  for (let i=0;i<100;i++) {
    const project = JSON.parse(await fs.readFile(file,'utf8'));
    nodes = project.gigmaWorkspaces.find(item => item.id === 'gg_assistant')?.document?.pages[0].nodes;
    if (nodes?.[0]?.animation?.durationMs === duration) break;
    await new Promise(resolve => setTimeout(resolve,50));
  }
  assert.equal(nodes?.length,1);
  assert.equal(nodes[0].id,layer);
  assert.equal(nodes[0].name,'Orange','No earlier sibling from a malformed tool batch may leak through');
  assert.match(nodes[0].image,/^data:image\//);
  assert.deepEqual(nodes[0].animation,{type:'bounce',durationMs:duration,loop:true,...(duration === 900 ? {} : {squashX:.25})});
}
async function verifySqueeze() {
  const frame=page.frameLocator('.gigma-panel:not([hidden]) iframe');
  const image=frame.locator('[data-object="'+layer+'"] image');
  await frame.getByTitle('Остановить анимацию',{exact:true}).waitFor();
  const widths=await image.evaluate(async el => {
    const motion=el.ownerDocument.getAnimations().find(anim => anim.animationName === 'gigma-bounce');
    motion.pause();
    await motion.ready;
    const sample = time => { motion.currentTime=time; return el.getBoundingClientRect().width; };
    const duration=Number(motion.effect.getTiming().duration);
    const result=[sample(0),sample(duration*.24),sample(duration*.48)];
    motion.play();
    return result;
  });
  assert.ok(widths[0]>0 && Math.abs(widths[1]/widths[0]-.75)<.01 && Math.abs(widths[2]/widths[0]-1)<.01,
    'Visible photo narrows to 75% at the apex and recovers on landing: '+widths);
}
try {
  await new Promise(resolve => api.listen(0,'127.0.0.1',resolve));
  await fs.writeFile(file,JSON.stringify(createEmptyProject({meta:{title}})));
  await fs.writeFile(path.join(profile,'settings.json'),JSON.stringify({lastPath:file,resumeLastProject:true,language:'ru',
    ai:{preset:'anthropic',baseUrl:'http://127.0.0.1:'+api.address().port+'/v1',model:'fixture',apiKey:'local-fixture'}}));
  await launch();
  await page.locator('#aiImageFiles').setInputFiles({name:'orange.png',mimeType:'image/png',buffer:photo});
  await page.locator('[data-photo-options]').waitFor();
  await submit('create','Place the photo with a bounce');
  await verifyLayer(900);
  await submit('retime','Change the existing bounce duration');
  assert.equal(attempts,2,'Retry only the malformed step');
  await verifyLayer(600);
  await verifySqueeze();
  await close();

  // A build that accepted a corrupt tool call could persist it alongside a tool
  // result. A reopened project must retain the valid earlier photo and context.
  const historyFile = projectFiles.scopedFile(profile,'history',file);
  const history = JSON.parse(await fs.readFile(historyFile,'utf8'));
  assert.ok(history.some(item => item.content === 'Completed retime'));
  history.push({role:'user',content:'Old edit'}, {role:'assistant',content:'',toolCalls:[{id:'bad-from-disk',name:'edit_artwork',arguments:incomplete}]},
    {role:'tool',toolCallId:'bad-from-disk',name:'edit_artwork',content:'{"error":"incomplete"}'});
  await fs.writeFile(historyFile,JSON.stringify(history));
  await launch();
  await page.getByText('Completed retime',{exact:true}).waitFor();
  const draft='Try editing the photo again';
  await submit('broken',draft);
  assert.equal(attempts,2,'Stop retrying a repeatedly malformed response');
  assert.equal(await page.locator('#aiInput').inputValue(),draft);
  assert.doesNotMatch(await page.locator('.chat-status').innerText(),/Unterminated|SyntaxError|position \d+/i);
  await verifyLayer(600);
  await submit('recovered','Finish the photo edit');
  assert.equal(attempts,1);
  await verifyLayer(450);
  console.log('PASS: same-layer edits, visible squeeze at the apex, bounded non-stream retry, rollback, draft recovery and reopened chat history.');
} finally {
  await close();
  api.closeAllConnections();
  api.close();
  const folder=await fs.realpath(profile);
  assert.equal(path.dirname(folder),await fs.realpath(os.tmpdir()));
  assert.match(path.basename(folder),/^StoryForge-Followup-/);
  await fs.rm(folder,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
