import assert from 'node:assert/strict';
import test from 'node:test';
import { describeArtwork, exportArtworkImage, planArtworkEdit } from '../src/js/ai-artwork.js';
import { planProjectEdits } from '../src/js/ai-transaction.js';
import { applyOps, createEmptyProject, migrateProject, Store } from '../src/js/model.js';

function edit(project, args, options) {
  const plan = planArtworkEdit(project, args, options);
  const result = applyOps(project, plan.ops);
  assert.equal(result.ok, true, result.error);
  return plan;
}
const node = (project, id, pageId, workspaceId) =>
  describeArtwork(project, { objectId: id, pageId, workspaceId }).objects[0];

test('empty legacy projects materialize a stable page on first write, never on inspection', () => {
  const project = createEmptyProject();
  delete project.gigmaWorkspaces;
  assert.deepEqual(describeArtwork(project).pages, []);
  const art = edit(project, { workspaceId: 'gg_assistant', action: 'create', kind: 'text', text: 'Титры' });
  const id = art.objectIds[0];
  assert.deepEqual(project.gigmaWorkspaces.map(w => w.id), ['gg_project', 'gg_assistant']);
  const layer = node(project, id, art.pageId, art.workspaceId);
  assert.equal(layer.text, 'Титры');
  const { project: reopened } = migrateProject(JSON.parse(JSON.stringify(project)));
  assert.equal(describeArtwork(reopened, { objectRef: layer.ref }).objects[0].text, 'Титры');
  const other = structuredClone(project);
  other.meta.createdAt = 'another project';
  assert.throws(() => describeArtwork(other, { objectRef: layer.ref }));
});

test('nested copies remap prototype links and preserve relative geometry across pages', () => {
  const p = createEmptyProject();
  const frame = edit(p, { action: 'create', kind: 'frame', x: 50, y: 100 }).objectIds[0];
  const label = edit(p, { action: 'create', kind: 'text', x: 80, y: 125, text: 'Go', parentId: frame, linkTo: frame }).objectIds[0];
  const first = describeArtwork(p).pageId;
  const second = edit(p, { action: 'createPage', name: 'Copy' }).pageId;
  const duplicate = edit(p, { action: 'copy', pageId: first, objectId: frame, targetPageId: second, x: 100, y: 200 });
  const copy = describeArtwork(p, { pageId: second }).objects;
  assert.equal(copy.length, 2);
  assert.deepEqual(copy.map(n => [n.x, n.y]), [[100, 200], [130, 225]]);
  const clone = copy.find(n => n.kind === 'text');
  assert.notEqual(clone.id, label);
  assert.equal(clone.parentId, duplicate.objectIds[0]);
  assert.equal(node(p, clone.id, second).linkTo, duplicate.objectIds[0]);
  assert.throws(() => planArtworkEdit(p, { action: 'move', objectId: frame, pageId: first, parentId: label }));
});

test('cross-workspace move preserves IDs, detaches external links, roundtrips animation, and undoes once', () => {
  const store = new Store();
  const p = store.project;
  const frame = edit(p, { action: 'create', kind: 'frame' });
  const external = edit(p, { action: 'create', kind: 'frame', linkTo: frame.objectIds[0] });
  const child = edit(p, { action: 'create', kind: 'rect', parentId: frame.objectIds[0], linkTo: external.objectIds[0] });
  const tx = planProjectEdits(store);
  const motion = { type: 'pulse', durationMs: 650, delayMs: 100, loop: true };
  const animate = planArtworkEdit(tx.project, { action: 'animate', objectId: child.objectIds[0], animation: motion });
  assert.ok(tx.apply(animate.ops).ok);
  const moved = planArtworkEdit(tx.project, { action: 'move', objectId: frame.objectIds[0], targetWorkspaceId: 'gg_assistant' });
  assert.ok(tx.apply(moved.ops).ok);
  assert.equal(describeArtwork(p).objects.length, 3);
  tx.commit('Animate and transfer');
  const read = id => node(p, id, moved.pageId, moved.workspaceId);
  assert.equal(read(child.objectIds[0]).parentId, frame.objectIds[0]);
  assert.equal(read(child.objectIds[0]).linkTo, null);
  assert.equal(node(p, external.objectIds[0], external.pageId).linkTo, null);
  assert.deepEqual(read(child.objectIds[0]).animation, motion);
  const { project: reopened } = migrateProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(node(reopened, child.objectIds[0], moved.pageId, moved.workspaceId).animation, motion);
  store.undo();
  assert.equal(describeArtwork(store.project).objects.length, 3);
  assert.equal(node(store.project, external.objectIds[0], external.pageId).linkTo, frame.objectIds[0]);
});

test('bad paint, invalid animations, locked layers and forbidden deletion leave originals intact', () => {
  const p = createEmptyProject();
  const { objectIds: [id] } = edit(p, { action: 'create', kind: 'rect' });
  for (const invalid of [
    { action: 'update', fill: 'url(https://example.test)' },
    { action: 'animate', animation: { type: 'slide', durationMs: 1 } },
    { action: 'animate', animation: { type: 'spin' } },
    { action: 'delete' }, { action: 'deletePage' },
  ]) {
    const original = structuredClone(p);
    assert.throws(() => planArtworkEdit(p, { ...invalid, objectId: id }));
    assert.deepEqual(p, original);
  }
  edit(p, { action: 'update', objectId: id, locked: true });
  assert.throws(() => planArtworkEdit(p, { action: 'move', objectId: id, x: 220 }));
  edit(p, { action: 'update', objectId: id, locked: false });
  edit(p, { action: 'delete', objectId: id }, { allowDelete: true });
  assert.equal(describeArtwork(p).total, 0);
});

test('raster data can be transferred locally without leaking bytes through object inspection', async () => {
  const p = createEmptyProject();
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOUkAAAAASUVORK5CYII=';
  const { objectIds: [id] } = edit(p, { action: 'create', kind: 'image', imageData: dataUrl, name: 'Asset', width: 1, height: 1 });
  assert.ok(!JSON.stringify(describeArtwork(p, { objectId: id })).includes(dataUrl));
  assert.deepEqual(await exportArtworkImage(p, { objectId: id }), { name: 'Asset', dataUrl, width: 1, height: 1 });
});

test('a photo can bounce after reopen, change timing, or return to a still image', () => {
  const p = createEmptyProject();
  const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOUkAAAAASUVORK5CYII=';
  const { objectIds: [id] } = edit(p, { action:'create', kind:'image', x:17, y:23, rotation:21, imageData });
  const motion = { type:'bounce', durationMs:1100, delayMs:150, loop:true };
  edit(p, { action:'animate', objectId:id, animation:motion });
  const { project } = migrateProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(node(project,id).animation,motion);
  edit(project, { action:'animate', objectId:id, animation:{ ...motion, loop:false, durationMs:450 } });
  assert.equal(node(project,id).animation.durationMs,450);
  edit(project, { action:'animate', objectId:id, animation:null });
  const photo = project.gigmaWorkspaces[0].document.pages[0].nodes[0];
  assert.equal(photo.animation, undefined);
  assert.deepEqual([photo.x,photo.y,photo.rotation,photo.image],[17,23,21,imageData]);
});
