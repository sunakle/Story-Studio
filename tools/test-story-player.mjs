import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store, createEmptyProject, evaluateCondition } from '../src/js/model.js';
import { createPlayback, insertNodeOnEdge, insertionEdges } from '../src/js/story-player.js';
import { reachableFromStart, oneHop } from '../src/js/visualizer.js';

function scenario() {
  const project = createEmptyProject();
  Object.assign(project, {
    startNodeId: 'a', chapters: [{id:'ch', name:'Глава'}],
    characters: [{ id:'m', name:'Марк' }],
    variables: [{id:'v', name:'trust', type:'number', initial:1}],
    nodes: [
      {id:'a', type:'line', text:'Начало', speakerId:'m', chapterId:'ch', next:'q'},
      {id:'q', type:'choice', next:'other', chapterId:'ch', choices:[
        {id:'yes', text:'Договориться', next:'c', condition:'trust >= 1', effects:[{varId:'v',op:'+=',value:1}]},
        {id:'no', text:'Отказаться', next:'other', condition:'trust < 0', effects:[]}
      ]},
      {id:'c',type:'condition', chapterId:'ch', effects:[{varId:'v',op:'+=',value:1}], branches:[{id:'b',condition:'trust == 3',next:'n'}], next:'other'},
      {id:'n',type:'note',text:'Спойлер',next:'end'},
      {id:'end',type:'end',text:'Сделка'},
      {id:'other',type:'end',text:'Отказ'},
      {id:'orphan',type:'line',speakerId:'m',next:'a'},
    ],
  });
  return project;
}

test('player uses exported choices, effects, conditions, note resolution, reversible steps', () => {
  const project = scenario(), snapshot = structuredClone(project);
  const sim = createPlayback(project);
  assert.equal(sim.node.text, 'Начало');
  sim.advance();
  assert.deepEqual(sim.state.options.map(c=>c.id), ['yes']);
  assert.equal(sim.advance(10), false);
  sim.advance(0);
  assert.equal(sim.node.text, 'Сделка');
  assert.equal(sim.state.status, 'finished');
  assert.equal(sim.state.vars.trust, 3);
  assert.ok(sim.state.trace.includes('trust == 3 — истина'));
  sim.back();
  assert.equal(sim.state.vars.trust, 1);
  assert.equal(sim.state.id, 'q');
  sim.back();
  assert.equal(sim.state.id, 'a');
  sim.advance(); sim.reset();
  assert.equal(sim.canBack, false);
  assert.deepEqual(project, snapshot);
  assert.equal(createPlayback(project, 'n').state.id, 'end');
});
test('player protects against automatic cycles and reports broken targets', () => {
  const project = scenario();
  project.nodes.push({id:'loop', type:'jump', next:'loop'});
  assert.match(createPlayback(project,'loop').state.message, /512/);
  project.nodes[0].next='missing';
  const sim = createPlayback(project);
  sim.advance();
  assert.equal(sim.state.status,'error');
  assert.match(sim.state.message,/missing/);
});
test('condition grammar supports parentheses, bools, string comparisons, precedence and invalid names', () => {
  const vars = {n:2,can:false,where:'Склад'};
  for(const c of ['true','!can && (n > 1 || n == 0)','where == "Склад"','(3 <= n) == false','!false']) assert.equal(evaluateCondition(c,vars), true, c);
  for(const c of ['can','unknown','3 == "3"','n ==','(false','where < 7']) assert.equal(evaluateCondition(c,vars), false,c);
});
for (const [nodeId, edge] of [['a',{kind:'next'}],['q',{kind:'choice',id:'yes'}],['c',{kind:'branch',id:'b'}],['c',{kind:'next'}]]) {
  test('atomic insert and one undo/redo on ' + nodeId + ' / ' + edge.kind, () => {
    const store = new Store();
    store.setProject(scenario());
    const before = structuredClone(store.project);
    const source = before.nodes.find(n=>n.id===nodeId);
    const dest = insertionEdges(source).find(e=>e.kind===edge.kind && e.id===edge.id);
    const result = insertNodeOnEdge(store,nodeId,edge);
    assert.equal(result.ok,true,result.error);
    const created = store.project.nodes.find(n=>n.id===result.created[0]);
    assert.equal(created.next,dest.target);
    assert.equal(created.chapterId,'ch');
    const afterSource = store.project.nodes.find(n=>n.id===nodeId);
    assert.equal(insertionEdges(afterSource).find(e=>e.kind===edge.kind && e.id===edge.id).target,created.id);
    if(edge.kind==='choice') { assert.deepEqual(afterSource.choices[0].effects,source.choices[0].effects); assert.deepEqual(afterSource.choices[1],source.choices[1]); }
    assert.equal(store.undo().ok,true);
    assert.deepEqual(store.project,before);
    assert.equal(store.canUndo(),false);
    assert.equal(store.redo().ok,true);
    assert.ok(store.project.nodes.some(n=>n.id===created.id));
  });
}
test('invalid and stale edges preserve data and undo history', () => {
  const store = new Store();store.setProject(scenario());const before=structuredClone(store.project);
  for(const [id,edge] of [['c',{kind:'branch',id:'missing'}],['end',{kind:'next'}],['a',{kind:'next',target:'stale'}]]) {
    assert.equal(insertNodeOnEdge(store,id,edge).ok,false);assert.deepEqual(store.project,before);
  }
  assert.equal(store.canUndo(),false);
});
test('reachability excludes shared entities and predecessor-only nodes; context has depth one', () => {
  const reachable=reachableFromStart(scenario());
  assert.ok(reachable.has('end'));assert.ok(!reachable.has('orphan'));assert.ok(!reachable.has('m'));
  const links=[{source:'a',target:'b'},{source:'b',target:'c'},{source:'c',target:'d'}];
  assert.deepEqual([...oneHop(new Set(['a']),links)].sort(),['a','b']);
  assert.deepEqual([...oneHop(new Set(['a']),links.reverse())].sort(),['a','b']);
});
