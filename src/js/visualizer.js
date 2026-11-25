import { t as uiText, getLanguage } from './i18n.js';
// Обзор всего сюжета — граф связей в духе Obsidian Graph view.
//
// Узлы сценария, персонажи, локации, переменные и главы живут в одном облаке:
// реплики связаны переходами, персонажи — репликами, локации и переменные —
// ссылками из узлов. Кластеры складываются сами: вокруг персонажа собираются его
// реплики, вокруг главы — её сцены.
//
// Рисуется на canvas (тысячи точек дёшевле, чем DOM), физика — простая
// force-directed: отталкивание всех точек, пружины по связям, тяга к центру.

import { icon } from './icons.js';
import { compileNodeQuery } from './story-search.js';

export function reachableFromStart(project) {
  const nodes = new Map((project.nodes || []).map(n => [n.id, n]));
  const seen = new Set();
  const queue = [project.startNodeId];
  for (let i = 0; i < queue.length; i++) {
    const node = nodes.get(queue[i]);
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    if (node.next) queue.push(node.next);
    for (const choice of node.choices || []) if (choice.next) queue.push(choice.next);
    for (const branch of node.branches || []) if (branch.next) queue.push(branch.next);
  }
  return seen;
}

// Замораживаем исходное множество: добавление соседей не меняет глубину обхода.
export function oneHop(keys, links) {
  const result = new Set(keys);
  for (const edge of links) {
    if (keys.has(edge.source)) result.add(edge.target);
    if (keys.has(edge.target)) result.add(edge.source);
  }
  return result;
}

const storyLink = kind => kind === 'next' || kind === 'choice' || kind === 'branch';

const KIND_COLORS = {
  line: '#ff3b3b', scene: '#00e5ff', chapter: '#00e5ff', character: '#80f538',
  choice: '#ffd400', condition: '#f43eb7', location: '#ffd400', variable: '#f43eb7',
  jump: '#00d4dc', end: '#ff5d56', note: '#b4b4b4',
};
const FOCUS_FADE_MS = 150;

const KIND_LABELS = {
  get character() { return uiText("Персонаж", "Character"); },
  get location() { return uiText("Локация", "Location"); },
  get variable() { return uiText("Переменная", "Variable"); },
  get chapter() { return uiText("Глава", "Chapter"); },
  get note() { return uiText("Заметка", "Note"); },
  get line() { return uiText("Реплика", "Line"); },
  get choice() { return uiText("Выбор", "Choice"); },
  get condition() { return uiText("Условие", "Condition"); },
  get jump() { return uiText("Переход", "Jump"); },
  get scene() { return uiText("Сцена", "Scene"); },
  get end() { return uiText("Концовка", "Ending"); },
};

const PHYS = {
  repulsion: 5200,
  linkDistance: 44,
  linkStrength: 0.03,
  gravity: 0.0095,
  damping: 0.86,
  maxSpeed: 14,
  minAlpha: 0.004,
  decay: 0.972,
};

const DEFAULTS = {
  show: {
    characters: true,
    locations: true,
    variables: true,
    chapters: true,
    notes: true,
    orphans: true,
  },
  onlyReachable: false,
  labels: 13, // 0–12: минимальная степень узла с подписью; 13: только при наведении
  sizeScale: 1,
  forces: { repulsion: PHYS.repulsion, link: PHYS.linkDistance, gravity: PHYS.gravity },
  hiddenChapters: [],
};

