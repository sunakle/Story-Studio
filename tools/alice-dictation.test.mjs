import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, createEmptyProject } from '../src/js/model.js';
import { createAliceDictation } from '../src/js/alice-dictation.js';
import endpoint from '../src/native/alice-dictation.cjs';

function editor() {
  const store = new Store();
  store.setProject(createEmptyProject({screenplay:'Начало.'}));
  let time = 0, opened = 0, pending = null;
  const indicator = [];
  const controller = createAliceDictation(store, {
    flushEdits() {
      if (pending !== null) { store.apply({op:'setScreenplay', text:pending}); pending = null; }
    },
    workbench:{openScreenplay() { opened++; }},
  }, {now:() => time, changed:active => indicator.push(active)});
  store.subscribe(controller.expire);
  return {store, indicator, controller, command:(action, extras = {}) => controller.handle({action, session:'test-1', ...extras}),
    type:v => {pending = v;}, wait:ms => {time += ms; controller.expire();}, opened:() => opened};
}

test('Appending after pending typing, retries, gaps, undo, stop and project replacement', () => {
  const e = editor();
  assert.equal(e.command('append', {seq:1,text:'Нет.'}).code,'inactive');
  assert.equal(e.command('start').active,true);
  assert.equal(e.command('start').ok,true);
  assert.equal(e.opened(),1);
  assert.equal(e.command('start', {session:'other'}).code,'busy');
  e.type('Ручная правка.\n');
  assert.equal(e.command('append', {seq:2,text:'Позже.'}).code,'out_of_order');
  assert.equal(e.command('append', {seq:1,text:'Голос.'}).lastSeq,1);
  assert.equal(e.command('append', {seq:1,text:'Голос.'}).lastSeq,1);
  assert.equal(e.store.project.screenplay,'Ручная правка.\nГолос.');
  e.store.undo();
  assert.equal(e.store.project.screenplay,'Ручная правка.\n');
  e.store.redo();
  e.controller.stop();
  assert.equal(e.command('status').code,'inactive');
  assert.equal(e.command('start').code,'inactive');
  assert.equal(e.command('start',{session:'new'}).ok,true);
  e.store.setProject(createEmptyProject());
  assert.equal(e.command('append',{session:'new',seq:1,text:'Старый ввод'}).code,'inactive');
  assert.equal(e.store.project.screenplay,'');
  assert.deepEqual(e.indicator,[true,false,true,false]);
});

test('Heartbeats prevent expiry; disconnect and explicit voice stop end the session', () => {
  const e = editor();
  e.command('start'); e.wait(80000);
  assert.equal(e.command('status').active,true); e.wait(80000);
  assert.equal(e.command('append',{seq:1,text:'Фраза'}).ok,true);
  e.wait(91000);
  assert.equal(e.command('start').code,'inactive');
  assert.equal(e.command('start',{session:'next'}).ok,true);
  assert.equal(e.command('stop',{session:'next'}).active,false);
  assert.equal(e.command('append',{session:'next',seq:1,text:'Лишнее'}).ok,false);
});

test('Only the profile capability can deliver supported commands from a local client', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'sf-dictation-cap-'));
  const calls = [];
  const close = await endpoint.startAliceEndpoint(dir, command => {
    calls.push(command);
    return {ok:true,active:true,lastSeq:0};
  });
  const descriptor = path.join(dir,'alice-dictation.json');
  try {
    const {port,token} = JSON.parse(await fs.readFile(descriptor,'utf8'));
    const post = (body, headers, url='/v1/dictation') => fetch('http://127.0.0.1:' + port + url, {
      method:'POST', headers:{'Content-Type':'application/json', ...headers}, body:JSON.stringify(body),
    });
    const command = {action:'start', session:'from-test'};
    const auth = {Authorization:'Bearer ' + token};
    assert.equal((await post(command,{})).status,401);
    assert.equal((await post(command,{...auth, Origin:'https://example.test'})).status,401);
    assert.equal((await post(command,auth,'/other')).status,404);
    assert.equal((await post({...command, action:'open_file'},auth)).status,400);
    assert.equal((await post({...command, action:'append',seq:0,text:'A'},auth)).status,400);
    assert.equal((await post({...command, action:'append',seq:1,text:'A'.repeat(16001)},auth)).status,400);
    assert.deepEqual(calls,[]);
    assert.equal((await (await post(command,auth)).json()).ok,true);
    assert.deepEqual(calls,[command]);
  } finally {
    close();
    await assert.rejects(fs.stat(descriptor), {code:'ENOENT'});
    await fs.rmdir(dir);
  }
});
