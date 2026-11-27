// Verify the preview, preload and packaged IPC without using a real account.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { _electron } = require('playwright-core');
const root = fileURLToPath(new URL('../', import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'StoryForge-Provider-'));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNXsAAAAASUVORK5CYII=';
let mockError;
const seen = [];
const api = http.createServer(async (req, res) => {
  try {
    seen.push(req.url);
    res.setHeader('content-type','application/json');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === '/v1/images/generations') {
      assert.equal(req.headers.authorization,'Bearer image-test');
      assert.equal(req.headers['x-api-key'],undefined);
      assert.equal(JSON.parse(Buffer.concat(chunks)).model,'test-image');
      return res.end(JSON.stringify({data:[{b64_json:png}]}));
    }
    assert.equal(req.headers['x-api-key'],'claude-test');
    if (req.url === '/v1/models') return res.end(JSON.stringify({data:[{id:'test-claude'}]}));
    assert.equal(req.url,'/v1/messages');
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.model,'test-claude');
    assert.equal(body.system,'Context');
    assert.equal(body.messages[0].content[0].text,'Draw');
    res.end(JSON.stringify({role:'assistant',content:[{type:'text',text:'OK'}],stop_reason:'end_turn',usage:{}}));
  } catch (err) { mockError=err; res.statusCode=500; res.end('{}'); }
});
api.listen(0,'127.0.0.1');
await once(api,'listening');
const baseUrl='http://127.0.0.1:'+api.address().port+'/v1';
let app;
try {
  await fs.writeFile(path.join(profile,'settings.json'),JSON.stringify({ai:{preset:'anthropic',baseUrl,model:'test-claude',apiKey:'claude-test',imageBaseUrl:baseUrl,imageModel:'test-image',imageApiKey:'image-test'}}));
  const env={...process.env,SF_USERDATA:profile};
  delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({cwd:root,executablePath:process.env.STORYFORGE_EXE || require('electron'),
    args:[...(process.env.STORYFORGE_EXE ? [] : ['.']),'--user-data-dir='+profile], env});
  const page=await app.firstWindow();
  await page.locator('#newWorkspaceTab').waitFor();
  const data=await page.evaluate(async () => {
    const cfg=(await window.sf.settings.get()).ai;
    const tested=await window.sf.ai.test(cfg);
    const answer=await window.sf.ai.chat({...cfg,body:{model:cfg.model,max_tokens:128,stream:true,messages:[{role:'system',content:'Context'},{role:'user',content:'Draw'}]}});
    const { registerProjectTools } = await import('./js/ai-project-tools.js');
    const { Store } = await import('./js/model.js');
    const { planProjectEdits } = await import('./js/ai-transaction.js');
    const { makeProjectReference } = await import('./js/project-references.js');
    const store = new Store();
    store.apply({op:'createNode',node:{id:'image_scene',type:'scene',title:'Glass'}});
    const run = {plan:planProjectEdits(store),message:{origin:{workspaceId:'gg_assistant'}}};
    const tools = new Map();
    registerProjectTools({tool:(name,description,schema,execute) => tools.set(name,execute),active:() => run,
      project:() => run.plan.project,stage:ops => run.plan.apply(ops),ui:{},generateImage:window.sf.ai.generateImage});
    const generated = await tools.get('generate_project_image')({prompt:'A glass',target:'canvas'});
    const sourceRef = makeProjectReference(run.plan.project,{kind:'gigma',workspaceId:generated.workspaceId,
      pageId:generated.pageId,objectId:generated.objectIds[0]});
    const placed = await tools.get('place_project_image')({sourceRef,target:'node',nodeId:'image_scene'});
    run.message.images = [{name:'Portrait',data:run.plan.project.media[placed.mediaId].data}];
    const bounced=await tools.get('place_project_image')({attachment:0,target:'canvas',animation:{type:'bounce',loop:true}});
    run.plan.commit('Create and attach a photo');
    const stored = store.project.media[placed.mediaId];
    const bouncedLayer=store.project.gigmaWorkspaces.find(w=>w.id===bounced.workspaceId).document.pages
      .find(p=>p.id===bounced.pageId).nodes.find(n=>n.id===bounced.objectIds[0]);
    const image = {w:stored.w,h:stored.h,preview:store.project.nodes[0].previewId === placed.mediaId,bounce:bouncedLayer.animation.type};
    store.undo();
    image.undone = Object.keys(store.project.media).length === 0 && store.project.gigmaWorkspaces.length === 0;
    const local=await window.sf.ai.readLink('https://127.0.0.1/test');
    return {tested,answer,image,local};
  });
  if (mockError) throw mockError;
  assert.equal(data.tested.models[0],'test-claude');
  assert.equal(data.answer.content,'OK',data.answer.error);
  assert.deepEqual(data.image,{w:1,h:1,preview:true,bounce:'bounce',undone:true});
  assert.equal(data.local.ok,false);
  assert.deepEqual(seen,['/v1/models','/v1/messages','/v1/images/generations']);
  console.log('Desktop provider bridge passed: Claude, generated image and private link rejection.');
} finally {
  if (app) await app.close();
  api.closeAllConnections();
  api.close();
  await fs.rm(profile,{recursive:true,force:true,maxRetries:4,retryDelay:200});
}
