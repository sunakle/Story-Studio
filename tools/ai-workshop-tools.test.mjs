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
  const bodies = [], revealed = [];
  globalThis.window = {sf:{ai:{abort() {},async chat({body}) {
    const last = body.messages.filter(m => m.role === 'tool').at(-1);
    bodies.push(body);
    return rounds(bodies.length - 1,last && JSON.parse(last.content),body);
  },...overrides},history:{read:key => history.get(key) || [],write:(messages,key) => history.set(key,messages)}}};
  const app = createAI({root:null,store,ui:{escapeHTML:String,settings:{ai:{baseUrl:'http://localhost/v1',model:'fixture'}},
    workbench:{assistantContext:() => ({...art}),current:() => art.view,navigationRevision:() => art.revision || 0,flushDesigns:() => true,
      revealWorkshopLayer:layer => revealed.push(layer)}}});
  return {store,app,bodies,art,history,revealed};
}

test('a two-step animation edit keeps concurrent camera, workspace name and unrelated layers through undo', async () => {
  const workspaceId = 'gg_assistant';
  let objectId, pageId, secondPageId, otherId, beforeRevision;
  const {store,app} = fixture(i => {
    if (!i) return call('get_artwork',{workspaceId,pageId,objectId});
    if (i === 1) return call('edit_artwork',{action:'animate',workspaceId,pageId,objectId,animation:{type:'bounce',durationMs:800}});
    if (i === 2) return call('edit_artwork',{action:'update',workspaceId,pageId,objectId,animation:{type:'bounce',squashX:.25}});
    const added = planArtworkEdit(store.project,{action:'create',workspaceId,pageId,kind:'rect',name:'Manual'});
    otherId = added.objectIds[0];
    store.apply(added.ops);
    const doc = structuredClone(store.project.gigmaWorkspaces.find(w => w.id === workspaceId).document);
    doc.pages.find(p => p.id === pageId).view = {x:61,y:-27,zoom:.44};
    doc.activePageId = secondPageId;
    beforeRevision = ++doc.revision;
    store.apply({op:'updateGigmaWorkspace',id:workspaceId,name:'Author workspace',document:doc});
    return {ok:true,content:'Done'};
  });
  const photo = planArtworkEdit(store.project,{action:'create',workspaceId,kind:'image',imageData:png,name:'Photo'});
  store.apply(photo.ops);
  [objectId] = photo.objectIds; pageId = photo.pageId;
  const next = planArtworkEdit(store.project,{action:'createPage',workspaceId,name:'Next'});
  store.apply(next.ops); secondPageId = next.pageId;
  const initial = structuredClone(store.project.gigmaWorkspaces.find(w => w.id === workspaceId).document);
  initial.activePageId = pageId;
  store.apply({op:'updateGigmaWorkspace',id:workspaceId,document:initial});
  const completed = await app.send('Edit the photo');
  assert.equal(completed.error,null);
  for (const afterUndo of [false,true]) {
    if (afterUndo) assert.equal(store.undo().ok,true);
    const workspace = store.project.gigmaWorkspaces.find(w => w.id === workspaceId);
    const page = workspace.document.pages.find(p => p.id === pageId);
    assert.equal(workspace.name,'Author workspace');
    assert.equal(workspace.document.activePageId,secondPageId);
    assert.deepEqual(page.view,{x:61,y:-27,zoom:.44});
    assert.equal(page.nodes.find(n => n.id === otherId).name,'Manual');
    assert.deepEqual(page.nodes.find(n => n.id === objectId).animation,afterUndo ? undefined : {type:'bounce',durationMs:800,squashX:.25});
    if (!afterUndo) assert.ok(workspace.document.revision > beforeRevision);
  }
});

test('a follow-up reuses valid history around a malformed legacy tool exchange and a blank reply', async () => {
  const {store,app,history,bodies} = fixture(() => ({ok:true,content:'Updated.'}));
  const original = [
    {role:'user',content:'Add the orange photo'},
    {role:'assistant',content:'',toolCalls:[{id:'good',name:'get_artwork',arguments:'{}'}]},
    {role:'tool',toolCallId:'good',content:'{"objectId":"orange"}'},
    {role:'assistant',content:'',toolCalls:[{id:'bad',name:'edit_artwork',arguments:'{"name":"partial'}]},
    {role:'tool',toolCallId:'bad',content:'{"error":"bad arguments"}'},
    {role:'assistant',content:'The photo has ID orange.'},
    {role:'user',content:'Make it bounce'},
    {role:'assistant',content:'',tools:[]},
  ];
  history.set(store.documentKey,structuredClone(original));
  const result = await app.send('Continue that edit');
  assert.equal(result.error,null);
  const messages = bodies[0].messages;
  assert.deepEqual(messages.filter(m => m.tool_calls).flatMap(m => m.tool_calls.map(c => c.id)),['good']);
  assert.deepEqual(messages.filter(m => m.role === 'tool').map(m => m.tool_call_id),['good']);
  assert.ok(messages.some(m => m.content === 'The photo has ID orange.'));
  assert.ok(messages.some(m => m.content === 'Make it bounce'));
  assert.ok(!messages.some(m => m.role === 'assistant' && !m.tool_calls && !m.content));
  assert.deepEqual(history.get(store.documentKey).slice(0,original.length),original);
});

