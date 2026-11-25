import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmptyProject } from '../src/js/model.js';
import storage from '../project-files.cjs';

const root = fileURLToPath(new URL('../',import.meta.url));
const output = await fs.mkdtemp(path.join(os.tmpdir(),'StoryForge-Alice-'));
const profile = path.join(output,'profile');
const story = path.join(output,'story.sfproj');
const descriptor = path.join(profile,'alice-dictation.json');
const progress = storage.scopedFile(profile,'history','dictation-qa');
const script = path.join(output,'probe.js');
const nap = ms => new Promise(resolve => setTimeout(resolve,ms));
async function waitFor(read, label) {
  for (let i=0; i<400; i++) {
    const value = await read();
    if (value) return value;
    await nap(35);
  }
  throw Error(label);
}
async function json(file) {
  try { return JSON.parse(await fs.readFile(file,'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}
const initial = 'Ночь. ';
const typed = 'Ночь. Авто';
const dictated = 'Героиня подходит к причалу.';
const expected = typed + ' ' + dictated;
await fs.mkdir(profile);
await fs.writeFile(story,JSON.stringify(createEmptyProject({screenplay:initial})));
await fs.writeFile(path.join(profile,'settings.json'),JSON.stringify({lastPath:story,language:'ru',autosave:true}));
async function probe({typed,expected}) {
  const { store, ui, action } = window.__sfTest;
  const bar = document.querySelector('#aliceDictation');
  const wait = async (predicate, label) => {
    for(let i=0; i<400; i++) {
      if (predicate()) return;
      await new Promise(r => setTimeout(r,35));
    }
    throw Error(label);
  };
  const signal = stage => window.sf.history.write([stage],'dictation-qa');
  await wait(() => !bar.hidden && ui.workbench.current() === 'screenplay','Opened screenplay and dictation status');
  const input = document.querySelector('#screenplayText');
  input.value = typed;
  input.dispatchEvent(new Event('input',{bubbles:true}));
  input.setSelectionRange(1,3);
  await signal('typed');
  await wait(() => input.value === expected,'Appended phrase after typed text');
  if(input.selectionStart !== 1 || input.selectionEnd !== 3) throw Error('Manual selection moved');
  await action('edit:undo');
  if(input.value !== typed) throw Error('Undo should remove only dictation');
  await action('edit:redo');
  await action('file:save');
  if(store.dirty || store.project.screenplay !== expected) throw Error('Save failed');
  bar.querySelector('button').click();
  if(!bar.hidden) throw Error('Stop must clear indicator');
  await signal('stopped');
  await wait(() => !bar.hidden,'A fresh session should start');
  store.setProject({...store.project, screenplay:'Другой документ.'});
  if(!bar.hidden) throw Error('Session survived a document change');
  await signal('switched');
  return {text:store.project.screenplay,errors:window.__sfErrors || []};
}
await fs.writeFile(script,'const __sfOut=await (' + probe.toString() + ')(' + JSON.stringify({typed,expected}) + ');');
const runtime = process.env.STORYFORGE_EXE || path.join(root,'node_modules','electron','dist',process.platform === 'win32'?'electron.exe':'electron');
const env = {...process.env,SF_USERDATA:profile,SF_TEST_OUTPUT:output};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(runtime,['--no-sandbox','--user-data-dir='+profile,...(process.env.STORYFORGE_EXE?[]:['.']),
  '--selftest','--selftest-file='+script],{cwd:root,env,windowsHide:true,stdio:'ignore'});
const exited = once(child,'exit');
const timeout = setTimeout(() => child.kill(),65000);
try {
  const connection = await waitFor(() => json(descriptor),'Waiting for installed profile descriptor');
  const session = 'isolated-session';
  async function post(action,extras={}) {
    const res = await fetch('http://127.0.0.1:'+connection.port+'/v1/dictation',{method:'POST',
      headers:{'Content-Type':'application/json', Authorization:'Bearer '+connection.token}, body:JSON.stringify({action,session,...extras})});
    assert.equal(res.status,200);
    return res.json();
  }
  const stage = label => waitFor(async () => (await json(progress))?.[0] === label,label);
  await waitFor(async () => (await post('start')).ok,'Start command');
  await stage('typed');
  assert.equal((await post('append',{seq:2,text:'Future'})).code,'out_of_order');
  assert.equal((await post('append',{seq:1,text:dictated})).lastSeq,1);
  await stage('stopped');
  assert.equal((await post('start')).code,'inactive');
  assert.equal((await post('append',{seq:1,text:dictated})).code,'inactive');
  assert.equal((await post('start',{session:'fresh-session'})).active,true);
  await stage('switched');
  assert.equal((await post('append',{session:'fresh-session',seq:1,text:'Other'})).code,'inactive');
  const [code] = await exited;
  assert.equal(code,0);
  const report = await json(path.join(output,'selftest.json'));
  assert.equal(report?.fatal,undefined);
  assert.deepEqual(report.errors,[]);
  assert.equal(report.text,'Другой документ.');
  assert.equal((await json(story)).screenplay,expected);
  assert.equal(await json(descriptor),null);
  const tempRoot = await fs.realpath(os.tmpdir());
  const verified = await fs.realpath(output);
  assert.equal(path.dirname(verified),tempRoot);
  assert.match(path.basename(verified),/^StoryForge-Alice-/);
  await fs.rm(verified,{recursive:true});
  console.log('Passed native Alice dictation: start, focus, append, caret, undo, save, local stop and project isolation.');
} catch (error) {
  console.error('QA profile:',output);
  const report = await json(path.join(output,'selftest.json'));
  if (report?.fatal) console.error(report.fatal);
  throw error;
} finally {
  clearTimeout(timeout);
  if(child.exitCode === null && child.signalCode === null) child.kill();
}
