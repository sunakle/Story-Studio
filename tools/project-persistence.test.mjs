import { makeStoryFixture, makeStressFixture } from './test-fixtures.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {atomicWrite, recoveryFiles, saveLocalProject} from '../project-files.cjs';
import {Store, createEmptyProject, migrateProject} from '../src/js/model.js';
import {planProjectEdits} from '../src/js/ai-transaction.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'sf-file-check-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  return dir;
}
test('Local drafts share neither titles nor paths, and retries after a rename reuse the saved file', async t => {
  const dir = path.join(await fixture(t), 'Projects');
  const story = createEmptyProject();
  const save = (key, title, text, createdAt = story.meta.createdAt) => saveLocalProject(dir, {
    key, title, content: JSON.stringify({...story, meta:{...story.meta, title, createdAt}, screenplay:text}),
  });
  const title = 'CON.txt/../Глава?';
  const [first, second] = await Promise.all([save('draft_a', title, 'A'), save('draft_b', title, 'B')]);
  assert.notEqual(first, second);
  assert.equal(path.dirname(first), dir);
  assert.match(path.basename(first), /^_CON\.txt-/);
  assert.equal(path.extname(first), '.sfproj');
  const retried = await Promise.all([save('draft_a', 'Новое название', 'A2'), save('draft_a', 'Ещё одно имя', 'A3')]);
  assert.deepEqual(retried, [first, first]);
  assert.equal(JSON.parse(await fs.readFile(first, 'utf8')).screenplay, 'A3');
  assert.equal(JSON.parse(await fs.readFile(second, 'utf8')).screenplay, 'B');
  assert.equal((await fs.readdir(dir)).length, 2);
  const separate = await save('draft_a', title, 'C', '2024-01-01T00:00:00.000Z');
  assert.notEqual(separate, first);
});
test('A failed write keeps the previous file and cleans its temporary file',async t=>{
  const dir=await fixture(t), file=path.join(dir,'test.sfproj');
  await atomicWrite(file,'original');
  await assert.rejects(atomicWrite(file,{}));
  assert.equal(await fs.readFile(file,'utf8'),'original');
  assert.deepEqual(await fs.readdir(dir),['test.sfproj']);
  await Promise.all([atomicWrite(file,'first'),atomicWrite(file,'last')]);
  assert.equal(await fs.readFile(file,'utf8'),'last');
});
test('Recovery survives restart, separates projects and handles a legacy autosave',async t=>{
  const dir=await fixture(t);
  let recovery=recoveryFiles(dir);
  const save=(key,content)=>recovery.write({key,filePath:key,content});
  await recovery.write('legacy');
  assert.equal((await recovery.read()).content,'legacy');
  await Promise.all([save('A','before'),save('A','after'),save('B','keep')]);
  recovery=recoveryFiles(dir);
  assert.equal((await recovery.read('A')).content,'after');
  assert.equal((await recovery.read('B')).filePath,'B');
  await Promise.all([save('A','pending'),recovery.clear('A')]);
  assert.equal((await recovery.read('A')).ok,false);
  assert.equal((await recovery.read(null)).content,'keep');
});
test('An unchanged retired recovery does not mask an older author draft', async t => {
  const dir = await fixture(t);
  const recovery = recoveryFiles(dir, draft => draft.content === 'unchanged sample');
  await recovery.write({key:'author', filePath:null, content:'edited project'});
  await recovery.write('unchanged sample');
  assert.equal((await recovery.read()).content, 'edited project');
  await recovery.write('user changes to the old sample');
  assert.equal((await recovery.read()).content, 'user changes to the old sample');
});
test('New edits while saving remain dirty, historical media and batch rollback stay intact',()=>{
  const s=new Store();s.setProject(createEmptyProject());
  const change=ops=>assert.equal(s.apply(ops).ok,true);
  change([{op:'createNode',node:{type:'note',id:'journal'}}]);
  assert.ok(!s.project.startNodeId);
  change([{op:'createNode',node:{type:'line',id:'a',text:'first'}}]);
  assert.equal(s.project.startNodeId,'a');
  const rev=s.revision, gen=s.generation;
  change([{op:'updateNode',id:'a',patch:{text:'new'}}]);s.markSaved('A.sfproj',rev);
  assert.equal(s.dirty,true);assert.equal(s.filePath,'A.sfproj');
  const original=s.snapshot();
  assert.equal(s.apply([{op:'updateNode',id:'a',patch:{text:'bad'}},{op:'updateNode',id:'missing',patch:{title:'bad'}}]).ok,false);
  assert.deepEqual(s.project,original);
  change([{op:'addMedia',media:{id:'m',name:'p',data:'data:image/png;base64,bQ=='}},{op:'setNodeMedia',id:'a',media:['m'],previewId:'m'}]);
  const pic=s.snapshot();s.undo();assert.deepEqual(s.project,original);s.redo();assert.deepEqual(s.project,pic);
  s.undo();s.undo();assert.equal(s.project.nodes.find(n=>n.id==='a').text,'first');
  assert.equal(s.generation,gen);s.setProject(pic);assert.ok(s.generation>gen);
});

test('saved projects retain IDs, geometry, transitions, embedded images and voices on disk', async t => {
  const dir = await fixture(t);
  for (const [name, original] of [['large', makeStressFixture()], ['small', makeStoryFixture()]]) {
    const file = path.join(dir, name + '.sfproj');
    const store = new Store();
    store.setProject(migrateProject(structuredClone(original)).project, {filePath:file});
    await atomicWrite(file, JSON.stringify(store.project, null, 2));
    const reopened = migrateProject(JSON.parse(await fs.readFile(file, 'utf8'))).project;
    const links = p => p.nodes.map(n => ({
      id:n.id, position:n.position, next:n.next, choices:n.choices, branches:n.branches,
      speaker:n.speakerId, chapter:n.chapterId, media:n.media || [], preview:n.previewId || ''
    }));
    assert.deepEqual(links(reopened), links(original));
    assert.deepEqual(reopened.voice, original.voice);
    assert.deepEqual(reopened.characters.map(c => c.voice), original.characters.map(c => c.voice));
    assert.deepEqual(reopened.media, original.media);
    assert.deepEqual(reopened.startNodeId, original.startNodeId);
  }
});

