import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { createAI } from '../src/js/ai.js';
import { createEmptyProject, Store } from '../src/js/model.js';

const lead = 'lead-model';
const collaborators = ['dialogue-model', 'continuity-model'];
const ideas = ['Над входом мигает лампа.', 'Вера держит записку.'];

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function until(done) {
  const deadline = Date.now() + 2500;
  while (!done() && Date.now() < deadline) await pause(5);
  assert.ok(done(), 'both collaborators should be running before either has to finish');
}

function teamChat(chat, { teamMode = true } = {}) {
  const store = new Store();
  store.setProject(createEmptyProject({ screenplay:'Вера у подъезда.' }), { filePath:'One.sfproj' });
  const history = new Map(), aborts = [];
  globalThis.window = { sf: {
    ai: { chat, abort: requestId => { aborts.push(requestId); } },
    history: { read: key => history.get(key) || [], write: (items, key) => history.set(key, structuredClone(items)) },
  } };
  const app = createAI({ store, root:null, ui:{
    escapeHTML:String, settings:{ ai:{ baseUrl:'http://127.0.0.1/v1', model:lead, teamMode,
      teamModels: collaborators[0] + ' | Реплики\n' + collaborators[1] + ' | Ход событий' } },
  } });
  return { app, store, history, aborts };
}

test('parallel teammates contribute to one coordinator graph edit and one undo', async () => {
  const barrier = deferred(), started = [], toolAccess = [], coordinatorMessages = [];
  const chat = teamChat(async ({ body }) => {
    const i = collaborators.indexOf(body.model);
    if (i !== -1) {
      started.push(body.model);
      toolAccess.push(Boolean(body.tools?.length));
      await barrier.promise;
      return { ok:true, content:ideas[i] };
    }
    assert.equal(body.model, lead);
    coordinatorMessages.push(JSON.stringify(body.messages));
    if (coordinatorMessages.length === 1) {
      return { ok:true, toolCalls:[{id:'build',name:'build_story_graph',arguments:JSON.stringify({nodes:[
        {key:'arrival',type:'scene',text:ideas[0]}, {key:'clue',type:'end',text:ideas[1]},
      ]})}] };
    }
    return { ok:true, content:'Готово' };
  });
  const before = chat.store.snapshot();
  const sending = chat.app.send('Обсудите сцену и разложите её в схему.');
  try {
    await until(() => started.length === 2);
    assert.deepEqual(coordinatorMessages, []);
    assert.deepEqual(toolAccess, [false, false]);
  } finally {
    barrier.resolve();
    await sending;
  }
  assert.deepEqual(new Set(started), new Set(collaborators));
  assert.equal(coordinatorMessages.length, 2);
  assert.ok(ideas.every(idea => coordinatorMessages[0].includes(idea)));
  assert.deepEqual(chat.store.project.nodes.map(n => n.text), ideas);
  chat.store.undo();
  assert.deepEqual(chat.store.project, before);
  assert.equal(chat.store.canUndo(), false);
});

test('one unavailable teammate does not drop contributions from the other', async () => {
  let coordinator;
  const chat = teamChat(async ({body}) => {
    if (body.model === collaborators[0]) return { ok:false, error:'Mock model offline' };
    if (body.model === collaborators[1]) return { ok:true, content:ideas[1] };
    coordinator = JSON.stringify(body.messages);
    return { ok:true, content:'Ответ соавтора учтён.' };
  });
  await chat.app.send('Помогите проработать сцену');
  assert.ok(coordinator?.includes(ideas[1]));
  assert.equal(chat.store.canUndo(), false);
});

test('disabled team mode talks only to the selected main model', async () => {
  const calls = [];
  const chat = teamChat(async ({body}) => {
    calls.push(body.model);
    return { ok:true,content:'Готово' };
  }, {teamMode:false});
  await chat.app.send('Короткий вопрос');
  assert.deepEqual(calls, [lead]);
});

test('a model that rejects image input leaves the visual teammate and coordinator able to finish', async () => {
  const photo = { name:'scene.png', data:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==', thumb:'data:image/webp;base64,UklGRg==' };
  const visual = [];
  const chat = teamChat(async ({ body }) => {
    const parts = body.messages.at(-1).content;
    assert.ok(parts.some(part => part.type === 'image_url' && part.image_url.url === photo.data));
    if (body.model === collaborators[0]) return { ok:false, error:'HTTP 400: model does not support image input' };
    visual.push(body.model);
    if (body.model === collaborators[1]) return { ok:true, content:'На вывеске написано «Кино».' };
    assert.ok(parts.some(part => part.type === 'text' && part.text.includes('«Кино»')));
    return { ok:true, content:'Кино' };
  });
  await chat.app.send('Что написано на вывеске?', [photo]);
  assert.deepEqual(visual, [collaborators[1], lead]);
  assert.equal(chat.store.canUndo(), false);
});

test('switching projects while teammates work keeps all late results out of the next story', async () => {
  const barrier = deferred(), writers = [], observed = [];
  const chat = teamChat(async ({ body }) => {
    observed.push(body.model);
    if (collaborators.includes(body.model)) {
      writers.push(body.model);
      await barrier.promise;
      return { ok:true,content:'Мы изменили старую историю.' };
    }
    return { ok:true, content:'Поздний ответ.' };
  });
  const sending = chat.app.send('Обсудите первый проект');
  try {
    await until(() => writers.length === 2);
    chat.store.setProject(createEmptyProject({screenplay:'Совсем другая история.'}),{filePath:'Two.sfproj'});
  } finally {
    barrier.resolve();
    await sending;
  }
  assert.ok(!observed.includes(lead));
  assert.equal(chat.store.project.screenplay,'Совсем другая история.');
  assert.equal(chat.store.canUndo(),false);
  assert.equal(chat.history.has('Two.sfproj'),false);
});