test('empty or incomplete responses retry once in non-stream mode from the last completed tool', async () => {
  for (const failure of [{ok:true,content:'   '},{ok:false,code:'INCOMPLETE_AI_STREAM',error:'Interrupted'}]) {
    const {store,app,bodies,history} = fixture((i,last,body) => {
      if (!i) return call('edit_screenplay',{mode:'append',text:'One line.'});
      if (i === 1) return failure;
      assert.equal(body.stream,false);
      assert.ok(last);
      assert.equal(body.messages.filter(m => m.role === 'tool').length,1);
      return {ok:true,content:'The line was added.'};
    });
    const result = await app.send('Append one line');
    assert.equal(result.error,null);
    assert.equal(store.project.screenplay,'One line.');
    assert.deepEqual(bodies.map(b => b.stream),[true,true,false]);
    const messages = history.get(store.documentKey);
    assert.equal(messages.filter(m => m.role === 'tool').length,1);
    assert.equal(messages.filter(m => m.role === 'assistant').length,2);
    assert.equal(store.undo().ok,true);
    assert.equal(store.project.screenplay,'');
  }
});

test('repeated truncated tool calls leave no edits or phantom reply, and the next message can succeed', async () => {
  const {store,app,bodies,history} = fixture((i) => {
    if (i > 1) return {ok:true,content:'Ready.'};
    return {ok:true,toolCalls:[
      {id:'one',name:'edit_screenplay',arguments:'{"mode":"append","text":"Partial edit"}'},
      {id:'two',name:'edit_artwork',arguments:'{"objectId":"'},
    ]};
  });
  assert.ok((await app.send('Make the edit')).error);
  assert.deepEqual(bodies.map(b => b.stream),[true,false]);
  assert.equal(store.project.screenplay,'');
  assert.deepEqual(history.get(store.documentKey),[]);
  assert.equal((await app.send('Are you there?')).error,null);
  assert.deepEqual(history.get(store.documentKey).map(m => m.role),['user','assistant']);
});

test('a short follow-up about a selected picture can animate its original layer using the compact palette', async () => {
  let objectId;
  const {store,app,art,bodies} = fixture((i,last) => {
    if (i === 0) return call('place_project_image',{target:'canvas',mediaId:'m_source'});
    if (i === 1) { [objectId] = last.objectIds; return {ok:true,content:'Placed.'}; }
    if (i === 2) return call('edit_artwork',{action:'animate',objectId,animation:{type:'bounce',loop:true}});
    return {ok:true,content:'Updated.'};
  });
  store.apply({op:'addMedia',media:{id:'m_source',name:'Orange',data:png,mime:'image/png',w:1,h:1}});
  assert.ok((await app.send('Вставь фото из библиотеки на холст')).changed);
  Object.assign(art,{objectId,referenceSource:'selection'});
  const updated = await app.send('Сделай так, чтобы при прыжке оно сжималось по горизонтали');
  assert.ok(updated.changed,updated.error);
  const tools = bodies[2].tools.map(t => t.function.name);
  assert.ok(tools.includes('edit_artwork') && tools.includes('expand_project_tools'));
  assert.ok(!tools.includes('edit_screenplay'));
  const artwork = describeArtwork(store.project,{workspaceId:art.workspaceId});
  assert.equal(artwork.total,1);
  assert.equal(artwork.objects[0].id,objectId);
  assert.equal(artwork.objects[0].animation.type,'bounce');
});

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

test('one photo placement creates native bounce, offers full tools on demand and plays only a surviving visible workshop layer', async () => {
  for (const outcome of ['usual','navigated','reopened','removed']) {
    let objectId;
    const {app,store,art,revealed}=fixture((round,result,body) => {
      const names=body.tools.map(x=>x.function.name);
      if (round===0) {
        assert.ok(names.includes('place_project_image')); assert.ok(!names.includes('edit_screenplay'));
        return call('expand_project_tools',{});
      }
      assert.ok(names.includes('edit_screenplay'));
      if (round===1) return call('place_project_image',{target:'canvas',mediaId:'m_source',name:'Portrait',animation:{type:'bounce',loop:true}});
      if (round===2) {
        assert.equal(result.objectIds.length,1); [objectId]=result.objectIds;
        if (outcome==='navigated') Object.assign(art,{view:'screenplay',surface:'sidebar'});
        if (outcome==='reopened') art.revision=2;
        if (outcome==='removed') return call('edit_artwork',{action:'animate',objectId,animation:null});
      }
      return {ok:true,content:'Ready'};
    });
    store.apply({op:'addMedia',media:{id:'m_source',name:'Original',data:png,mime:'image/png',w:1,h:1}});
    const before=store.snapshot();
    const done=await app.send('Animate this photo with a bounce',[{name:'photo.png',data:png}]);
    assert.ok(done.changed);
    const layer=describeArtwork(store.project,{workspaceId:'gg_assistant',objectId}).objects[0];
    assert.equal(layer.animation?.type,outcome==='removed'?undefined:'bounce');
    assert.equal(revealed.length,outcome==='usual'?1:0);
    if (revealed.length) assert.deepEqual(revealed[0],{workspaceId:'gg_assistant',pageId:store.project.gigmaWorkspaces.at(-1).document.activePageId,objectId,playAnimation:true});
    store.undo();
    assert.deepEqual(store.project,before);
  }
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
