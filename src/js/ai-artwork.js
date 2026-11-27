import { getLanguage, t } from './i18n.js';
import { projectDesigns } from './model.js';
import { makeProjectReference, parseProjectReference } from './project-references.js';
import {
  descendants, duplicateNodes, exportBounds, exportSVG, inherited, kinds, moveNodes,
  newDocument, newNode, newPage, refreshGroups, removeNodes, resizeNodes, setLanguage,
  svgPNG, validateDocument,
} from '../gigma/artwork-model.js';

const properties = [
  'name', 'rotation', 'fill', 'stroke', 'strokeWidth', 'opacity', 'radius', 'hidden', 'locked',
  'text', 'fontSize', 'fontFamily', 'fontWeight', 'textAlign', 'textLayout', 'points', 'sides',
  'linkTo', 'layout', 'gap', 'padding', 'clip', 'fillOpacity', 'sampling', 'blend', 'adjustments',
];
const fail = (ru, en) => { throw new Error(t(ru, en)); };

function resolveArgs(project, args) {
  if (!args.objectRef) return args;
  const ref = parseProjectReference(args.objectRef, project);
  if (ref?.kind !== 'gigma') fail('Ссылка не указывает на объект этого проекта.', 'This link does not identify an object in this project.');
  return { ...args, workspaceId: ref.workspaceId, pageId: ref.pageId, objectId: ref.objectId };
}

function workspaceFor(project, id) {
  const workspaces = projectDesigns(project);
  const existing = id ? workspaces.find(item => item.id === id) : workspaces[0];
  if (existing) return existing;
  if (id === 'gg_assistant') return { id, name: t('ИИ-студия', 'AI Studio'), document: null };
  fail('Пространство Gigma не найдено.', 'Gigma workspace not found.');
}

function findPage(doc, id) {
  const page = doc?.pages.find(p => p.id === (id || doc.activePageId));
  if (!page) fail('Страница Gigma не найдена.', 'Gigma page not found.');
  return page;
}

function findNode(page, id) {
  const node = page.nodes.find(n => n.id === id);
  if (!node) fail('Объект Gigma не найден на этой странице.', 'Gigma object not found on this page.');
  return node;
}

// A list entry carries enough information to find the layer; large raster/vector payloads stay local.
export function describeArtwork(project, input = {}) {
  const args = resolveArgs(project, input);
  const workspace = workspaceFor(project, args.workspaceId);
  const doc = workspace.document;
  const result = {
    workspaceId: workspace.id, name: workspace.name, activePageId: doc?.activePageId ?? null,
    pages: (doc?.pages ?? []).map(p => ({ id: p.id, name: p.name, objectCount: p.nodes.length })),
    workspaces: projectDesigns(project).map(w => ({ id: w.id, name: w.name })),
    objects: [], total: 0,
  };
  if (!doc && !args.pageId && !args.objectId) return result;
  const page = findPage(doc, args.pageId);
  const offset = Number.isSafeInteger(args.offset) ? Math.max(0, args.offset) : 0;
  const limit = Number.isSafeInteger(args.limit) ? Math.min(100, Math.max(1, args.limit)) : 40;
  const objects = args.objectId ? [findNode(page, args.objectId)] : page.nodes;
  result.pageId = page.id;
  result.total = objects.length;
  result.objects = (args.objectId ? objects : objects.slice(offset, offset + limit)).map(n => {
    const { id, kind, name, parentId, x, y, width, height, hidden, locked, animation } = n;
    const ref = makeProjectReference(project, { kind: 'gigma', workspaceId: workspace.id, pageId: page.id, objectId: id });
    const entry = { id, kind, name, parentId, x, y, width, height, hidden, locked, animation, ref };
    if (args.objectId) {
      for (const key of properties) {
        if (key !== 'points' && key !== 'text' && n[key] !== undefined) entry[key] = n[key];
      }
      if (kind === 'text') {
        entry.text = n.text.slice(offset, offset + 12000);
        entry.textLength = n.text.length;
      }
      if (kind === 'path') entry.pointCount = n.points.length;
      if (kind === 'image') entry.hasImage = Boolean(n.image);
    } else if (kind === 'text') entry.text = n.text.slice(0, 220);
    return entry;
  });
  return result;
}

