import assert from 'node:assert/strict';
import test from 'node:test';
import { Store, createEmptyProject, migrateProject } from '../src/js/model.js';

test('Older stories open with a blank notebook and new screenplays round-trip verbatim', () => {
  const legacy = createEmptyProject();
  delete legacy.screenplay;
  const { project } = migrateProject(legacy);
  assert.equal(project.screenplay, '');
  const store = new Store();
  store.setProject(project);
  const originalNodes = store.project.nodes;
  const text = '  Нат. Порт — ночь 🌙\n\nМая: «Я здесь».\n<script>текст</script>\n';
  assert.ok(store.apply({ op: 'setScreenplay', text }).ok);
  assert.equal(store.project.nodes, originalNodes);
  assert.equal(migrateProject(JSON.parse(JSON.stringify(store.project))).project.screenplay, text);
});

test('Typing groups and mixed AI batches undo atomically and reject invalid text', () => {
  const store = new Store();
  store.apply({ op: 'setScreenplay', text: 'Первый' }, { group: 'typing' });
  store.apply({ op: 'setScreenplay', text: 'Первый акт' }, { group: 'typing' });
  assert.ok(store.undo().ok);
  assert.equal(store.project.screenplay, '');
  assert.ok(store.redo().ok);
  assert.equal(store.project.screenplay, 'Первый акт');
  assert.ok(store.apply([
    { op: 'setScreenplay', text: 'Второй акт' },
    { op: 'createNode', node: { type: 'scene', title: 'Порт' } },
  ]).ok);
  assert.ok(store.undo().ok);
  assert.equal(store.project.screenplay, 'Первый акт');
  assert.equal(store.project.nodes.length, 0);
  assert.equal(store.apply([{ op: 'setScreenplay', text: 'Черновик' }, { op: 'setScreenplay', text: null }]).ok, false);
  assert.equal(store.project.screenplay, 'Первый акт');
});
