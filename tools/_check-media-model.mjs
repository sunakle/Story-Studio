import { createEmptyProject, applyOps, migrateProject, nodePreviewId, nodeCardHeight, autoLayout } from '../src/js/model.js';

const tiny = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJQBOgCHwAP7+4AAAAA==';
const project = createEmptyProject();
const n1 = applyOps(project, [{ op: 'createNode', node: { type: 'line', text: 'С фото' } }]);
console.log('node created:', n1.ok, n1.created[0]);

const a = applyOps(project, [{ op: 'addMedia', media: { name: 'a.webp', mime: 'image/webp', w: 800, h: 600, size: 1200, data: tiny } }]);
console.log('addMedia:', a.ok, a.created, 'в библиотеке', Object.keys(project.media).length);

const id = a.created[0];
const link = applyOps(project, [{ op: 'setNodeMedia', id: n1.created[0], media: [id], previewId: id }]);
const node = project.nodes[0];
console.log('setNodeMedia:', link.ok, node.media, node.previewId, 'preview:', nodePreviewId(node), 'height:', nodeCardHeight(node));

applyOps(project, [{ op: 'createNode', node: { type: 'end', text: 'Конец' } }]);
const layout = autoLayout(project);
console.log('autoLayout высоты строк:', JSON.stringify(layout.positions));

const del = applyOps(project, [{ op: 'deleteMedia', id }]);
console.log('deleteMedia:', del.ok, 'медиа', Object.keys(project.media).length, 'refs', node.media, JSON.stringify(node.previewId));

const bad = applyOps(project, [{ op: 'addMedia', media: { data: 'http://example.com/a.png' } }]);
console.log('addMedia с плохим data:', bad.ok, bad.error);

const saved = JSON.parse(JSON.stringify(project));
const { project: restored, warnings } = migrateProject(saved);
const rn = restored.nodes.find((n) => n.id === node.id);
console.log('migrate: media', Object.keys(restored.media).length, 'node.media', rn.media, 'preview', JSON.stringify(rn.previewId), 'warnings', warnings.length);