function setAppearance(n, args) {
  for (const key of properties) if (Object.hasOwn(args, key)) n[key] = args[key];
  if (Object.hasOwn(args, 'imageData')) {
    if (n.kind !== 'image' || !args.imageData) fail('Укажите изображение для растрового слоя.', 'Provide image data for an image layer.');
    n.image = args.imageData;
  }
  if (Object.hasOwn(args, 'animation')) {
    if (args.animation === null) delete n.animation;
    else if (n.animation && n.animation.type === args.animation?.type) n.animation = {...n.animation, ...args.animation};
    else n.animation = args.animation;
  }
}

function position(page, n, args) {
  for (const key of ['x', 'y', 'width', 'height']) {
    if (Object.hasOwn(args, key) && !Number.isFinite(args[key])) fail('Неверный размер или координата.', 'Invalid size or coordinate.');
  }
  const width = args.width ?? n.width, height = args.height ?? n.height;
  if (width < 1 || height < 1 || width > 100000 || height > 100000) fail('Некорректный размер слоя.', 'Invalid layer size.');
  if (width !== n.width || height !== n.height) {
    const box = { x: n.x, y: n.y, width: n.width, height: n.height };
    resizeNodes(page.nodes, [n.id], box, { ...box, width, height });
  }
  if (args.x !== undefined || args.y !== undefined) {
    moveNodes(page.nodes, [n.id], (args.x ?? n.x) - n.x, (args.y ?? n.y) - n.y);
  }
}

function setParent(page, n, parentId) {
  if (parentId === undefined || parentId === n.parentId) return;
  if (parentId !== null) {
    const p = findNode(page, parentId);
    if (!['group', 'frame'].includes(p.kind) || inherited(page.nodes, p, 'locked') || descendants(page.nodes, [n.id]).has(p.id)) {
      fail('Нельзя поместить слой в этот контейнер.', 'This container cannot receive the layer.');
    }
  }
  n.parentId = parentId;
}

function snapshot(project, ws, document) {
  document.revision++;
  document.updatedAt = new Date().toISOString();
  document.cover = '';
  const validated = validateDocument(document);
  const exists = project.gigmaWorkspaces?.some(item => item.id === ws.id);
  return { op: exists ? 'updateGigmaWorkspace' : 'createGigmaWorkspace', id: ws.id, name: ws.name, document: validated };
}

