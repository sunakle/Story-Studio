import { t as uiText } from './i18n.js';
import { applyOps, uid } from './model.js';

const createKeys = {
  createNode: ['node', 'n_'], createCharacter: ['character', 'c_'],
  createVariable: ['variable', 'v_'], createChapter: ['chapter', 'ch_'],
  createLocation: ['location', 'l_'],
};

// Replaying a planned batch must create the same IDs that earlier tools returned.
function identify(op) {
  if (op.op === 'createGigmaWorkspace' && !op.id) return { ...op, id: uid('gg_') };
  const target = createKeys[op.op];
  if (!target) return op;
  const [key, prefix] = target;
  if (!op[key] || op[key].id) return op;
  return { ...op, [key]: { ...op[key], id: uid(prefix) } };
}

export function same(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
}

// The canvas persists its viewport in the same document as the layer data.
// Navigation, thumbnails and save stamps are not inputs to artwork tools.
function artworkContent(document) {
  if (!document) return document;
  const { revision, updatedAt, cover, activePageId, pages, ...content } = document;
  return {...content, pages:pages.map(({view, ...page}) => page)};
}

function sourceChanged(name) {
  const label = name ? ' «' + name + '»' : '';
  throw new Error(uiText('Исходный объект' + label + ' изменился. Текущие правки сохранены. Повторите запрос.',
    'The source object' + label + ' changed. Your current edits were kept. Retry the request.'));
}

function layerSource(doc, id) {
  for (const page of doc?.pages || []) {
    let node = page.nodes.find(n => n.id === id);
    if (!node) continue;
    const chain = [node];
    const visited = new Set([node.id]);
    while (node.parentId) {
      node = page.nodes.find(n => n.id === node.parentId);
      if (!node || visited.has(node.id)) sourceChanged(chain[0].name);
      chain.push(node);
      visited.add(node.id);
    }
    return {pageId:page.id, chain};
  }
}

function artworkSnapshot(op, before, live, layerId) {
  if (!before || !live || !op.document || before.id !== live.id) sourceChanged();
  const staged = op.document;
  // Single-layer edits are based on an explicitly observed leaf (+ ancestors).
  // Replace that leaf in the CURRENT document, keeping unrelated live layers.
  let document = staged;
  if (layerId && !same(artworkContent(before), artworkContent(live))) {
    const stagedNode = layerSource(staged, layerId)?.chain[0];
    if (!stagedNode || !layerSource(live, layerId)) sourceChanged(stagedNode?.name);
    document = {...live, pages:live.pages.map(page => ({
      ...page, nodes:page.nodes.map(n => n.id === layerId ? stagedNode : n),
    }))};
  }
  const priorPages = new Map(before.pages.map(page => [page.id, page]));
  const livePages = new Map(live.pages.map(page => [page.id, page]));
  const pages = document.pages.map(page => {
    const current = livePages.get(page.id);
    return current && !same(priorPages.get(page.id)?.view,current.view) ? {...page, view:current.view} : page;
  });
  const activePageId = before.activePageId !== live.activePageId && pages.some(p => p.id === live.activePageId)
    ? live.activePageId : document.activePageId;
  return {...op, document:{...document, pages, activePageId, cover:'', updatedAt:new Date().toISOString(),
    revision:Math.max(staged.revision,live.revision + 1)}};
}

function comparisonProject(project) {
  return {...project, gigmaWorkspaces:project.gigmaWorkspaces?.map(w => ({...w, document:artworkContent(w.document)}))};
}

// Check only the live fields that the author edited. Array members with stable
// IDs retain identity when a different member is inserted or removed.
function preservesManualFields(before, live, replayed) {
  if (same(before, live) || same(live, replayed)) return true;
  if (before == null || live == null || replayed == null) return false;
  if ([before, live, replayed].every(Array.isArray)) {
    if (![before, live, replayed].every(values => values.every(value => value?.id))) return false;
    const base = new Map(before.map(v => [v.id, v]));
    const after = new Map(replayed.map(v => [v.id, v]));
    const current = new Map(live.map(v => [v.id, v]));
    return [...new Set([...base.keys(), ...current.keys()])].every(id =>
      preservesManualFields(base.get(id), current.get(id), after.get(id)));
  }
  if (![before, live, replayed].every(value => typeof value === 'object' && !Array.isArray(value))) return false;
  return [...new Set([...Object.keys(before), ...Object.keys(live)])].every(key =>
    preservesManualFields(before[key], live[key], replayed[key]));
}

