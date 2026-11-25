import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {atomicWrite, recoveryFiles} from '../project-files.cjs';
import {Store, createEmptyProject, migrateProject} from '../src/js/model.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'sf-file-check-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  return dir;
}
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

test('shipping projects retain IDs, geometry, transitions, embedded images and voices on disk', async t => {
  const dir = await fixture(t);
  for (const name of ['stress-overview.sfproj', 'demo-project.json']) {
    const original = JSON.parse(await fs.readFile(new URL('../demo/' + name, import.meta.url), 'utf8'));
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