export function createVisualizer({ root, store, ui }) {
  if (!root) throw new Error(uiText("createVisualizer: не передан root", "createVisualizer: was not provided root"));

  const state = {
    open: false,
    ready: false,
    search: '',
    localId: null,
    show: { ...DEFAULTS.show },
    onlyReachable: false,
    hiddenChapters: new Set(),
    labelThreshold: DEFAULTS.labels,
    sizeScale: DEFAULTS.sizeScale,
    forces: { ...DEFAULTS.forces },
    nodes: [],
    links: [],
    groups: [],
    byId: new Map(),
    hover: null,
    selected: null,
    zoom: 1,
    autoFrame: true,
    tx: 0,
    ty: 0,
    alpha: 0,
    dragging: null,
    panning: null,
    raf: 0,
    dpr: 1,
    w: 0,
    h: 0,
  };

  const project = () => store.project || {};
  const nodesOf = () => (project().nodes || []).filter((n) => n && n.id);

  // ------------------------------------------------------------------ разметка

  const canvas = document.createElement('canvas');
  canvas.className = 'viz-canvas';

  let shellLanguage;
  function renderHead(head, expanded = false) {
    shellLanguage = getLanguage();
    head.innerHTML = `
      <div class="viz-head-actions">
        <button class="tb-icon" type="button" data-viz="settings" title="${uiText("Параметры графа", "Graph settings")}" aria-label="${uiText("Параметры графа", "Graph settings")}" aria-controls="vizSettings" aria-expanded="${expanded}">${icon('settings', 16)}</button>
        <button class="tb-icon" type="button" data-viz="relayout" title="${uiText("Пересобрать раскладку", "Rebuild layout")} (R)" aria-label="${uiText("Пересобрать раскладку", "Rebuild layout")}">${icon('wand', 16)}</button>
        <button class="tb-icon" type="button" data-viz="refit" title="${uiText("Вписать граф", "Fit graph")} (F)" aria-label="${uiText("Вписать граф", "Fit graph")}">${icon('fit', 16)}</button>
        <button class="tb-icon" type="button" data-viz="close" title="${uiText("Закрыть обзор", "Close overview")} (Esc)" aria-label="${uiText("Закрыть обзор", "Close overview")}">${icon('close', 16)}</button>
      </div>`;
  }

  function refreshChromeLanguage() {
    if (!shell || shellLanguage === getLanguage()) return;
    renderHead(shell.head, !shell.side.hidden);
    canvas.setAttribute('aria-label', uiText('Связи узлов, персонажей и глав сценария', 'Links between story nodes, characters and chapters'));
    shell.side.setAttribute('aria-label', uiText('Параметры графа', 'Graph settings'));
    if (!state.open) renderSide();
  }

  function buildShell() {
    root.innerHTML = '';
    root.classList.add('viz-root');

    const head = document.createElement('header');
    head.className = 'viz-head';
    renderHead(head);

    const stage = document.createElement('div');
    stage.className = 'viz-stage';
    stage.appendChild(canvas);

    canvas.setAttribute('aria-label', uiText("Связи узлов, персонажей и глав сценария", "Links between story nodes, characters and chapters"));
    canvas.setAttribute('role', 'img');
    const side = document.createElement('aside');
    side.className = 'viz-side';
    side.id = 'vizSettings';
    side.setAttribute('aria-label', uiText("Параметры графа", "Graph settings"));
    side.hidden = true;
    root.append(head, stage, side);
    return { head, stage, side };
  }

  let shell = null;
  let opener = null;
  let builtRevision = -1;
  let relaxingDrag = false;
  let light = document.documentElement.dataset.theme === 'light';
  let repaintOnOpen = false;
  const focusPaint = { nodes: null, key: null, amount: 0, started: 0, animating: false };
  const themeWatcher = new MutationObserver(() => {
    light = document.documentElement.dataset.theme === 'light';
    if (state.open) draw();
    else repaintOnOpen = true;
  });
  themeWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const stageWatcher = new ResizeObserver(() => {
    if (state.open) resize();
  });

  // ------------------------------------------------------------------ данные

  function buildGraph() {
    const p = project();
    const nodes = [];
    const links = [];
    const groups = [];
    const byId = new Map();

    const search = state.search.trim().toLowerCase();
    const query = search ? compileNodeQuery(p, search) : null;
    const match = (text) => !search || String(text || '').toLowerCase().includes(search);

    const push = (node) => {
      byId.set(node.key, node);
      nodes.push(node);
      return node;
    };

    // 1. узлы сценария
    const storyNodes = nodesOf();
    for (const n of storyNodes) {
      if (n.type === 'note' && !state.show.notes) continue;
      const chapterId = n.chapterId || '';
      if (chapterId && state.hiddenChapters.has(chapterId)) continue;
      const color = KIND_COLORS[n.type] || KIND_COLORS.note;
      push({
        key: n.id,
        kind: n.type === 'note' ? 'note' : 'node',
        type: n.type,
        label: labelOfNode(n),
        color,
        chapterId,
        degree: 0,
        weight: 1,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        fixed: false,
        search: !query || query.matches(n),
      });
    }

    // 2. сущности: персонажи, локации, переменные, главы
    const addEntities = (list, kind, enabled, nameKey = 'name') => {
      if (!enabled) return;
      for (const entity of list || []) {
        if (!entity || !entity.id) continue;
        if (kind === 'chapter' && state.hiddenChapters.has(entity.id)) continue;
        if (byId.has(entity.id)) continue;
        push({
          key: entity.id,
          kind,
          type: kind,
          label: String(entity[nameKey] || entity.id),
          color: KIND_COLORS[kind],
          degree: 0,
          weight: kind === 'chapter' ? 2.4 : 1.7,
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
          fixed: false,
          search: match(entity[nameKey]) || !search,
        });
      }
    };

    addEntities(p.characters, 'character', state.show.characters);
    addEntities(p.locations, 'location', state.show.locations);
    addEntities(p.variables, 'variable', state.show.variables);
    addEntities(p.chapters, 'chapter', state.show.chapters);

    const link = (from, to, kind) => {
      if (!byId.has(from) || !byId.has(to) || from === to) return;
      links.push({ source: from, target: to, kind });
    };

    // 3. связи сценария
    for (const n of storyNodes) {
      if (!byId.has(n.id)) continue;
      if (n.next) link(n.id, n.next, 'next');
      for (const c of n.choices || []) if (c && c.next) link(n.id, c.next, 'choice');
      for (const b of n.branches || []) if (b && b.next) link(n.id, b.next, 'branch');
    }

    // 4. связи сущностей
    for (const n of storyNodes) {
      if (!byId.has(n.id)) continue;
      if (n.speakerId) link(n.id, n.speakerId, 'speaker');
      if (n.locationId) link(n.id, n.locationId, 'location');
      if (n.chapterId) link(n.id, n.chapterId, 'chapter');
      const used = new Set((n.effects || []).map(e => e?.varId));
      for (const c of n.choices || []) for (const e of c.effects || []) used.add(e?.varId);
      for (const id of used) if (id) link(n.id, id, 'effect');
    }
    // условия ссылаются на переменные по имени
    const varByName = new Map();
    for (const v of p.variables || []) if (v && v.name) varByName.set(String(v.name), v.id);
    for (const n of storyNodes) {
      if (!byId.has(n.id)) continue;
      const conds = [n.condition];
      for (const c of n.choices || []) conds.push(c && c.condition);
      for (const b of n.branches || []) conds.push(b && b.condition);
      for (const cond of conds) {
        if (!cond) continue;
        for (const [name, id] of varByName) {
          if (new RegExp(`(^|[^\\w])${escapeRe(name)}([^\\w]|$)`).test(String(cond))) link(n.id, id, 'condition');
        }
      }
    }

    // степень = сколько связей у узла
    for (const l of links) {
      const a = byId.get(l.source);
      const b = byId.get(l.target);
      if (a) a.degree += 1;
      if (b) b.degree += 1;
    }

    // фильтр «только достижимые»
    let visible = nodes;
    let eligibleLinks = links;
    if (state.onlyReachable) {
      const reachable = reachableFromStart(p);
      const allowed = new Set(reachable);
      for (const l of links) if (!storyLink(l.kind) && reachable.has(l.source)) allowed.add(l.target);
      visible = visible.filter(n => allowed.has(n.key));
      eligibleLinks = links.filter(l => allowed.has(l.source) && allowed.has(l.target));
    }
    if (search) {
      const seeds = new Set(visible.filter(n => n.search).map(n => n.key));
      const keep = oneHop(seeds, eligibleLinks);
      visible = visible.filter(n => keep.has(n.key) && (!query.hasFilters || n.kind !== 'node' && n.kind !== 'note' || seeds.has(n.key)));
    }
    if (state.localId) {
      const keep = oneHop(new Set([state.localId]), eligibleLinks);
      visible = visible.filter(n => keep.has(n.key));
    }
    if (!state.show.orphans) {
      visible = visible.filter((n) => n.degree > 0);
    }

    const visibleSet = new Set(visible.map((n) => n.key));
    const finalLinks = links.filter((l) => visibleSet.has(l.source) && visibleSet.has(l.target));

    // группы для панели
    for (const c of p.chapters || []) {
      const count = visible.filter((n) => n.chapterId === c.id).length;
      groups.push({ id: c.id, name: c.name || uiText("Без названия", "Untitled"), color: KIND_COLORS.chapter, count });
    }

    return { nodes: visible, links: finalLinks, groups, byId };
  }

  function labelOfNode(n) {
    const text = String(n.text || n.title || '').replace(/\s+/g, ' ').trim();
    if (text) return text.length > 140 ? text.slice(0, 139) + '…' : text;
    return KIND_LABELS[n.type] || uiText("Узел", "Node");
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ------------------------------------------------------------------ физика

  function seedPositions() {
    const chapterIds = [...new Set(state.nodes.map(node => node.chapterId).filter(Boolean))];
    const chapterIndex = new Map(chapterIds.map((id, index) => [id, index]));
    const counts = new Map();
    const orbit = chapterIds.length > 1 ? Math.sqrt(state.nodes.length) * 15 : 0;
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (const node of state.nodes) {
      const group = node.chapterId || (node.kind === 'chapter' ? node.key : '');
      const index = counts.get(group) || 0;
      counts.set(group, index + 1);
      const groupAngle = (chapterIndex.get(group) || 0) * 2 * Math.PI / Math.max(1, chapterIds.length);
      const radius = Math.sqrt(index + .5) * 20;
      const angle = index * goldenAngle;
      node.x = (group ? Math.cos(groupAngle) * orbit : 0) + Math.cos(angle) * radius;
      node.y = (group ? Math.sin(groupAngle) * orbit : 0) + Math.sin(angle) * radius;
      node.vx = node.vy = 0;
    }
  }

  function tick() {
    const nodes = state.nodes;
    const links = state.links;
    const alpha = state.alpha;
    if (!nodes.length) return;
    const rep = state.forces.repulsion;
    const restLen = state.forces.link;
    const gravity = state.forces.gravity;
    const held = state.dragging?.moved ? state.dragging.node : null;

    // Отталкивание обрезано на 300 мировых единицах. Проверяем только девять
    // соседних ячеек и только уже встреченные точки, сохраняя симметрию сил.
    const grid = new Map();
    for (const a of nodes) {
      a.stepLimit = PHYS.maxSpeed;
      const gx = Math.floor(a.x / 300), gy = Math.floor(a.y / 300);
      for (let x = gx - 1; x <= gx + 1; x++) {
        const column = grid.get(x);
        if (!column) continue;
        for (let y = gy - 1; y <= gy + 1; y++) {
          const cell = column.get(y);
          if (!cell) continue;
          for (const b of cell) {
            let dx = a.x - b.x, dy = a.y - b.y;
            let d2 = dx * dx + dy * dy;
            if (d2 > 90000) continue;
            if (d2 < 1) { dx = 0.7; dy = -0.7; d2 = 1; }
            const f = rep * alpha / (d2 * Math.sqrt(d2));
            const fx = dx * f, fy = dy * f;
            a.vx += fx; a.vy += fy;
            b.vx -= fx; b.vy -= fy;
          }
        }
      }
      if (!grid.has(gx)) grid.set(gx, new Map());
      const column = grid.get(gx);
      if (!column.has(gy)) column.set(gy, []);
      column.get(gy).push(a);
    }

    for (const l of links) {
      const a = state.byId.get(l.source);
      const b = state.byId.get(l.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      // A recurring speaker can link every chapter. Keep those cross-chapter
      // references visible without pulling all of the narrative clusters together.
      let weight = storyLink(l.kind) ? 1 : l.kind === 'chapter' ? .8 : .25;
      if (relaxingDrag && d > restLen) {
        // A drag at a distant zoom can stretch an edge by thousands of world
        // units. Let its endpoints cover up to 5% of that extension per tick.
        const stretch = d - restLen;
        const step = stretch * .05;
        a.stepLimit = Math.max(a.stepLimit, step);
        b.stepLimit = Math.max(b.stepLimit, step);
        if (a === held || b === held) {
          // Strongly stretched incident edges carry the grabbed neighborhood
          // along. On release they immediately regain their normal stiffness.
          const pulled = Math.min(stretch, state.dragging.travel);
          weight = Math.max(weight, Math.min(3, pulled / (8 * restLen)));
        }
      }
      const f = (d - restLen) * PHYS.linkStrength * weight * alpha;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    for (const node of nodes) {
      node.vx -= node.x * gravity * alpha;
      node.vy -= node.y * gravity * alpha;
      node.vx *= PHYS.damping;
      node.vy *= PHYS.damping;
      const speed = Math.hypot(node.vx, node.vy);
      if (speed > node.stepLimit) {
        node.vx = (node.vx / speed) * node.stepLimit;
        node.vy = (node.vy / speed) * node.stepLimit;
      }
      if (!node.fixed) {
        node.x += node.vx;
        node.y += node.vy;
      } else {
        node.vx = 0;
        node.vy = 0;
      }
    }

    state.alpha = Math.max(PHYS.minAlpha, state.alpha * PHYS.decay);
    if (state.alpha === PHYS.minAlpha) relaxingDrag = false;
  }

  function reheat(alpha = 0.45) {
    state.alpha = Math.max(state.alpha, alpha);
    startLoop();
  }

  function startLoop() {
    if (state.raf) return;
    const loop = () => {
      if (!state.open) {
        state.raf = 0;
        return;
      }
      const moving = state.alpha > PHYS.minAlpha;
      if (moving) {
        tick();
        if (state.autoFrame) frameContent(.28);
      }
      if (moving || focusPaint.animating) draw();
      state.raf = state.alpha > PHYS.minAlpha || focusPaint.animating ? requestAnimationFrame(loop) : 0;
    };
    state.raf = requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------------ отрисовка

  function resize(paint = true) {
    if (!shell) return false;
    const rect = shell.stage.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height));
    if (w === state.w && h === state.h && dpr === state.dpr) return false;
    Object.assign(state, { w, h, dpr });
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    if (state.autoFrame && state.nodes.length) frameContent();
    if (paint) draw();
    return true;
  }

  function toScreen(node) {
    return {
      x: (node.x + state.tx) * state.zoom + state.w / 2,
      y: (node.y + state.ty) * state.zoom + state.h / 2,
    };
  }

  function toWorld(sx, sy) {
    return {
      x: (sx - state.w / 2) / state.zoom - state.tx,
      y: (sy - state.h / 2) / state.zoom - state.ty,
    };
  }

  function screenRadius(node) {
    const base = (node.kind === 'node' || node.kind === 'note' ? 2.45 : 3.15) + .95 * Math.sqrt(node.degree);
    const scale = Math.max(.64, Math.min(2.25, Math.sqrt(state.zoom)));
    return Math.min(18, base) * state.sizeScale * scale;
  }

  function updateFocus() {
    // Физика может уже спать. Подсветка использует тот же RAF, пока меняется цвет.
    if (focusPaint.nodes !== state.nodes) {
      Object.assign(focusPaint, { nodes: state.nodes, key: null, amount: 0, animating: false });
      for (const node of state.nodes) {
        node.focus = 0;
        node.visibility = 1;
      }
    }
    const now = performance.now();
    if (focusPaint.animating) {
      const t = Math.min(1, (now - focusPaint.started) / FOCUS_FADE_MS);
      const ease = t * t * (3 - 2 * t);
      focusPaint.amount = 0;
      for (const node of state.nodes) {
        node.focus = node.focusFrom + (node.focusTo - node.focusFrom) * ease;
        node.visibility = node.visibilityFrom + (node.visibilityTo - node.visibilityFrom) * ease;
        focusPaint.amount += node.focus;
      }
      focusPaint.animating = t < 1;
    }

    const key = state.dragging?.node.key || state.hover || state.localId;
    if (key === focusPaint.key) return;
    // При быстром переходе А → Б весь граф продолжает с текущего оттенка.
    const target = key && state.nodes.some(node => node.key === key) ? key : null;
    if (target === focusPaint.key) return;
    const neighbors = target ? oneHop(new Set([target]), state.links) : null;
    for (const node of state.nodes) {
      node.focusFrom = node.focus;
      node.visibilityFrom = node.visibility;
      node.focusTo = node.key === target ? 1 : 0;
      node.visibilityTo = !neighbors || neighbors.has(node.key) ? 1 : .20;
    }
    Object.assign(focusPaint, { key: target, started: now, animating: true });
    startLoop();
  }

  function draw() {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    updateFocus();
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.clearRect(0, 0, state.w, state.h);
    for (const n of state.nodes) {
      const point = toScreen(n);
      n.sx = point.x;
      n.sy = point.y;
      n.radius = screenRadius(n);
      n.onScreen = n.sx + n.radius >= 0 && n.sx - n.radius <= state.w &&
        n.sy + n.radius >= 0 && n.sy - n.radius <= state.h;
    }

    // Обычно две партии штрихов: все связи и связи активного узла.
    // При смене фокуса добавляется партия для угасающей подсветки.
    const baseLinks = new Path2D();
    const highlightedLinks = new Map();
    for (const link of state.links) {
      const a = state.byId.get(link.source), b = state.byId.get(link.target);
      baseLinks.moveTo(a.sx, a.sy);
      baseLinks.lineTo(b.sx, b.sy);
      const strength = Math.min(1, a.focus + b.focus);
      if (strength <= 0) continue;
      let path = highlightedLinks.get(strength);
      if (!path) {
        path = new Path2D();
        highlightedLinks.set(strength, path);
      }
      path.moveTo(a.sx, a.sy);
      path.lineTo(b.sx, b.sy);
    }
    const violet = light ? '#7049c7' : '#8153ec';
    ctx.lineWidth = 1;
    ctx.strokeStyle = light ? '#acaab1' : '#3f3f3f';
    ctx.globalAlpha = 1 - .80 * focusPaint.amount;
    ctx.stroke(baseLinks);
    ctx.strokeStyle = violet;
    for (const [strength, path] of highlightedLinks) {
      ctx.globalAlpha = strength;
      ctx.stroke(path);
    }

    for (const node of state.nodes) {
      if (!node.onScreen) continue;
      ctx.globalAlpha = node.visibility;
      ctx.fillStyle = node.color;
      ctx.beginPath();
      ctx.arc(node.sx, node.sy, node.radius, 0, 2 * Math.PI);
      ctx.fill();
      if (node.focus > 0) {
        ctx.globalAlpha = node.focus;
        ctx.fillStyle = violet;
        ctx.fill();
        ctx.lineWidth = .75;
        ctx.globalAlpha = node.focus * .65;
        ctx.strokeStyle = light ? '#49337a' : '#c7afff';
        ctx.stroke();
      } else if (light) {
        ctx.lineWidth = .65;
        ctx.strokeStyle = '#77717c';
        ctx.stroke();
      }
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    if (state.labelThreshold < 13 && focusPaint.amount < 1) drawDegreeLabels(ctx);
    for (const node of state.nodes) {
      if (node.onScreen && node.focus > 0) drawFocusLabel(ctx, node);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  function drawDegreeLabels(ctx) {
    const size = Math.round(10 + Math.min(4, state.zoom * 1.4));
    ctx.font = size + 'px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = light ? '#554e5d' : '#c6c2ca';
    ctx.globalAlpha = 1 - focusPaint.amount;
    const candidates = state.nodes.filter(n => n.onScreen && n.degree >= state.labelThreshold)
      .sort((a, b) => b.degree - a.degree);
    const taken = [];
    for (const n of candidates) {
      const text = n.label.length > 26 ? n.label.slice(0, 25) + '…' : n.label;
      const halfWidth = ctx.measureText(text).width / 2 + 3;
      const y = n.sy + n.radius + 3;
      const box = { left: n.sx - halfWidth, right: n.sx + halfWidth, top: y, bottom: y + size + 3 };
      if (taken.some(b => box.left < b.right && box.right > b.left && box.top < b.bottom && box.bottom > b.top)) continue;
      ctx.fillText(text, n.sx, y);
      taken.push(box);
      if (taken.length >= 220) break;
    }
  }

  function drawFocusLabel(ctx, node) {
    const size = Math.round(Math.max(14, Math.min(23, 15 * Math.sqrt(state.zoom))));
    ctx.font = size + 'px "Segoe UI", system-ui, sans-serif';
    const maxWidth = Math.max(1, Math.min(state.w - 12, size * 22));
    const lines = [];
    let line = '';
    for (const word of node.label.split(/\s+/)) {
      const next = line ? line + ' ' + word : word;
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line);
        if (lines.length === 3) {
          lines[2] += '…';
          line = '';
          break;
        }
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    const half = Math.min(maxWidth, Math.max(0, ...lines.map(s => ctx.measureText(s).width))) / 2;
    const x = Math.max(half + 6, Math.min(state.w - half - 6, node.sx));
    const lineHeight = size * 1.2;
    const height = lineHeight * lines.length;
    const below = node.sy + node.radius + 7;
    const y = below + height <= state.h ? below : Math.max(2, node.sy - node.radius - height - 7);
    ctx.globalAlpha = node.focus;
    ctx.fillStyle = light ? '#302e34' : '#dadada';
    lines.forEach((text, i) => ctx.fillText(text, x, y + i * lineHeight, maxWidth));
  }

  // ------------------------------------------------------------------ панель

  function renderSide() {
    if (!shell) return;
    const side = shell.side;
    const groups = state.groups;
    const nOn = state.nodes.length;
    const lOn = state.links.length;

    side.innerHTML = `
      <section class="viz-group">
        <div class="viz-group-head">
          <span class="viz-group-title">${uiText("Фильтры", "Filters")}</span>
          <button class="viz-reset" type="button" data-viz="reset" title="${uiText("Сбросить фильтры", "Reset filters")}">${uiText("Сбросить", "Reset")}</button>
        </div>
        <label class="viz-search">
          <input type="search" aria-label="${uiText("Поиск связей по сюжету", "Search story connections")}" placeholder="${uiText("Поиск по сюжету", "Search story")}…" value="${escapeAttr(state.search)}" data-viz="search" />
        </label>
        <div class="viz-toggles">
          ${toggle('characters', uiText("Персонажи", "Characters"))}
          ${toggle('locations', uiText("Локации", "Locations"))}
          ${toggle('variables', uiText("Переменные", "Variables"))}
          ${toggle('chapters', uiText("Главы", "Chapters"))}
          ${toggle('notes', uiText("Заметки", "Notes"))}
          ${toggle('orphans', uiText("Узлы без связей", "Unlinked nodes"))}
        </div>
        <label class="viz-check">
          <input type="checkbox" data-viz="reachable" ${state.onlyReachable ? 'checked' : ''} />
          <span>${uiText("Только достижимые", "Reachable only")}</span>
        </label>
      </section>

      <section class="viz-group">
        <div class="viz-group-head"><span class="viz-group-title">${uiText("Группы по главам", "Chapter groups")}</span></div>
        <div class="viz-groups">
          ${
            groups.length
              ? groups
                  .map(
                    (g) => `<button type="button" class="viz-group-row ${state.hiddenChapters.has(g.id) ? 'is-off' : ''}" data-viz="chapter" data-id="${escapeAttr(g.id)}">
                      <span class="viz-dot" style="background:${g.color}"></span>
                      <span class="viz-group-name">${escapeHTML(g.name)}</span>
                      <span class="viz-group-count">${g.count}</span>
                    </button>`,
                  )
                  .join('')
              : uiText("<p class=\"viz-empty\">В проекте пока нет глав.</p>", "<p class=\"viz-empty\">No chapters in this project yet.</p>")
          }
        </div>
      </section>

      <section class="viz-group">
        <button class="viz-group-head is-fold" type="button" data-viz="fold" data-target="display">
          <span class="viz-group-title">${uiText("Отображение", "Display")}</span>
        </button>
        <div class="viz-fold" data-fold="display">
          <label class="viz-slider">
            <span>${uiText("Показывать подписи", "Show labels")}</span>
            <input type="range" min="0" max="13" step="1" value="${state.labelThreshold}" aria-valuetext="${labelSetting()}" data-viz="labels" />
            <output>${labelSetting()}</output>
          </label>
          <label class="viz-slider">
            <span>${uiText("Размер точек", "Node size")}</span>
            <input type="range" min="0.6" max="1.8" step="0.1" value="${state.sizeScale}" data-viz="size" />
            <output>${state.sizeScale.toFixed(1)}×</output>
          </label>
        </div>
      </section>

      <section class="viz-group">
        <button class="viz-group-head is-fold" type="button" data-viz="fold" data-target="forces">
          <span class="viz-group-title">${uiText("Силы", "Forces")}</span>
        </button>
        <div class="viz-fold is-folded" data-fold="forces">
          <label class="viz-slider">
            <span>${uiText("Отталкивание", "Repulsion")}</span>
            <input type="range" min="600" max="6000" step="100" value="${state.forces.repulsion}" data-viz="repulsion" />
            <output>${Math.round(state.forces.repulsion)}</output>
          </label>
          <label class="viz-slider">
            <span>${uiText("Длина связи", "Link distance")}</span>
            <input type="range" min="18" max="90" step="2" value="${state.forces.link}" data-viz="link" />
            <output>${Math.round(state.forces.link)}</output>
          </label>
          <label class="viz-slider">
            <span>${uiText("Тяга к центру", "Center force")}</span>
            <input type="range" min="0" max="0.05" step="0.002" value="${state.forces.gravity}" data-viz="gravity" />
            <output>${state.forces.gravity.toFixed(3)}</output>
          </label>
        </div>
      </section>

      <p class="viz-stat" data-viz="stat"></p>
      <p class="viz-legend">
        ${Object.entries(KIND_LABELS).map(([kind, name]) => legendRow(kind, name)).join('')}
      </p>`;

    const stat = root.querySelector('[data-viz="stat"]');
    if (stat) stat.textContent = `${nOn} ${pluralNodes(nOn)} · ${lOn} ${pluralLinks(lOn)}`;
  }

  function toggle(key, label) {
    const checked = state.show[key] ? 'checked' : '';
    return `<label class="viz-check"><input type="checkbox" data-viz="show" data-key="${key}" ${checked} /><span>${label}</span></label>`;
  }

  function labelSetting() {
    if (state.labelThreshold === 13) return uiText("При наведении", "On hover");
    return state.labelThreshold === 0 ? uiText("У всех точек", "All nodes") : uiText("Связей ≥ ", "Links ≥ ") + state.labelThreshold;
  }

  function legendRow(kind, text) {
    const color = KIND_COLORS[kind] || KIND_COLORS.note;
    return `<span class="viz-legend-row"><span class="viz-dot" style="background:${color}"></span>${text}</span>`;
  }

  function pluralNodes(n) {
    if (getLanguage() === 'en') return n === 1 ? 'node' : 'nodes';
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return uiText("узлов", "nodes");
    if (b > 1 && b < 5) return uiText("узла", "nodes");
    if (b === 1) return uiText("узел", "node");
    return uiText("узлов", "nodes");
  }

  function pluralLinks(n) {
    if (getLanguage() === 'en') return n === 1 ? 'link' : 'links';
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return uiText("связей", "links");
    if (b > 1 && b < 5) return uiText("связи", "links");
    if (b === 1) return uiText("связь", "link");
    return uiText("связей", "links");
  }

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(s) {
    return escapeHTML(s).replace(/'/g, '&#39;');
  }

  // ------------------------------------------------------------------ события

  function pick(sx, sy) {
    let best = null;
    let bestD = Infinity;
    for (const node of state.nodes) {
      const p = toScreen(node);
      const r = screenRadius(node);
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d <= r + 5 && d < bestD) {
        best = node;
        bestD = d;
      }
    }
    return best;
  }

  function localPoint(ev) {
    const rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  function moveHeld(drag, pt) {
    const travel = Math.hypot(pt.x - drag.start.x, pt.y - drag.start.y);
    if (!drag.moved && travel < 4) return;
    drag.moved = true;
    drag.travel = travel / state.zoom;
    relaxingDrag = true;
    const world = toWorld(pt.x, pt.y);
    drag.node.x = world.x + drag.offsetX;
    drag.node.y = world.y + drag.offsetY;
    reheat(0.35);
  }

  function releaseGesture() {
    const gesture = state.dragging || state.panning;
    if (!gesture) return;
    if (state.dragging) {
      const node = state.dragging.node;
      node.fixed = false;
      node.vx = node.vy = 0;
      if (state.dragging.moved) {
        relaxingDrag = true;
        state.alpha = Math.max(state.alpha, 0.45);
      }
    }
    state.dragging = null;
    state.panning = null;
    state.hover = null;
    canvas.style.cursor = 'grab';
    if (canvas.hasPointerCapture(gesture.pointerId)) canvas.releasePointerCapture(gesture.pointerId);
  }

  function cancelGesture(ev) {
    const gesture = state.dragging || state.panning;
    if (ev.pointerId != null && gesture?.pointerId !== ev.pointerId) return;
    if (!gesture && !state.hover) return;
    releaseGesture();
    state.hover = null;
    canvas.style.cursor = 'grab';
    if (state.open) {
      if (state.alpha > PHYS.minAlpha) startLoop();
      draw();
    }
  }

  function wireCanvas() {
    canvas.addEventListener('pointerdown', (ev) => {
      if ((ev.button !== 0 && ev.button !== 1) || state.dragging || state.panning) return;
      state.autoFrame = false;
      const pt = localPoint(ev);
      const hit = ev.button === 0 ? pick(pt.x, pt.y) : null;
      canvas.setPointerCapture(ev.pointerId);
      if (hit) {
        const world = toWorld(pt.x, pt.y);
        state.dragging = {
          pointerId: ev.pointerId, node: hit, moved: false, start: pt,
          offsetX: hit.x - world.x, offsetY: hit.y - world.y,
        };
        hit.fixed = true;
        hit.vx = hit.vy = 0;
        state.hover = hit.key;
      } else {
        state.panning = { pointerId: ev.pointerId, start: pt, tx: state.tx, ty: state.ty };
        state.hover = null;
      }
      canvas.style.cursor = 'grabbing';
      draw();
    });

    canvas.addEventListener('pointermove', (ev) => {
      const gesture = state.dragging || state.panning;
      if (gesture && gesture.pointerId !== ev.pointerId) return;
      const pt = localPoint(ev);
      if (state.dragging) {
        moveHeld(state.dragging, pt);
        draw();
        return;
      }
      if (state.panning) {
        state.tx = state.panning.tx + (pt.x - state.panning.start.x) / state.zoom;
        state.ty = state.panning.ty + (pt.y - state.panning.start.y) / state.zoom;
        draw();
        return;
      }
      const hit = pick(pt.x, pt.y);
      const key = hit ? hit.key : null;
      if (key !== state.hover) {
        state.hover = key;
        canvas.style.cursor = key ? 'pointer' : 'grab';
        draw();
      }
    });

    canvas.addEventListener('pointerup', (ev) => {
      const drag = state.dragging;
      const gesture = drag || state.panning;
      if (gesture?.pointerId !== ev.pointerId) return;
      if (drag) moveHeld(drag, localPoint(ev));
      releaseGesture();
      if (drag?.moved) startLoop();
      draw();
      if (drag && !drag.moved) openNode(drag.node);
    });
    canvas.addEventListener('pointercancel', cancelGesture);
    canvas.addEventListener('lostpointercapture', cancelGesture);
    canvas.addEventListener('pointerleave', () => {
      if (state.hover && !state.dragging && !state.panning) {
        state.hover = null;
        canvas.style.cursor = 'grab';
        draw();
      }
    });

    canvas.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        state.autoFrame = false;
        const pt = localPoint(ev);
        const before = toWorld(pt.x, pt.y);
        const factor = Math.exp(-ev.deltaY * 0.0016);
        state.zoom = Math.min(6, Math.max(0.15, state.zoom * factor));
        // держим точку под курсором на месте
        state.tx = (pt.x - state.w / 2) / state.zoom - before.x;
        state.ty = (pt.y - state.h / 2) / state.zoom - before.y;
        draw();
      },
      { passive: false },
    );

    canvas.addEventListener('dblclick', layoutAll);
  }

  function openNode(node) {
    state.selected = node.key;
    const kind = node.kind === 'note' ? 'node' : node.kind;
    if (ui.workbench) {
      ui.workbench.openEntity(kind, node.key);
      return;
    }
    close();
    if (kind === 'node') ui.selectNode(node.key);
    else ui.selectEntity(kind, node.key);
  }

  function wireSide() {
    const side = shell.side;

    side.addEventListener('input', (ev) => {
      const t = ev.target;
      const act = t.dataset.viz;
      if (act === 'search') {
        state.search = t.value;
        rebuild({ keepPositions: true, updateCountsOnly: true });
        return;
      }
      if (act === 'labels') {
        state.labelThreshold = Number(t.value);
        const out = t.parentElement.querySelector('output');
        t.setAttribute('aria-valuetext', labelSetting());
        if (out) out.textContent = labelSetting();
        draw();
        return;
      }
      if (act === 'size') {
        state.sizeScale = Number(t.value);
        const out = t.parentElement.querySelector('output');
        if (out) out.textContent = `${state.sizeScale.toFixed(1)}×`;
        draw();
        return;
      }
      if (act === 'repulsion' || act === 'link' || act === 'gravity') {
        state.forces[act] = Number(t.value);
        const out = t.parentElement.querySelector('output');
        if (out) out.textContent = act === 'gravity' ? state.forces.gravity.toFixed(3) : String(Math.round(state.forces[act]));
        reheat(0.6);
        return;
      }
      if (act === 'reachable') {
        state.onlyReachable = t.checked;
        rebuild({ keepPositions: true });
      }
    });

    side.addEventListener('change', (ev) => {
      const t = ev.target;
      if (t.dataset.viz === 'show') {
        state.show[t.dataset.key] = t.checked;
        rebuild({ keepPositions: true });
      }
    });

    side.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-viz]');
      if (!btn) return;
      const act = btn.dataset.viz;
      if (act === 'reset') {
        state.show = { ...DEFAULTS.show };
        state.onlyReachable = false;
        state.search = '';
        state.localId = null;
        state.hiddenChapters.clear();
        state.labelThreshold = DEFAULTS.labels;
        state.sizeScale = DEFAULTS.sizeScale;
        state.forces = { ...DEFAULTS.forces };
        rebuild({});
        return;
      }
      if (act === 'chapter') {
        const id = btn.dataset.id;
        if (state.hiddenChapters.has(id)) state.hiddenChapters.delete(id);
        else state.hiddenChapters.add(id);
        rebuild({ keepPositions: true });
        return;
      }
      if (act === 'fold') {
        const fold = side.querySelector(`[data-fold="${btn.dataset.target}"]`);
        if (fold) {
          fold.classList.toggle('is-folded');
          btn.classList.toggle('is-closed', fold.classList.contains('is-folded'));
        }
      }
    });
  }

  function wireHead() {
    shell.head.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-viz]');
      if (!btn) return;
      const act = btn.dataset.viz;
      if (act === 'settings') {
        shell.side.hidden = !shell.side.hidden;
        btn.setAttribute('aria-expanded', String(!shell.side.hidden));
        if (!shell.side.hidden) shell.side.querySelector('[data-viz="search"]')?.focus();
      } else if (act === 'close') close();
      else if (act === 'refit') fit();
      else if (act === 'relayout') layoutAll();
    });

    root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        if (!shell.side.hidden) {
          shell.side.hidden = true;
          const toggle = shell.head.querySelector('[data-viz="settings"]');
          toggle.setAttribute('aria-expanded', 'false');
          toggle.focus();
        } else close();
      } else if (ev.target.closest('input,textarea,select')) return;
      else if (ev.key === 'f' || ev.key === 'F' || ev.key === 'а' || ev.key === 'А') {
        fit();
      } else if (ev.key === 'r' || ev.key === 'R' || ev.key === 'к' || ev.key === 'К') {
        layoutAll();
      }
    });
  }

  // ------------------------------------------------------------------ жизненный цикл

  function rebuild({ keepPositions = false, updateCountsOnly = false } = {}) {
    releaseGesture();
    relaxingDrag = false;
    const prev = keepPositions ? new Map(state.nodes.map((n) => [n.key, { x: n.x, y: n.y }])) : null;
    const g = buildGraph();
    builtRevision = store.revision;
    state.nodes = g.nodes;
    state.links = g.links;
    state.groups = g.groups;
    state.byId = g.byId;

    if (prev) {
      for (const node of state.nodes) {
        const old = prev.get(node.key);
        if (old) {
          node.x = old.x;
          node.y = old.y;
        }
      }
    }
    // новые точки без координат — на окружность
    const fresh = state.nodes.filter((n) => !n.x && !n.y && !prev?.has(n.key));
    if (fresh.length) {
      const n = state.nodes.length || 1;
      let k = 0;
      for (const node of state.nodes) {
        if (node.x || node.y) continue;
        const angle = (k++ / Math.max(1, fresh.length)) * Math.PI * 2;
        node.x = Math.cos(angle) * Math.sqrt(n) * 30;
        node.y = Math.sin(angle) * Math.sqrt(n) * 30;
      }
    }
    if (!state.nodes.some((n) => n.x || n.y)) seedPositions();

    if (updateCountsOnly) {
      const groups = new Map(state.groups.map(g => [g.id, g.count]));
      for (const btn of shell.side.querySelectorAll('[data-viz="chapter"]')) {
        btn.querySelector('.viz-group-count').textContent = groups.get(btn.dataset.id) || 0;
      }
      const stat = shell.side.querySelector('[data-viz="stat"]');
      stat.textContent = `${state.nodes.length} ${pluralNodes(state.nodes.length)} · ${state.links.length} ${pluralLinks(state.links.length)}`;
    } else renderSide();
    if (!keepPositions) layoutAll();
    else {
      reheat(0.35);
      draw();
    }
  }

  function layoutAll() {
    releaseGesture();
    relaxingDrag = false;
    seedPositions();
    fit();
    reheat(1);
  }

  function fit() {
    state.autoFrame = true;
    frameContent();
    draw();
  }

  // During the initial relaxation keep the moving cloud framed. The first
  // manual pan, drag or wheel takes ownership of the camera until the next fit.
  function frameContent(blend = 1) {
    const nodes = state.nodes;
    if (!nodes.length) {
      state.zoom = 1;
      state.tx = 0;
      state.ty = 0;
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
      maxY = Math.max(maxY, n.y);
    }
    const pad = Math.max(20, Math.min(120, Math.min(state.w, state.h) * .12));
    const spanX = Math.max(80, maxX - minX);
    const spanY = Math.max(80, maxY - minY);
    const zoom = Math.max(.04, Math.min(6, (state.w - 2 * pad) / spanX, (state.h - 2 * pad) / spanY));
    state.zoom += (zoom - state.zoom) * blend;
    state.tx += (-(minX + maxX) / 2 - state.tx) * blend;
    state.ty += (-(minY + maxY) / 2 - state.ty) * blend;
  }

  function open(localId = null) {
    if (typeof localId !== 'string') localId = null;
    if (state.open && state.localId === localId) return;
    const changedRegion = state.localId !== localId;
    state.localId = localId;
    if (localId) state.selected = localId;
    if (localId && changedRegion) {
      state.search = '';
      state.onlyReachable = false;
      const anchor = nodesOf().find(n => n.id === localId);
      if (anchor) state.hiddenChapters.delete(anchor.chapterId);
    }
    if (!state.open) opener = document.activeElement;
    state.open = true;
    root.classList.remove('hidden');
    if (!shell) {
      shell = buildShell();
      stageWatcher.observe(shell.stage);
      wireCanvas();
      wireSide();
      wireHead();
    }
    refreshChromeLanguage();
    const resized = resize(false);
    if (!state.ready || changedRegion || builtRevision !== store.revision) {
      rebuild({ keepPositions: state.ready && !changedRegion });
      state.ready = true;
    } else {
      if (resized || repaintOnOpen) draw();
      if (state.alpha > PHYS.minAlpha) startLoop();
    }
    repaintOnOpen = false;
    root.focus?.();
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    repaintOnOpen ||= Boolean(state.hover || state.dragging || focusPaint.amount || focusPaint.animating);
    focusPaint.nodes = null;
    releaseGesture();
    state.hover = null;
    canvas.style.cursor = 'grab';
    if (state.raf) {
      cancelAnimationFrame(state.raf);
      state.raf = 0;
    }
    const returnFocus = root.contains(document.activeElement);
    root.classList.add('hidden');
    if (returnFocus && opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
    if (typeof ui.onVisualizerClose === 'function') ui.onVisualizerClose();
  }

  function destroy() {
    close();
    themeWatcher.disconnect();
    stageWatcher.disconnect();
    unsubscribe();
    window.removeEventListener('resize', onWindowResize);
    window.removeEventListener('blur', cancelGesture);
    root.innerHTML = '';
  }

  // ------------------------------------------------------------------ подписка

  let previousGeneration = store.generation;
  const unsubscribe = store.subscribe((evt) => {
    if (evt.type === 'project' && previousGeneration !== store.generation) {
      previousGeneration = store.generation;
      state.search = '';
      state.localId = null;
      state.selected = null;
      state.hover = null;
      state.ready = false;
      state.onlyReachable = false;
      releaseGesture();
      state.hiddenChapters.clear();
    }
    if (!state.open) return;
    if (evt.type === 'project' || evt.type === 'change') {
      rebuild({ keepPositions: state.ready });
      state.ready = true;
    }
  });

  function onWindowResize() {
    if (state.open) resize();
  }
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('blur', cancelGesture);

  return {
    open,
    openNeighborhood: id => open(id),
    close,
    destroy,
    isOpen: () => state.open,
    toggle() {
      if (state.open) close();
      else open();
    },
    render() {
      refreshChromeLanguage();
      if (state.open) rebuild({ keepPositions: true });
    },
    fit,
    relayout: layoutAll,
    state,
    get stats() {
      return { nodes: state.nodes.length, links: state.links.length };
    },
    unsubscribe,
  };
}