export function planProjectEdits(store) {
  const generation = store.generation;
  const revision = store.revision;
  // applyOps commits by replacing root fields. Like Store.undo snapshots, these
  // separate roots can share unchanged entities and embedded image data.
  const base = { ...store.project };
  const draft = { ...base };
  const batch = [];
  const readFields = new Set();
  const readRecords = new Map();
  const readLayers = new Map();
  const animationEdits = new WeakMap();
  function checkProject() {
    if (store.generation !== generation) throw new Error(uiText("Активный проект сменился. Правки AI отменены.", "The active project changed. AI edits were cancelled."));
  }
  return {
    project: draft,
    generation,
    get changed() { return batch.length > 0; },
    observe(field) { readFields.add(field); },
    observeLayer(workspaceId, objectId) {
      if (!readLayers.has(workspaceId)) readLayers.set(workspaceId,new Set());
      readLayers.get(workspaceId).add(objectId);
    },
    trackAnimation(op, objectId) { animationEdits.set(op,objectId); },
    observeRecord(field, id) {
      if (!readRecords.has(field)) readRecords.set(field, new Set());
      readRecords.get(field).add(id);
    },
    apply(ops) {
      checkProject();
      const identified = ops.map(identify);
      const result = applyOps(draft, identified);
      if (result.ok) batch.push(...identified);
      return result;
    },
    commit(label) {
      checkProject();
      if (!batch.length) return;
      let commitOps = batch;
      if (store.revision !== revision) {
        for (const field of readFields) {
          if (!same(base[field], store.project[field])) {
            throw new Error(uiText("Исходные данные изменены вручную. Повторите запрос с текущей версией.", "Source data was edited manually. Retry with the current version."));
          }
        }
        const record = (root,field,id) => Array.isArray(root[field]) ? root[field].find(item => item.id === id) : root[field]?.[id];
        for (const [field, ids] of readRecords) {
          for (const id of ids) {
            const original = record(base,field,id), live = record(store.project,field,id);
            if (original === live) continue;
            if (field === 'gigmaWorkspaces' && original && live && original.name === live.name &&
                same(artworkContent(original.document),artworkContent(live.document))) continue;
            if (!same(original,live)) sourceChanged(original?.name);
          }
        }
        const workspaces = project => new Map((project.gigmaWorkspaces || []).map(w => [w.id,w]));
        const originals = workspaces(base), current = workspaces(store.project);
        for (const [id, layers] of readLayers) {
          const a = originals.get(id), b = current.get(id);
          if (a === b) continue;
          if (!a || !b || a.document?.id !== b.document?.id) sourceChanged(a?.name);
          for (const layer of layers) {
            const before = layerSource(a.document,layer);
            if (!same(before,layerSource(b.document,layer))) sourceChanged(before?.chain[0].name);
          }
        }
        const rebased = new Map(current);
        commitOps = batch.map(op => {
          if (op.op !== 'updateGigmaWorkspace' || !op.document || originals.get(op.id) === current.get(op.id)) return op;
          const original = originals.get(op.id), live = rebased.get(op.id);
          const result = artworkSnapshot(op, original?.document, live?.document, animationEdits.get(op));
          if (op.name === original.name) result.name = live.name;
          rebased.set(op.id,{...live, name:result.name ?? live.name, document:result.document});
          return result;
        });
        const merged = { ...store.project };
        const result = applyOps(merged, commitOps);
        if (!result.ok || !preservesManualFields(comparisonProject(base), comparisonProject(store.project), comparisonProject(merged))) {
          throw new Error(uiText("Проект изменён вручную в тех же полях. Пакет AI отменён. Повторите запрос с текущей версией.", "The same fields were edited manually. AI edits were cancelled. Try again with the current project."));
        }
      }
      const result = store.apply(commitOps, { label });
      if (!result.ok) throw new Error(result.error);
    },
  };
}
