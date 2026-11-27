import assert from 'node:assert/strict';
import test from 'node:test';
import { createAI } from '../src/js/ai.js';
import { createAutonomy } from '../src/js/ai-autonomy.js';
import { describeArtwork, planArtworkEdit } from '../src/js/ai-artwork.js';
import { Store } from '../src/js/model.js';
import { makeProjectReference } from '../src/js/project-references.js';
import { messageLinks } from '../src/js/ai-project-tools.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise,resolve}; };
const call = (name, args) => ({ok:true,toolCalls:[{id:crypto.randomUUID(),name,arguments:JSON.stringify(args)}]});
function fixture(rounds, overrides = {}) {
  const store = new Store(), history = new Map(), art = {surface:'workshop',view:'assistant',title:'AI Studio',workspaceId:'gg_assistant'};
  const bodies = [];
  globalThis.window = {sf:{ai:{abort() {},async chat({body}) {
    const last = body.messages.filter(m => m.role === 'tool').at(-1);
    bodies.push(body);
    return rounds(bodies.length - 1,last && JSON.parse(last.content),body);
  },...overrides},history:{read:key => history.get(key) || [],write:(messages,key) => history.set(key,messages)}}};
  const app = createAI({root:null,store,ui:{escapeHTML:String,settings:{ai:{baseUrl:'http://localhost/v1',model:'fixture'}},
    workbench:{assistantContext:() => ({...art}),flushDesigns:() => true}}});
  return {store,app,bodies,art,history};
}

test('chat routes frozen source, explicit links, artwork, animation and project media through one undo', async () => {
  let marker, canvasId, objectRef;
  const fetched = [];
  const {store,app,bodies,art,history} = fixture((round, result, body) => {
    assert.ok(body.messages.find(m => m.role === 'user').content.includes('"surface":"workshop"'));
    assert.ok(body.tools.some(t => t.function.name === 'generate_project_image'));
    if (round === 0) {
      art.surface = 'sidebar'; art.workspaceId = 'gg_project';
      return call('edit_artwork',{action:'create',kind:'rect',name:'Editorial',x:48,y:64,fill:'#2288aa'});
    }
    if (round === 1) {
      assert.equal(result.workspaceId,'gg_assistant');
      [marker] = result.objectIds; canvasId = result.pageId;
      return call('edit_artwork',{action:'animate',objectId:marker,animation:{type:'pulse',durationMs:800,loop:true}});
    }
    if (round === 2) return call('get_artwork',{objectId:marker});
    if (round === 3) {
      objectRef = result.objects[0].ref;
      assert.ok(objectRef.includes('?project='));
      return call('resolve_project_reference',{url:objectRef});
    }
    if (round === 4) {
      assert.equal(result.objects[0].animation.type,'pulse');
      return call('read_web_link',{url:'https://example.net/derived'});
    }
    if (round === 5) {
      assert.ok(result.error);
      return call('read_web_link',{url:'https://example.org/project'});
    }
    if (round === 6) {
      assert.equal(result.kind,'untrusted_web_content');
      return call('place_project_image',{target:'canvas',mediaId:'m_source',name:'Reference photo'});
    }
    if (round === 7) {
      assert.equal(result.pageId,canvasId);
      return call('edit_screenplay',{mode:'append',text:'The windows open.'});
    }
    return {ok:true,content:'Done.'};
  },{readLink:async url => {fetched.push(url); return {ok:true,text:'Reference text',title:'Film brief'};}});
  store.apply({op:'addMedia',media:{id:'m_source',name:'Reference',data:png,mime:'image/png',w:1,h:1}});
  const before = store.snapshot();
  await app.send('Use https://example.org/project, build and animate a shape, add the reference photo and update the script.');
  assert.equal(bodies.length,9);
  assert.deepEqual(fetched,['https://example.org/project']);
  assert.equal(store.project.screenplay,'The windows open.');
  const ws = describeArtwork(store.project,{workspaceId:'gg_assistant'});
  assert.deepEqual(ws.objects.map(n => n.kind),['rect','image']);
  assert.equal(history.get(store.documentKey)[0].origin.workspaceId,'gg_assistant');
  assert.ok(!JSON.stringify(bodies).includes(png));
  assert.equal(store.undo().ok,true);
  assert.deepEqual(store.project,before);
  assert.equal(store.redo().ok,true);
  assert.equal(describeArtwork(store.project,{workspaceId:'gg_assistant'}).objects[0].id,marker);
});

test('image generator failure discards all staged changes and bad links cannot redirect the fetcher', async () => {
  let native;
  const {app,store,history} = fixture((i,last) => {
    if (!i) return call('edit_screenplay',{mode:'append',text:'Phantom'});
    if (i === 1) return call('generate_project_image',{target:'canvas',prompt:'Sunrise'});
    assert.match(last.error,/model unavailable/);
    return {ok:true,content:'Generation failed'};
  },{generateImage:async args => {native=args;return {ok:false,error:'model unavailable'};}});
  const res = await app.send('Generate a sunrise.');
  assert.equal(native.prompt,'Sunrise'); assert.ok(native.requestId);
  assert.match(res.error,/model unavailable/);
  assert.equal(store.project.screenplay,'');
  assert.equal(history.get(store.documentKey).length,0);
  assert.deepEqual([...messageLinks('[source](https://example.org/wiki/Test_(film)). Next https://u:p@example.org/')],['https://example.org/wiki/Test_(film)']);
});

