import test from 'node:test';
import assert from 'node:assert/strict';
import { createAI } from '../src/js/ai.js';
import { planProjectEdits } from '../src/js/ai-transaction.js';
import { createEmptyProject, applyOps, Store, validateProject } from '../src/js/model.js';
import { readScreenplay, editScreenplay, planStoryGraph } from '../src/js/screenplay-tools.js';

test('every character of a long notebook can be read through serialized tool responses', () => {
  const source = ('\n"😀\\\u0000\tДлинная строка\r\n').repeat(1800);
  let cursor = 0, replay = '';
  do {
    const page = readScreenplay(source, cursor);
    assert.ok(JSON.stringify(page).length <= 6000);
    assert.ok(!/[\uD800-\uDBFF]$/u.test(page.text));
    replay += page.text;
    cursor = page.nextOffset;
  } while (cursor !== null);
  assert.equal(replay, source);
  assert.equal(readScreenplay('').nextOffset, null);
  assert.throws(() => readScreenplay(source, -1));
  assert.equal(editScreenplay('A\nB', { mode: 'replace', find: 'B', text: 'В' }), 'A\nВ');
  assert.equal(editScreenplay('A', { mode: 'append', text: '\nВ' }), 'A\nВ');
  assert.throws(() => editScreenplay('ааа', { mode: 'replace', find: 'аа', text: 'В' }));
});

const section = { nodes: [
  { key: 'room', type: 'scene', text: 'В тёмной комнате стоит стол.', location: 'Комната' },
  { key: 'line', type: 'line', text: 'Кто там?', speaker: 'Ира', location: 'Комната' },
  { key: 'decision', type: 'choice', choices: [{ text: 'Включить свет', to: 'light' }, { text: 'Уйти', to: 'leave' }] },
  { key: 'light', type: 'end', text: 'Становится светло.' },
  { key: 'leave', type: 'end', text: 'Дверь закрывается.' },
] };

test('graph builder reuses people and places, lays out only the new section and never overwrites links', () => {
  const project = createEmptyProject();
  applyOps(project, [
    { op: 'createCharacter', character: { id: 'ira', name: 'Ира', voice: { preset: 1, params: {}, sample: { name: 'keep.wav', data: 'encoded' } } } },
    { op: 'createNode', node: { id: 'before', type: 'scene', position: { x: -17, y: 22 }, text: 'Раньше.' } },
  ]);
  const original = structuredClone(project);
  const { ops, result } = planStoryGraph(project, { ...section, after: 'before' });
  assert.deepEqual(project, original);
  assert.equal(applyOps(project, ops).ok, true);
  assert.equal(project.startNodeId, 'before');
  assert.deepEqual(project.nodes[0].position, original.nodes[0].position);
  assert.equal(project.nodes[0].next, result.ids.room);
  assert.equal(project.locations.length, 1);
  assert.deepEqual(project.characters, original.characters);
  const line = project.nodes.find(n => n.id === result.ids.line);
  assert.equal(line.speakerId, 'ira');
  assert.equal(line.locationId, project.locations[0].id);
  assert.equal(line.next, result.ids.decision);
  assert.deepEqual(project.nodes.find(n => n.id === line.next).choices.map(c => c.next), [result.ids.light, result.ids.leave]);
  assert.equal(new Set(project.nodes.map(n => JSON.stringify(n.position))).size, project.nodes.length);
  assert.equal(validateProject(project).filter(i => i.severity === 'error').length, 0);
  assert.throws(() => planStoryGraph(project, section));
  assert.throws(() => planStoryGraph(project, { after: 'before', nodes: [{key:'other', type:'line', text:'x'}] }));
  assert.throws(() => planStoryGraph(project, { nodes: [{key:'unlinked', type:'end'}, {key:'also', type:'end'}] }));
  assert.throws(() => planStoryGraph(project, { nodes: [{key:'bad', type:'line', text:'x', next:'absent'}] }));
});

test('a manual screenplay change takes priority over a pending conversion', () => {
  const store = new Store();
  store.setProject(createEmptyProject({ screenplay: 'Original' }));
  const plan = planProjectEdits(store);
  plan.observe('screenplay');
  assert.equal(plan.apply(planStoryGraph(plan.project, section).ops).ok, true);
  store.apply([{ op:'setScreenplay', text:'Revised' }]);
  assert.throws(() => plan.commit('Build'));
  assert.equal(store.project.screenplay, 'Revised');
  assert.equal(store.project.nodes.length, 0);
});

test('chat tools edit the notebook, build a connected playable graph and commit the complete turn once', async () => {
  const store = new Store();
  store.setProject(createEmptyProject({ screenplay:'Ира входит.\nКто там?' }));
  const original = store.snapshot();
  let call = 0;
  const replies = [
    ['get_screenplay', {}], ['edit_screenplay', { mode:'replace',find:'Ира входит.',text:'Ира входит в комнату.' }],
    ['build_story_graph', section], ['validate_project', {}],
  ];
  globalThis.window = { sf: { ai:{ abort() {}, async chat({ body }) {
    const last = body.messages.at(-1);
    if (call === 0) assert.ok(body.tools.some(tool => tool.function.name === 'build_story_graph'));
    if (call === 1) assert.equal(JSON.parse(last.content).text, original.screenplay);
    if (call === 2) assert.equal(JSON.parse(last.content).ok, true);
    if (call === 3) assert.equal(JSON.parse(last.content).count, 5);
    if (call === 4) {
      assert.equal(JSON.parse(last.content).errors, 0);
      return { ok:true, content:'Готово' };
    }
    const [name, args] = replies[call++];
    return { ok:true, toolCalls:[{ id:'tool_' + call, name, arguments:JSON.stringify(args) }] };
  } }, history:{ read:() => [], write() {} } } };
  const ai = createAI({ root:null, store, ui:{ escapeHTML:String, settings:{ ai:{ baseUrl:'http://localhost/v1',model:'mock' } } } });
  await ai.send('Исправь фразу и перенеси сценарий в схему');
  assert.equal(call, 4);
  assert.equal(store.project.screenplay, 'Ира входит в комнату.\nКто там?');
  assert.equal(store.project.nodes.length, 5);
  assert.equal(store.project.startNodeId, 'n_script_room');
  store.undo();
  assert.deepEqual(store.project, original);
  assert.equal(store.canUndo(), false);
});

test('rejected graph leaves earlier notebook changes in that turn uncommitted', async () => {
  const store = new Store();
  store.setProject(createEmptyProject({ screenplay:'Оригинал' }));
  const replies = [
    ['edit_screenplay', { mode:'append', text:' Черновик' }],
    ['build_story_graph', { nodes:[{ key:'intro', type:'line', text:'Текст', next:'missing' }] }],
  ];
  let step = 0;
  const history = new Map();
  globalThis.window = { sf: { ai:{ async chat({body}) {
    if (step === 2) {
      assert.ok(JSON.parse(body.messages.at(-1).content).error);
      return { ok:true, content:'Закончено' };
    }
    const [name, args] = replies[step++];
    return { ok:true, toolCalls:[{id:'t' + step, name, arguments:JSON.stringify(args)}] };
  } }, history:{ read:key => history.get(key) || [], write:(items,key) => history.set(key,items) } } };
  const ai = createAI({root:null, store, ui:{escapeHTML:String,settings:{ai:{model:'mock',baseUrl:'http://localhost/v1'}}}});
  await ai.send('Дополни и перенеси текст');
  assert.equal(step, 2);
  assert.equal(store.project.screenplay,'Оригинал');
  assert.equal(store.project.nodes.length,0);
  assert.equal(store.canUndo(),false);
});