// Work on canonical, detached design documents. The caller applies all returned ops in the
// same StoryForge transaction as story edits, including both sides of a cross-design move.
export function planArtworkEdit(project, input, { allowDelete = false } = {}) {
  setLanguage(getLanguage());
  const args = resolveArgs(project, input);
  const { action } = args;
  if ((action === 'delete' || action === 'deletePage') && !allowDelete) fail('Удаление через ИИ отключено.', 'Deletion by AI is disabled.');
  const workspace = workspaceFor(project, args.workspaceId);
  const doc = workspace.document ? validateDocument(workspace.document) : newDocument(workspace.name);
  const page = findPage(doc, args.pageId);
  let target = page, destination = workspace;
  let objectIds = [], otherDoc, sourceChanged = true;
  switch (action) {
    case 'createPage':
      target = newPage(args.name ?? t('Новая страница', 'New page'));
      doc.pages.push(target);
      doc.activePageId = target.id;
      break;
    case 'renamePage':
      if (typeof args.name !== 'string' || !args.name.trim()) fail('Введите название страницы.', 'Enter the page name.');
      page.name = args.name;
      break;
    case 'deletePage':
      if (doc.pages.length === 1) fail('В макете нужна хотя бы одна страница.', 'A design must keep at least one page.');
      removeNodes(doc, page, page.nodes.map(n => n.id));
      doc.pages = doc.pages.filter(p => p.id !== page.id);
      if (doc.activePageId === page.id) doc.activePageId = doc.pages[0].id;
      target = findPage(doc);
      break;
    case 'create': {
      if (!kinds.includes(args.kind) || args.kind === 'vector') fail('Неизвестный тип создаваемого слоя.', 'Unsupported layer type for creation.');
      if (args.kind === 'image' && !args.imageData) fail('Для изображения нужны растровые данные.', 'Image data is required.');
      if (args.kind === 'path' && (!Array.isArray(args.points) || args.points.length < 2)) fail('Нужны как минимум две точки контура.', 'A path needs at least two points.');
      const n = newNode(args.kind, args.x ?? 0, args.y ?? 0, args.width, args.height);
      page.nodes.push(n);
      setAppearance(n, args);
      setParent(page, n, args.parentId);
      objectIds = [n.id];
      break;
    }
    case 'animate':
    case 'update':
    case 'move':
    case 'copy':
    case 'delete': {
      let n = findNode(page, args.objectId);
      const unlocking = action === 'update' && args.locked === false && (!n.parentId || !inherited(page.nodes, findNode(page, n.parentId), 'locked'));
      if (action !== 'copy' && !unlocking && inherited(page.nodes, n, 'locked')) fail('Слой заблокирован.', 'The layer is locked.');
      if (action === 'delete') {
        removeNodes(doc, page, [n.id]);
        break;
      }
      if (action === 'move' || action === 'copy') {
        destination = workspaceFor(project, args.targetWorkspaceId ?? workspace.id);
        if (destination.id !== workspace.id) {
          otherDoc = destination.document ? validateDocument(destination.document) : newDocument(destination.name);
        }
        target = findPage(otherDoc ?? doc, args.targetPageId ?? (otherDoc ? undefined : page.id));
        if (action === 'copy') {
          const [id] = duplicateNodes(target, [n.id], target === page ? 24 : 0, page.nodes);
          n = findNode(target, id);
          sourceChanged = !otherDoc;
        } else if (target !== page) {
          const ids = descendants(page.nodes, [n.id]);
          const moved = page.nodes.filter(layer => ids.has(layer.id));
          page.nodes = page.nodes.filter(layer => !ids.has(layer.id));
          n.parentId = null;
          target.nodes.push(...moved);
          if (otherDoc) {
            for (const p of doc.pages) {
              for (const layer of p.nodes) if (ids.has(layer.linkTo)) layer.linkTo = null;
            }
          }
        }
        if (otherDoc) {
          const frames = new Set(otherDoc.pages.flatMap(p => p.nodes.filter(layer => layer.kind === 'frame').map(layer => layer.id)));
          for (const layer of target.nodes) if (layer.linkTo && !frames.has(layer.linkTo)) layer.linkTo = null;
        }
        setParent(target, n, args.parentId);
        position(target, n, args);
        if (args.name !== undefined) n.name = args.name;
      } else if (action === 'animate') {
        if (!Object.hasOwn(args, 'animation')) fail('Укажите эффект для анимации.', 'Choose an animation effect.');
        setAppearance(n, { animation: args.animation });
      } else {
        position(page, n, args);
        setParent(page, n, args.parentId);
        setAppearance(n, args);
      }
      objectIds = [n.id];
      break;
    }
    default: fail('Неизвестная операция Gigma.', 'Unknown artwork operation.');
  }
  refreshGroups(page.nodes);
  if (target !== page) refreshGroups(target.nodes);
  const ops = [];
  if (!project.gigmaWorkspaces?.length && (sourceChanged ? workspace.id : destination.id) !== 'gg_project') {
    ops.push({ op: 'createGigmaWorkspace', id: 'gg_project', name: 'Gigma Studio', document: null });
  }
  if (sourceChanged) ops.push(snapshot(project, workspace, doc));
  if (otherDoc) ops.push(snapshot(project, destination, otherDoc));
  return { ops, op: ops[ops.length - 1], workspaceId: destination.id, pageId: target.id, objectIds };
}

export async function exportArtworkImage(project, input) {
  const args = resolveArgs(project, input);
  const workspace = workspaceFor(project, args.workspaceId);
  if (!workspace.document) fail('Макет пуст.', 'The design is empty.');
  const page = findPage(validateDocument(workspace.document), args.pageId);
  const n = findNode(page, args.objectId);
  if (n.kind === 'image' && n.image && !n.rotation && !n.adjustments?.length && n.opacity === 1) {
    return { dataUrl: n.image, name: n.name, width: n.width, height: n.height };
  }
  const ids = [n.id];
  const box = exportBounds(page, ids);
  const scale = Math.min(1, 2048 / Math.max(box.width, box.height));
  const blob = await svgPNG(exportSVG(page, ids), scale, 2048);
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return { dataUrl, name: n.name, width: Math.ceil(box.width * scale), height: Math.ceil(box.height * scale) };
}