test('manual edits to a canvas read by the model cancel its cross-editor operation', async () => {
  let ref;
  const {store,app} = fixture((i,last) => {
    if (i === 0) return call('resolve_project_reference',{url:ref});
    if (i === 1) {
      assert.equal(last.objects[0].name,'Original');
      store.apply(planArtworkEdit(store.project,{objectRef:ref,action:'update',name:'Hand edit'}).ops);
      return call('edit_screenplay',{mode:'append',text:'Stale title'});
    }
    return {ok:true,content:'Done'};
  });
  const source = planArtworkEdit(store.project,{action:'create',kind:'rect',name:'Original',workspaceId:'gg_project'});
  store.apply(source.ops);
  ref = makeProjectReference(store.project,{kind:'gigma',workspaceId:source.workspaceId,pageId:source.pageId,objectId:source.objectIds[0]});
  assert.ok((await app.send('Use this layer '+ref)).error);
  assert.equal(store.project.screenplay,'');
  assert.equal(describeArtwork(store.project).objects[0].name,'Hand edit');
});

test('late generated bytes cannot enter a different project and native cancellation includes the image request', async () => {
  let id;
  const started = deferred(), done = deferred(), aborted = [];
  const {store,app} = fixture(() => call('generate_project_image',{prompt:'Meadow',target:'canvas'}),{
    generateImage:async args => {id=args.requestId;started.resolve();return done.promise;},
    abort:req => aborted.push(req),
  });
  const sending = app.send('Generate a meadow');
  await started.promise;
  const newProject = (new Store()).project;
  store.setProject(newProject,{filePath:'Second.sfproj'});
  done.resolve({ok:true,dataUrl:png});
  await sending;
  assert.ok(aborted.includes(id));
  assert.deepEqual(store.project.gigmaWorkspaces,[]);
});

test('long layer reference is readable in full through valid paginated tool results', async () => {
  const script = ('Сцена "берег".\n🌊\n').repeat(1900);
  let ref, assembled='';
  const {app,store} = fixture((i,res) => {
    if (res) {
      assembled += res.objects[0].text;
      if (res.nextTextOffset === null) return {ok:true,content:'Read.'};
    }
    return call('resolve_project_reference',{url:ref,offset:res?.nextTextOffset || 0});
  });
  const source=planArtworkEdit(store.project,{action:'create',kind:'text',text:script,workspaceId:'gg_project'});
  store.apply(source.ops);
  ref=makeProjectReference(store.project,{kind:'gigma',workspaceId:source.workspaceId,pageId:source.pageId,objectId:source.objectIds[0]});
  await app.send('Прочитай текст '+ref);
  assert.equal(assembled,script);
});

test('a manual side-panel request preempts an in-flight autonomous model turn and keeps both project and destination scope', async t => {
  const entered=deferred(), response=deferred();
  let oldRequest;
  const {app,store,art,bodies,history}=fixture((round,last,body) => {
    const current=body.messages.filter(m => m.role==='user').at(-1);
    if (current.content.includes('"mode":"autonomous"')) {
      oldRequest=true;
      assert.ok(!body.tools.some(t => t.function.name==='generate_project_image'));
      entered.resolve();
      return response.promise;
    }
    if (round===1) {
      assert.ok(current.content.includes('"workspaceId":"gg_project"'));
      assert.ok(current.content.includes('"destinationWorkspaceId":"gg_assistant"'));
      return call('edit_artwork',{action:'create',kind:'rect',name:'Manual'});
    }
    return {ok:true,content:'Done.'};
  },{abort() {if (oldRequest) response.resolve(call('edit_artwork',{action:'create',kind:'rect',name:'Discarded'}));}});
  Object.assign(art,{surface:'sidebar',view:'gigma',workspaceId:'gg_project'});
  app.toggleAutonomy();
  t.after(() => {if (app.autonomyState().enabled) app.toggleAutonomy();});
  await entered.promise;
  const result=await app.send('Create a rectangle');
  assert.ok(result.changed); assert.equal(bodies.length,3);
  assert.deepEqual(describeArtwork(store.project,{workspaceId:'gg_assistant'}).objects.map(n=>n.name),['Manual']);
  assert.equal(describeArtwork(store.project,{workspaceId:'gg_project'}).total,0);
  assert.equal(history.get(store.documentKey).filter(m=>m.role==='user').length,1);
});

test('autonomy runs one pass at a time, backs off on idle, yields to a manual turn and stops on project switch', async () => {
  let queued, calls=0, cancelled=0, generation=1, next;
  const clock = {setTimeout(fn,ms) {queued={fn,ms};return queued;},clearTimeout(timer) {if (timer===queued) queued=null;}};
  const auto = createAutonomy({clock,run:async current => {calls++; return next ? next(current) : {changed:false};},
    render() {},cancel() {cancelled++;},generation:() => generation});
  auto.start();
  await queued.fn(); assert.equal(queued.ms,60000);
  await queued.fn(); assert.equal(queued.ms,120000);
  const pending=deferred();
  next=async current => {await pending.promise;assert.equal(current(),false);return {changed:true};};
  const working=queued.fn();
  auto.manualTurn(); assert.equal(queued.ms,30000); assert.equal(cancelled,1);
  pending.resolve(); await working;
  assert.equal(queued.ms,30000);
  generation++; await queued.fn();
  assert.equal(auto.state.enabled,false); assert.equal(calls,3);
});