function designDocument() {
  const pageId = '2bb28984-1493-43da-b280-3e854a26ab6d';
  return {
    schemaVersion: 1, id: '8ed58d80-f619-4336-a8cb-bdd07e76a67a', name: 'Титры',
    mode: 'design', revision: 1, createdAt: '2026-01-01', updatedAt: '2026-01-02', activePageId: pageId,
    cover: 'data:image/png;base64,iVBORw0KGgo=',
    pages: [{ id: pageId, name: 'Фон', view: { x: -30, y: 70, zoom: 1.3 }, nodes: [{
      id:'2dc993bd-a8cc-401a-bd96-72bc52d5b78d', kind:'text', name:'Заголовок', parentId:null,
      x:4, y:24, width:220, height:40, rotation:0, fill:'#ffffff', stroke:'none', strokeWidth:1,
      opacity:1, radius:0, hidden:false, locked:false, text:'Глава первая', fontSize:24, fontFamily:'Inter',
      fontWeight:'400', textAlign:'left', points:[], image:'', clip:false, linkTo:null, layout:'free', gap:16, padding:24,
    }] }],
  };
}

test('Gigma workspaces round-trip in project and recovery, independently of their open tabs', async t => {
  const store = new Store();
  const legacy = createEmptyProject({screenplay:'Сцена'});
  delete legacy.gigmaWorkspaces;
  const migrated = migrateProject(legacy);
  assert.deepEqual(migrated.warnings, []);
  assert.deepEqual(migrated.project.gigmaWorkspaces, []);
  store.setProject(migrated.project);
  const first = store.apply({op:'createGigmaWorkspace', document:designDocument()}).created[0];
  const second = store.apply({op:'createGigmaWorkspace', name:'Раскадровка'}).created[0];
  assert.notEqual(first, second);
  const doc = designDocument();
  doc.pages[0].nodes[0].text = 'После антракта';
  assert.ok(store.apply({op:'updateGigmaWorkspace', id:first, name:'Новые титры', document:doc}).ok);
  doc.pages[0].nodes[0].text = 'external mutation';
  const expected = store.snapshot().gigmaWorkspaces;
  assert.equal(expected[0].document.pages[0].nodes[0].text, 'После антракта');
  assert.deepEqual(expected[1], {id:second, name:'Раскадровка', document:null});
  const dir = await fixture(t);
  const pathName = path.join(dir, 'story.sfproj');
  const content = JSON.stringify(store.project, null, 2);
  await atomicWrite(pathName, content);
  await recoveryFiles(dir).write({key:pathName, filePath:pathName, content});
  for (const saved of [await fs.readFile(pathName, 'utf8'), (await recoveryFiles(dir).read(pathName)).content]) {
    store.setProject(migrateProject(JSON.parse(saved)).project, {filePath:pathName});
    assert.deepEqual(store.project.gigmaWorkspaces, expected);
    assert.equal(store.project.screenplay, 'Сцена');
  }
  assert.ok(store.apply({op:'deleteGigmaWorkspace', id:first}).ok);
  assert.deepEqual(store.project.gigmaWorkspaces, [expected[1]]);
  store.undo();
  assert.deepEqual(store.project.gigmaWorkspaces, expected);
  store.setProject(legacy);
  assert.deepEqual(store.project.gigmaWorkspaces, []);
  assert.equal(store.canUndo(), false);
});

test('canvas snapshots are atomic, share unchanged layers and survive concurrent story edits', () => {
  const store = new Store();
  const id = store.apply({op:'createGigmaWorkspace', document:designDocument()}).created[0];
  const original = store.project.gigmaWorkspaces[0].document;
  const incoming = structuredClone(original);
  const before = store.revision;
  assert.deepEqual(store.apply({op:'updateGigmaWorkspace', id, document:incoming}).changed, []);
  assert.equal(store.revision, before);
  const plan = planProjectEdits(store);
  assert.ok(plan.apply([{op:'setMeta', patch:{author:'Нина'}}]).ok);
  incoming.pages[0].view.zoom = 2;
  assert.equal(store.apply([{op:'updateGigmaWorkspace', id, document:incoming},
    {op:'deleteGigmaWorkspace', id:'missing'}]).ok, false);
  assert.equal(original, store.project.gigmaWorkspaces[0].document);
  assert.ok(store.apply({op:'updateGigmaWorkspace', id, document:incoming}).ok);
  const revised = store.project.gigmaWorkspaces[0].document;
  assert.equal(revised.pages[0].nodes, original.pages[0].nodes);
  assert.equal(revised.pages[0].view.zoom, 2);
  assert.equal(original.pages[0].view.zoom, 1.3);
  plan.commit('Author');
  assert.equal(store.project.gigmaWorkspaces[0].document, revised);
  store.undo();
  assert.equal(store.project.gigmaWorkspaces[0].document, revised);
  store.undo();
  assert.equal(store.project.gigmaWorkspaces[0].document, original);
  store.redo();
  assert.equal(store.project.gigmaWorkspaces[0].document, revised);
  const cyclic = designDocument();
  cyclic.invalid = cyclic;
  assert.equal(store.apply({op:'updateGigmaWorkspace', id, document:cyclic}).ok, false);
  assert.equal(store.project.gigmaWorkspaces[0].document, revised);
});
