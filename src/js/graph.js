import { t as uiText } from './i18n.js';
// StoryForge — SVG-граф: карточки узлов, рёбра с подписями, пан/зум,
// перетаскивание, контекстное меню, автораскладка, фильтры.
import {
  TYPE_LABELS,
  NODE_TYPES,
  autoLayout as computeLayout,
  nodeSpeakerName,
  nodeLocationName,
  countWords,
  nodeCardHeight,
  nodePreviewId,
} from './model.js';
import { compileNodeQuery } from './story-search.js';

const TYPE_GLYPHS = {
  line: '<path d="M3 4h10v7H7l-3 2v-2H3z"/>',
  choice: '<path d="M4 13V8m0 2 7-6M8 4h4v4M2 4h4m-2 0v4"/>',
  condition: '<path d="m8 1 6 7-6 7-6-7z"/>',
  jump: '<path d="M2 12h3l5-8h4m-3-2 3 2-2 3"/>',
  scene: '<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M2 6h12m-8-3 2 3m2-3 2 3"/>',
  end: '<path d="M4 14V2m0 1h9l-2.5 3L13 9H4"/>',
  note: '<path d="M3 2h6l4 4v8H3zM9 2v4h4M5 9h6m-6 2h4"/>',
};
const CARD_W = 220;
const CARD_H = 90; // базовая (без изображения) высота карточки
const MEDIA_PAD = 10; // отступ полосы превью от краёв карточки
const MEDIA_GAP = 6; // зазор между текстовой частью и полосой превью
const MEDIA_BAND_HEIGHT = 58; // высота полосы превью внутри карточки

// Высота карточки конкретного узла: с превью карточка выше на полосу фото.
const heightOf = (node) => (node ? nodeCardHeight(node) : CARD_H);
const hasMedia = (node) => Boolean(node && nodePreviewId(node));
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
// Ниже этого увеличения текст в карточках нечитаем: 13 px × 0.55 ≈ 7 px.
const LOD_TEXT_ZOOM = 0.55;
// Запас вокруг кадра, в котором текст карточек ещё раскладывается: чтобы при
// пане и мелких сдвигах подписи не появлялись рывком.
const CULL_MARGIN = 600;

export function createGraph({ host, svg, store, ui }) {
  const esc = (s) => ui.escapeHTML(s);

  const view = { x: 40, y: 40, k: 1 };
  let filter = { chapterId: '', text: '', showNotes: true };
  let queryCache;
  let lodFrame = null;
  const zoomLabel = document.getElementById('zoomLabel');
  let displayedZoom = '';
  let hostWidth = host.clientWidth;
  let hostHeight = host.clientHeight;
  const sizeWatcher = new ResizeObserver(([entry]) => {
    hostWidth = entry.contentRect.width;
    hostHeight = entry.contentRect.height;
    lodFrame = null;
    updateLod();
  });
  sizeWatcher.observe(host);
  let dragState = null;
  let panState = null;
  let lastSignature = '';
  let renderedGeneration = -1;
  let nodeIndex = new Map(); // id -> node (на момент рендера)
  let elIndex = new Map(); // id -> <g>
  let edgeIndex = []; // { from, to, el, kind }
  let selectedId = null;
  let wired = false;
  let skippedRender = false;
  let renderedIds = '';
  let cardSig = new Map(); // id -> подпись содержимого карточки
  let cardPos = new Map(); // id -> подпись позиции
  let cardHeights = new Map(); // id -> фактическая высота карточки
  let edgesSig = '';

  const project = () => store.project;
  const nodes = () => project().nodes || [];
  const nodeById = (id) => nodeIndex.get(id) || nodes().find((n) => n.id === id) || null;

  // ---------------------------------------------------------------- координаты

  function positionOf(node, i) {
    const pos = node.position;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) return { x: pos.x, y: pos.y };
    // детерминированная подстановка, пока позиции нет
    const seed = hashId(node.id);
    return { x: (seed % 7) * 280, y: Math.floor(seed % 11) * 150 };
  }

  function hashId(id) {
    let h = 0;
    for (let i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) % 100003;
    return h;
  }

  function applyTransform() {
    const vp = svg.querySelector('#sfViewport');
    if (vp) vp.setAttribute('transform', `translate(${view.x.toFixed(2)} ${view.y.toFixed(2)}) scale(${view.k.toFixed(4)})`);
    const zoom = `${Math.round(view.k * 100)}%`;
    if (zoom !== displayedZoom && zoomLabel) {
      zoomLabel.textContent = zoom;
      displayedZoom = zoom;
    }
    updateLod();
  }

  /**
   * Отсечение текста. Каждый текстовый узел в SVG стоит денег при лэйауте:
   * на 200 карточках их 1239, и любой лэйаут документа (например, от ввода
   * в инспекторе) стоит ~40 мс, пока они все раскладываются. Поэтому:
   *  - при мелком зуме текст не нужен совсем (нечитаем) — класс .is-small;
   *  - при рабочем зуме текст оставляем только у карточек в кадре, остальным
   *    ставим .is-far. Координаты берём из модели, getBoundingClientRect не
   *    трогаем, чтобы самим не спровоцировать лэйаут.
   */
  function updateLod() {
    // The larger visibility rectangle leaves room for panning before we have
    // to revisit the DOM. Geometry changes and resize invalidate it immediately.
    const ox = -view.x / view.k, oy = -view.y / view.k;
    if (lodFrame && lodFrame.zoom === view.k &&
        Math.abs(lodFrame.x - ox) < CULL_MARGIN / 3 && Math.abs(lodFrame.y - oy) < CULL_MARGIN / 3) return;
    lodFrame = { x: ox, y: oy, zoom: view.k };
    svg.classList.toggle('is-small', view.k < LOD_TEXT_ZOOM);
    const left = ox - CULL_MARGIN, top = oy - CULL_MARGIN;
    const right = ox + hostWidth / view.k + CULL_MARGIN, bottom = oy + hostHeight / view.k + CULL_MARGIN;
    for (const [id, el] of elIndex) {
      const node = nodeIndex.get(id);
      if (!node) continue;
      const pos = positionOf(node);
      const on = pos.x + CARD_W > left && pos.x < right && pos.y + heightOf(node) > top && pos.y < bottom;
      const far = el.classList.contains('is-far');
      if (on && far) el.classList.remove('is-far');
      else if (!on && !far) el.classList.add('is-far');
    }
    for (const edge of edgeIndex) {
      const from = nodeIndex.get(edge.from), to = nodeIndex.get(edge.to);
      if (!from || !to) continue;
      const a = positionOf(from), b = positionOf(to);
      const x1 = a.x + CARD_W, x2 = b.x;
      const y1 = a.y + heightOf(from)/2, y2 = b.y + heightOf(to)/2;
      const bend = Math.max(40, Math.abs(x2 - x1) / 2);
      // Cubic lies in the convex hull of its four control points.
      const outside = Math.max(x1+bend,x2) < left || Math.min(x1,x2-bend) > right ||
        Math.max(y1,y2) < top || Math.min(y1,y2) > bottom;
      edge.el.classList.toggle('is-far', outside);
      edge.labelEl?.classList.toggle('is-far', outside);
    }
  }

  function clientToWorld(clientX, clientY) {
    const rect = host.getBoundingClientRect();
    return { x: (clientX - rect.left - view.x) / view.k, y: (clientY - rect.top - view.y) / view.k };
  }

  // ---------------------------------------------------------------- текст

  function wrapText(text, maxChars, maxLines) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    if (!flat) return [];
    const words = flat.split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      if (!cur) cur = w;
      else if (`${cur} ${w}`.length <= maxChars) cur = `${cur} ${w}`;
      else {
        lines.push(cur);
        cur = w;
        if (lines.length === maxLines) break;
      }
    }
    if (lines.length < maxLines && cur) lines.push(cur);
    if (lines.length === maxLines) {
      const joined = lines.join(' ');
      if (joined.length < flat.length) lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, maxChars - 1)}…`;
    }
    return lines.slice(0, maxLines);
  }

  // ---------------------------------------------------------------- рёбра

  function edgePath(fromPos, toPos, fromH = CARD_H, toH = CARD_H) {
    const x1 = fromPos.x + CARD_W;
    const y1 = fromPos.y + fromH / 2;
    const x2 = toPos.x;
    const y2 = toPos.y + toH / 2;
    const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  }

  function bezierPoint(fromPos, toPos, t, fromH = CARD_H, toH = CARD_H) {
    const x1 = fromPos.x + CARD_W;
    const y1 = fromPos.y + fromH / 2;
    const x2 = toPos.x;
    const y2 = toPos.y + toH / 2;
    const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
    const c1x = x1 + dx;
    const c2x = x2 - dx;
    const mt = 1 - t;
    const x = mt * mt * mt * x1 + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * x2;
    const y = mt * mt * mt * y1 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y2;
    return { x, y };
  }

  function collectEdges() {
    const list = [];
    const all = nodes();
    const ids = new Set(all.map((n) => n.id));
    for (const n of all) {
      if (n.type === 'note') continue;
      if (n.next) {
        list.push({ from: n.id, to: n.next, kind: 'next', label: '', broken: !ids.has(n.next) });
      }
      for (const c of n.choices || []) {
        if (c.next) list.push({ from: n.id, to: c.next, kind: 'choice', label: c.text || '', broken: !ids.has(c.next) });
      }
      for (const b of n.branches || []) {
        if (b.next) list.push({ from: n.id, to: b.next, kind: 'branch', label: b.condition || uiText("иначе", "else"), broken: !ids.has(b.next) });
      }
    }
    return list;
  }

  // ---------------------------------------------------------------- рендер

  // короткий хеш строки: сигнатура должна замечать правку текста той же длины
  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return h;
  }

  function buildSignature() {
    const list = nodes();
    const parts = [filter.text ? store.revision : 0, list.length, store.selection?.id || '', filter.chapterId, filter.text, filter.showNotes ? '1' : '0'];
    for (const n of list) parts.push(n.id, nodeSig(n), n.position?.x ?? 'x', n.position?.y ?? 'y');
    return parts.join('|');
  }

  // Подпись того, что нарисовано внутри карточки. Меняется только тогда, когда
  // действительно надо перерисовать карточку (текст, спикер, выборы, фото…).
  function nodeSig(n) {
    return [
      n.type,
      hash(n.text || ''),
      hash(n.title || ''),
      n.next || '',
      (n.choices || []).length,
      hash((n.choices || []).map((c) => c.text).join('\u0001')),
      hash((n.choices || []).map(c => c.next).join('|')),
      hash((n.branches || []).map(b => b.condition + ':' + b.next).join('|')),
      n.chapterId, n.locationId, nodeSpeakerName(project(), n), (n.tags || []).join('|'),
      n.speakerId || '',
      n.color || '',
      nodePreviewId(n),
      (n.media || []).length,
      (n.effects || []).length,
      n.id === project().startNodeId ? 'S' : '',
    ].join('\u0002');
  }

  function edgesSignature(edges) {
    return edges.map((e) => [e.from, e.to, e.kind, hash(e.label || ''), e.broken ? 'b' : ''].join('\u0002')).join('\u0001');
  }

  function posSig(pos) {
    return `${pos.x},${pos.y}`;
  }

  function matchesFilter(n) {
    if (!filter.showNotes && n.type === 'note') return false;
    if (filter.chapterId && n.chapterId !== filter.chapterId) return false;
    if (filter.text) {
      if (queryCache?.project !== project() || queryCache.text !== filter.text || queryCache.revision !== store.revision) {
        queryCache = { project: project(), revision: store.revision, text: filter.text, compiled: compileNodeQuery(project(), filter.text) };
      }
      if (!queryCache.compiled.matches(n)) return false;
    }
    return true;
  }

  function edgeMarkup(edges, positions) {
    return edges
      .map((e, i) => {
        const fromPos = positions.get(e.from);
        const toPos = positions.get(e.to);
        const fromH = heightOf(nodeIndex.get(e.from));
        const toH = heightOf(nodeIndex.get(e.to));
        const d = edgePath(fromPos, toPos, fromH, toH);
        const involved = selectedId && (e.from === selectedId || e.to === selectedId);
        const dim = (selectedId && !involved) || e.broken;
        const cls = ['edge', `edge-${e.kind}`];
        if (involved) cls.push('hl');
        if (dim) cls.push('dim');
        if (e.broken) cls.push('broken');
        const marker = e.broken ? 'url(#sfArrowBroken)' : involved ? 'url(#sfArrowHl)' : 'url(#sfArrow)';
        const mid = bezierPoint(fromPos, toPos, 0.5, fromH, toH);
        const label = e.label ? shortLabel(e.label) : '';
        return `<path class="${cls.join(' ')}" data-edge="${i}" d="${d}" marker-end="${marker}" />
          ${label ? `<text class="edge-label${dim ? ' dim' : ''}" data-for="${i}" x="${mid.x.toFixed(1)}" y="${(mid.y - 5).toFixed(1)}">${esc(label)}</text>` : ''}`;
      })
      .join('');
  }

  function render() {
    renderedGeneration = store.generation;
    nodeIndex = new Map(nodes().map((n) => [n.id, n]));
    const all = nodes();
    const empty = document.getElementById('graphEmpty');
    const list = all.filter(matchesFilter);

    if (empty) {
      const filtered = all.length > 0 && list.length === 0;
      empty.classList.toggle('hidden', list.length > 0);
      empty.firstChild.textContent = filtered ? uiText("Узлы с такими фильтрами не найдены.", "No nodes match these filters.") : uiText("В проекте пока нет узлов.", "This project has no nodes yet.");
      empty.querySelector('#btnCreateFirst')?.classList.toggle('hidden', filtered);
      let reset = empty.querySelector('[data-reset-filter]');
      if (!reset) {
        reset = document.createElement('button');
        reset.className = 'btn btn-sm';
        reset.dataset.resetFilter = '';
        reset.textContent = uiText("Сбросить фильтры", "Reset filters");
        reset.onclick = () => setFilter({ chapterId: '', text: '', showNotes: true });
        empty.append(reset);
      }
      reset.classList.toggle('hidden', !filtered);
    }
    svg.classList.toggle('hidden', all.length === 0);

    if (!all.length) {
      svg.innerHTML = '';
      renderedIds = '';
      cardSig = new Map();
      cardPos = new Map();
      cardHeights = new Map();
      edgesSig = '';
      lastSignature = '';
      return;
    }

    selectedId = store.selection?.kind === 'node' ? store.selection.id : null;

    const positions = new Map();
    for (const n of list) positions.set(n.id, positionOf(n));

    const edges = collectEdges().filter((e) => positions.has(e.from) && positions.has(e.to));
    const edgeSvg = edgeMarkup(edges, positions);

    const nodesSvg = list.map((n) => renderNode(n, positions.get(n.id))).join('');

    svg.innerHTML = `<defs>
      ${Object.entries(TYPE_GLYPHS).map(([kind, glyph]) => `<symbol id="sfGlyph-${kind}" viewBox="0 0 16 16">${glyph}</symbol>`).join('')}
      <marker id="sfArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path class="marker-fill" d="M0,0 L10,5 L0,10 z" />
      </marker>
      <marker id="sfArrowHl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path class="marker-fill marker-fill-hl" d="M0,0 L10,5 L0,10 z" />
      </marker>
      <marker id="sfArrowBroken" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path class="marker-fill marker-fill-broken" d="M0,0 L10,5 L0,10 z" />
      </marker>
    </defs>
    <clipPath id="sfMediaClip">
      <rect x="${MEDIA_PAD}" y="${CARD_H + MEDIA_GAP}" width="${CARD_W - MEDIA_PAD * 2}" height="${MEDIA_BAND_HEIGHT}" rx="8" />
    </clipPath>
    <g id="sfViewport">
      <g class="edges">${edgeSvg}</g>
      <g class="nodes">${nodesSvg}</g>
    </g>`;

    indexElements(edges);
    lodFrame = null;
    applyTransform();
    rememberState(list, edges);
    updateLod();
  }

  // Точечная перерисовка: если состав узлов и фильтры не менялись, обновляем
  // только изменившиеся карточки (правка текста в SVG не вызывает лэйаут всего
  // документа, а полная пересборка svg.innerHTML стоит десятки миллисекунд).
  function patchGraph() {
    nodeIndex = new Map(nodes().map((n) => [n.id, n]));
    const all = nodes();
    const list = all.filter(matchesFilter);
    const ids = list.map((n) => n.id).join('\u0001');
    if (ids !== renderedIds || !svg.querySelector('.nodes')) {
      render();
      return;
    }

    const prevSelectedId = selectedId;
    selectedId = store.selection?.kind === 'node' ? store.selection.id : null;

    const positions = new Map();
    for (const n of list) positions.set(n.id, positionOf(n));

    let heightsChanged = false;
    const moved = [];

    for (const n of list) {
      const inner = nodeSig(n);
      const pos = positions.get(n.id);
      const height = heightOf(n);

      if (inner !== cardSig.get(n.id)) {
        const el = elIndex.get(n.id);
        if (!el) {
          render();
          return;
        }
        el.innerHTML = renderNodeInner(n);
        el.classList.toggle('selected', n.id === selectedId);
        el.classList.toggle('dim', !!selectedId && n.id !== selectedId);
        cardSig.set(n.id, inner);
        if (cardHeights.get(n.id) !== height) heightsChanged = true;
        cardHeights.set(n.id, height);
      }

      const psig = posSig(pos);
      if (psig !== cardPos.get(n.id)) {
        const el = elIndex.get(n.id);
        if (el) el.setAttribute('transform', `translate(${pos.x} ${pos.y})`);
        cardPos.set(n.id, psig);
        moved.push({ id: n.id, pos });
      }
    }

    const edges = collectEdges().filter((e) => positions.has(e.from) && positions.has(e.to));
    const esig = edgesSignature(edges);
    const edgesChanged = esig !== edgesSig;
    if (heightsChanged || edgesChanged) {
      const group = svg.querySelector('.edges');
      if (!group) {
        render();
        return;
      }
      group.innerHTML = edgeMarkup(edges, positions);
      edgeIndex = [];
      group.querySelectorAll('[data-edge]').forEach((el) => {
        const e = edges[Number(el.dataset.edge)];
        if (e) {
          const next = el.nextElementSibling;
          edgeIndex.push({ ...e, el, labelEl: next?.classList.contains('edge-label') ? next : null });
        }
      });
      edgesSig = esig;
    }

    if (moved.length) {
      const ids = new Set(moved.map(item => item.id));
      for (const e of edgeIndex) {
        if (ids.has(e.from) || ids.has(e.to)) placeEdge(e, positions.get(e.from), positions.get(e.to));
      }
    }
    if (selectedId !== prevSelectedId || edgesChanged || heightsChanged) updateSelectionClasses(true);
    if (heightsChanged || moved.length || edgesChanged) lodFrame = null;
    updateLod();
    lastSignature = buildSignature();
  }

  function rememberState(list, edges) {
    renderedIds = list.map((n) => n.id).join('\u0001');
    cardSig = new Map(list.map((n) => [n.id, nodeSig(n)]));
    cardPos = new Map(list.map((n) => [n.id, posSig(positionOf(n))]));
    cardHeights = new Map(list.map((n) => [n.id, heightOf(n)]));
    edgesSig = edgesSignature(edges);
    lastSignature = buildSignature();
  }


  function shortLabel(text) {
    const flat = String(text).replace(/\s+/g, ' ').trim();
    return flat.length > 22 ? `${flat.slice(0, 22)}…` : flat;
  }

  function renderNode(n, pos) {
    const selected = n.id === selectedId;
    const dim = selectedId && n.id !== selectedId ? ' dim' : '';
    return `<g class="node-card${selected ? ' selected' : ''}${dim}" data-id="${esc(n.id)}" transform="translate(${pos.x} ${pos.y})">${renderNodeInner(n)}</g>`;
  }

  function renderNodeInner(n) {
    const isStart = n.id === project().startNodeId;
    const notch = n.color || `var(--canvas-${n.type})`;
    const speaker = n.type === 'line' || n.type === 'scene' ? nodeSpeakerName(project(), n) : '';
    const title = [n.title, speaker !== n.title && speaker].filter(Boolean).join(' · ') || TYPE_LABELS[n.type];
    const text = n.text || (n.choices || []).map((c) => `• ${c.text}`).join('\n') || (n.branches || []).map((b) => (b.condition ? `? ${b.condition}` : uiText("? иначе", "? else"))).join('\n') || '';
    const lines = wrapText(text, 31, 3);
    const badge =
      n.type === 'choice'
        ? `${(n.choices || []).length} ${uiText("вар", "choices")}.`
        : n.type === 'condition'
          ? `${(n.branches || []).length} ${uiText("ветв", "branches")}.`
          : '';
    const brokenNext = n.next && !nodeIndex.has(n.next);
    const effects = (n.effects || []).length;
    const cardH = heightOf(n);
    const preview = nodePreviewId(n);
    const media = preview ? (project().media || {})[preview] : null;
    const photo = media && media.data
      ? `<rect class="node-media-band" x="${MEDIA_PAD}" y="${CARD_H + MEDIA_GAP}" width="${CARD_W - MEDIA_PAD * 2}" height="${cardH - CARD_H - MEDIA_GAP - MEDIA_PAD}" rx="8" />
      <image class="node-media" x="${MEDIA_PAD}" y="${CARD_H + MEDIA_GAP}" width="${CARD_W - MEDIA_PAD * 2}" height="${cardH - CARD_H - MEDIA_GAP - MEDIA_PAD}" preserveAspectRatio="xMidYMid slice" href="${esc(media.data)}" clip-path="url(#sfMediaClip)" />
      ${(n.media || []).length > 1 ? `<text class="node-media-count" x="${CARD_W - MEDIA_PAD - 6}" y="${cardH - MEDIA_PAD - 6}" text-anchor="end">+${(n.media || []).length - 1}</text>` : ''}`
      : '';

    return `<title>${esc(title)}</title><rect class="node-bg" width="${CARD_W}" height="${cardH}" rx="6" />
      ${photo}
      <rect class="node-notch" x="0" y="8" width="2.5" height="${cardH - 16}" fill="${esc(notch)}" />
      <use class="node-kind-icon" href="#sfGlyph-${esc(n.type)}" x="11" y="6" width="14" height="14" stroke="${esc(notch)}" />
      <text class="node-type" x="30" y="17">${esc(TYPE_LABELS[n.type] || n.type)}</text>
      ${isStart ? `<text class="node-start-label" text-anchor="end" x="${CARD_W - 23}" y="17">${uiText("Старт", "Start")}</text><circle class="node-start-ring" cx="${CARD_W - 13}" cy="13" r="5.5" /><circle class="node-start-dot" cx="${CARD_W - 13}" cy="13" r="2.5" />` : ''}
      <text class="node-speaker" x="12" y="34">${esc(shortLabel(title))}</text>
      ${lines
        .map((line, i) => `<text class="node-text" x="12" y="${50 + i * 13}">${esc(line)}</text>`)
        .join('')}
      ${effects ? `<text class="node-meta" x="12" y="${CARD_H - 5}">${effects} ${uiText("эфф", "FX")}.</text>` : ''}
      <text class="node-badge" x="${CARD_W - 26}" y="${CARD_H - 5}" text-anchor="end">${esc(badge)}</text>
      ${brokenNext ? `<circle class="node-broken" cx="${CARD_W - 13}" cy="34" r="3" />` : ''}
      <circle class="node-plus" cx="${CARD_W - 14}" cy="${cardH / 2}" r="7" data-plus="${esc(n.id)}" />
      <path class="node-plus-icon" d="M${CARD_W - 18},${cardH / 2} h8 M${CARD_W - 14},${cardH / 2 - 4} v8" />`;
  }


  function indexElements(edges) {
    elIndex = new Map();
    svg.querySelectorAll('.node-card').forEach((g) => elIndex.set(g.dataset.id, g));
    edgeIndex = [];
    svg.querySelectorAll('.edges [data-edge]').forEach((el) => {
      const e = edges[Number(el.dataset.edge)];
      if (e) {
          const next = el.nextElementSibling;
          edgeIndex.push({ ...e, el, labelEl: next?.classList.contains('edge-label') ? next : null });
        }
    });
  }

  function refresh(force = false) {
    // Во время перетаскивания DOM не пересобираем: иначе карточка, которую
    // держит курсор, окажется отсоединённой, а рёбра продолжат двигаться.
    if (dragState) {
      skippedRender = true;
      return;
    }
    if (renderedGeneration !== store.generation) {
      render();
      return;
    }
    const sig = buildSignature();
    if (!force && sig === lastSignature && svg.querySelector('.nodes')) return;
    if (force || !svg.querySelector('.nodes')) {
      render();
      return;
    }
    patchGraph();
  }

  function updateSelectionClasses(force = false) {
    const sel = store.selection?.kind === 'node' ? store.selection.id : null;
    if (sel === selectedId && !force) return;
    selectedId = sel;
    svg.querySelectorAll('.node-card').forEach((g) => {
      const isSel = g.dataset.id === selectedId;
      g.classList.toggle('selected', isSel);
      g.classList.toggle('dim', !!selectedId && !isSel);
    });
    svg.querySelectorAll('.edge').forEach((p) => {
      const idx = Number(p.dataset.edge);
      const e = edgeIndex[idx];
      if (!e) return;
      const involved = selectedId && (e.from === selectedId || e.to === selectedId);
      p.classList.toggle('hl', !!involved);
      const dim = !!selectedId && !involved || e.broken;
      p.classList.toggle('dim', dim);
      p.setAttribute('marker-end', e.broken ? 'url(#sfArrowBroken)' : involved ? 'url(#sfArrowHl)' : 'url(#sfArrow)');
      e.labelEl?.classList.toggle('dim', dim);
    });
  }

  // ---------------------------------------------------------------- зум / пан

  function setZoom(k, anchor) {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
    if (anchor) {
      const wx = (anchor.x - view.x) / view.k;
      const wy = (anchor.y - view.y) / view.k;
      view.k = next;
      view.x = anchor.x - wx * next;
      view.y = anchor.y - wy * next;
    } else {
      const rect = host.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const wx = (cx - view.x) / view.k;
      const wy = (cy - view.y) / view.k;
      view.k = next;
      view.x = cx - wx * next;
      view.y = cy - wy * next;
    }
    applyTransform();
  }

  function getZoom() {
    return view.k;
  }

  function fit() {
    const list = nodes().filter(matchesFilter);
    if (!list.length) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of list) {
      const p = positionOf(n);
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + CARD_W);
      maxY = Math.max(maxY, p.y + heightOf(n));
    }
    const rect = host.getBoundingClientRect();
    const pad = 60;
    const w = Math.max(1, maxX - minX + pad * 2);
    const h = Math.max(1, maxY - minY + pad * 2);
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(rect.width / w, rect.height / h, 1.4)));
    view.k = k;
    view.x = (rect.width - (maxX - minX) * k) / 2 - minX * k;
    view.y = (rect.height - (maxY - minY) * k) / 2 - minY * k;
    applyTransform();
  }

  function showStart() {
    const start = nodes().find(n => n.id === project().startNodeId) || nodes()[0];
    if (!start) return fit();
    const rect = host.getBoundingClientRect();
    const p = positionOf(start);
    view.k = 1;
    // Leave space on the right for the first continuation of the script.
    view.x = Math.max(24, Math.min(80, rect.width * 0.075)) - p.x;
    view.y = Math.round(rect.height * 0.43 - heightOf(start) / 2) - p.y;
    applyTransform();
  }

  function centerOn(id) {
    const n = nodeById(id);
    if (!n) return;
    const p = positionOf(n);
    const rect = host.getBoundingClientRect();
    view.k = Math.max(view.k, 0.8);
    view.x = rect.width / 2 - (p.x + CARD_W / 2) * view.k;
    view.y = rect.height / 2 - (p.y + heightOf(n) / 2) * view.k;
    applyTransform();
  }

  // ---------------------------------------------------------------- события

  function selectNode(id) {
    if (!id) return;
    store.setSelection({ kind: 'node', id });
    updateSelectionClasses();
  }

  function onWheel(e) {
    e.preventDefault();
    const rect = host.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * 0.0015);
    setZoom(view.k * factor, { x: e.clientX - rect.left, y: e.clientY - rect.top });
  }

  function onMouseDown(e) {
    if (e.button === 1) {
      e.preventDefault();
      beginPan(e);
      return;
    }
    if (e.button !== 0) return;

    const plus = e.target.closest?.('[data-plus]');
    if (plus) {
      e.stopPropagation();
      createAfter(plus.dataset.plus, 'line');
      return;
    }

    const card = e.target.closest?.('.node-card');
    if (card) {
      e.stopPropagation();
      beginNodeDrag(e, card.dataset.id);
      return;
    }
    beginPan(e);
  }

  function beginPan(e) {
    panState = { startX: e.clientX, startY: e.clientY, vx: view.x, vy: view.y, moved: false };
    host.classList.add('panning');
    svg.setPointerCapture?.(e.pointerId);
  }

  function beginNodeDrag(e, id) {
    const node = nodeById(id);
    if (!node) return;
    const pos = positionOf(node);
    const start = clientToWorld(e.clientX, e.clientY);
    dragState = {
      id,
      offsetX: start.x - pos.x,
      offsetY: start.y - pos.y,
      startX: pos.x,
      startY: pos.y,
      moved: false,
      el: elIndex.get(id),
    };
    selectNode(id);
    host.classList.add('dragging');
  }

  function onPointerMove(e) {
    if (panState) {
      const dx = e.clientX - panState.startX;
      const dy = e.clientY - panState.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) panState.moved = true;
      view.x = panState.vx + dx;
      view.y = panState.vy + dy;
      applyTransform();
      return;
    }
    if (dragState) {
      const world = clientToWorld(e.clientX, e.clientY);
      const nx = Math.round(world.x - dragState.offsetX);
      const ny = Math.round(world.y - dragState.offsetY);
      if (Math.abs(nx - dragState.startX) + Math.abs(ny - dragState.startY) > 1) dragState.moved = true;
      dragState.nextX = nx;
      dragState.nextY = ny;
      // элемент мог быть перерисован — берём актуальный из индекса
      const el = elIndex.get(dragState.id) || dragState.el;
      dragState.el = el;
      if (el) el.setAttribute('transform', `translate(${nx} ${ny})`);
      updateEdgesFor(dragState.id, { x: nx, y: ny });
    }
  }

  function onPointerUp(e) {
    if (panState) {
      host.classList.remove('panning');
      const wasPan = panState.moved;
      panState = null;
      if (!wasPan) {
        // клик по пустому месту — снять выделение
        store.setSelection({ kind: 'node', id: null });
        updateSelectionClasses();
      }
      return;
    }
    if (dragState) {
      const { id, moved, nextX, nextY, startX, startY } = dragState;
      host.classList.remove('dragging');
      dragState = null;
      if (moved && Number.isFinite(nextX)) {
        const node = nodeById(id);
        if (node) {
          const res = store.apply([{ op: 'setPositions', positions: { [id]: { x: nextX, y: nextY } } }], { label: uiText("Перемещение узла", "Move node") });
          if (res && res.ok === false) {
            const el = elIndex.get(id);
            if (el) el.setAttribute('transform', `translate(${startX} ${startY})`);
            ui.toast(res.error || uiText("Не удалось переместить узел", "Could not move node"), 'bad');
            refresh(true);
          }
        }
      }
      if (skippedRender) {
        skippedRender = false;
        refresh(true);
      }
    }
  }

  function updateEdgesFor(id, pos) {
    for (const e of edgeIndex) {
      if (e.from !== id && e.to !== id) continue;
      const fromNode = nodeById(e.from);
      const toNode = nodeById(e.to);
      if (!fromNode || !toNode) continue;
      const fromPos = e.from === id ? pos : positionOf(fromNode);
      const toPos = e.to === id ? pos : positionOf(toNode);
      placeEdge(e, fromPos, toPos);
    }
  }

  function placeEdge(e, fromPos, toPos) {
    const fromH = heightOf(nodeById(e.from));
    const toH = heightOf(nodeById(e.to));
    e.el.setAttribute('d', edgePath(fromPos, toPos, fromH, toH));
    const label = e.labelEl;
    if (label) {
      const mid = bezierPoint(fromPos, toPos, 0.5, fromH, toH);
      label.setAttribute('x', mid.x.toFixed(1));
      label.setAttribute('y', (mid.y - 5).toFixed(1));
    }
  }

  // Перетаскивание файлов из проводника прямо на карточку — прикрепить фото.
  function onDragOver(e) {
    if (!e.dataTransfer) return;
    const types = Array.from(e.dataTransfer.types || []);
    if (!types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const card = e.target.closest?.('.node-card');
    svg.querySelectorAll('.node-card.drop-target').forEach((el) => {
      if (el !== card) el.classList.remove('drop-target');
    });
    if (card) card.classList.add('drop-target');
  }

  function onDragLeave(e) {
    const card = e.target.closest?.('.node-card');
    if (card) card.classList.remove('drop-target');
  }

  function onDrop(e) {
    if (!e.dataTransfer) return;
    const card = e.target.closest?.('.node-card');
    svg.querySelectorAll('.node-card.drop-target').forEach((el) => el.classList.remove('drop-target'));
    const files = Array.from(e.dataTransfer.files || []).filter((file) => String(file.type || '').startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    if (!card) {
      ui.toast(uiText("Бросьте изображение на карточку узла", "Drop an image on a node card"), 'warn');
      return;
    }
    ui.attachImages?.(card.dataset.id, files);
  }

  function onDoubleClick(e) {
    const card = e.target.closest?.('.node-card');
    if (card) {
      if (ui.workbench) ui.workbench.openNode(card.dataset.id);
      else ui.inspector?.focusNode(card.dataset.id);
      return;
    }
    if (e.target.closest?.('.edge, .edge-label')) return;
    const world = clientToWorld(e.clientX, e.clientY);
    const body = document.createElement('div');
    body.className = 'sf-insert-options';
    const dialog = ui.modal({ title: uiText("Создать узел здесь", "Create node here"), body, buttons: [{ label: uiText("Отмена", "Cancel") }] });
    for (const type of NODE_TYPES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = TYPE_LABELS[type];
      btn.onclick = () => { dialog.close(); addNodeAt(type, world); };
      body.append(btn);
    }
    body.firstElementChild?.focus();
  }

  function onContextMenu(e) {
    e.preventDefault();
    const card = e.target.closest?.('.node-card');
    const menu = document.getElementById('contextMenu');
    if (!menu) return;
    const items = card ? nodeMenuItems(card.dataset.id) : canvasMenuItems();
    menu.innerHTML = items
      .map((it) =>
        it.sep
          ? '<div class="dd-sep"></div>'
          : `<button class="dd-item" type="button" data-cm="${it.action}"${it.danger ? ' data-danger="1"' : ''}>${esc(it.label)}${it.key ? `<span class="dd-key">${esc(it.key)}</span>` : ''}</button>`,
      )
      .join('');
    menu.classList.remove('hidden');
    const rect = host.getBoundingClientRect();
    const x = Math.min(e.clientX, rect.right - 220);
    const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 20);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.querySelectorAll('[data-cm]').forEach((btn) => {
      btn.addEventListener('click', () => {
        menu.classList.add('hidden');
        runMenuAction(btn.dataset.cm, card?.dataset.id);
      });
    });
  }

  function nodeMenuItems(id) {
    const node = nodeById(id);
    if (!node) return canvasMenuItems();
    const isStart = project().startNodeId === id;
    return [
      { action: 'open', label: uiText("Открыть в инспекторе", "Open in inspector"), key: 'Enter' },
      { action: 'new-line', label: uiText("Вставить реплику на переход", "Insert a line on this transition") },
      { action: 'play', label: uiText("Пройти ветку отсюда", "Play from here") },
      { action: 'neighbors', label: uiText("Связи вокруг узла", "Local graph") },
      { action: 'new-choice', label: uiText("Новое ветвление после", "Add a branch after this node") },
      { sep: true },
      { action: 'dup', label: uiText("Дублировать", "Duplicate"), key: 'Ctrl+D' },
      { action: 'media', label: uiText("Изображения…", "Images…") },
      { action: isStart ? 'unset-start' : 'set-start', label: isStart ? uiText("Снять стартовый статус", "Unset as start") : uiText("Сделать стартовым", "Set as start") },
      { action: 'center', label: uiText("Центрировать на экране", "Center in view") },
      { sep: true },
      { action: 'del', label: uiText("Удалить узел", "Delete node"), key: 'Del', danger: true },
    ];
  }

  function canvasMenuItems() {
    return [
      { action: 'add-line', label: uiText("Добавить реплику", "Add line") },
      { action: 'add-choice', label: uiText("Добавить ветвление", "Add branch") },
      { action: 'add-scene', label: uiText("Добавить сцену", "Add scene") },
      { action: 'add-note', label: uiText("Добавить заметку", "Add note") },
      { sep: true },
      { action: 'layout', label: uiText("Автораскладка", "Auto layout"), key: 'Ctrl+G' },
      { action: 'fit', label: uiText("Показать всё", "Show all") },
      { action: 'reset-zoom', label: uiText("Масштаб 100%", "Zoom 100%") },
    ];
  }

  function runMenuAction(action, id) {
    const node = id ? nodeById(id) : null;
    switch (action) {
      case 'open':
        ui.selectNode(id);
        ui.inspector?.focusNode(id);
        break;
      case 'media':
        if (id) ui.pickMediaForNode?.(id);
        break;
      case 'play': ui.playBranch(id); break;
      case 'neighbors': ui.visualizer?.openNeighborhood(id); break;
      case 'new-line':
        createAfter(id, 'line');
        break;
      case 'new-choice':
        createAfter(id, 'choice');
        break;
      case 'dup': {
        if (!node) break;
        const copy = structuredClone(node);
        delete copy.id;
        const res = store.apply([{ op: 'createNode', node: copy }], { label: uiText("Дублировать узел", "Duplicate node") });
        const newId = res?.created?.[0];
        if (newId) ui.selectNode(newId);
        break;
      }
      case 'set-start':
        store.apply([{ op: 'setStart', id }], { label: uiText("Стартовый узел", "Start node") });
        break;
      case 'unset-start': {
        const other = nodes().find((n) => n.id !== id && n.type !== 'note');
        if (!other) {
          ui.toast(uiText("В проекте нет другого узла — снять статус стартового нельзя", "This is the only node; it must remain the start node"), 'warn');
          break;
        }
        const res = store.apply([{ op: 'setStart', id: other.id }], { label: uiText("Стартовый узел", "Start node") });
        if (res && res.ok === false) ui.toast(res.error || uiText("Не удалось сменить стартовый узел", "Could not change start node"), 'bad');
        break;
      }
      case 'center':
        centerOn(id);
        break;
      case 'del':
        deleteNode(id);
        break;
      case 'add-line':
        addNodeAt('line');
        break;
      case 'add-choice':
        addNodeAt('choice');
        break;
      case 'add-scene':
        addNodeAt('scene');
        break;
      case 'add-note':
        addNodeAt('note');
        break;
      case 'layout':
        autoLayout();
        break;
      case 'fit':
        fit();
        break;
      case 'reset-zoom':
        setZoom(1);
        break;
      default:
        break;
    }
  }

  function addNodeAt(type, point) {
    const rect = host.getBoundingClientRect();
    const world = point || clientToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const node = { type, chapterId: filter.chapterId || '', position: { x: Math.round(world.x - CARD_W / 2), y: Math.round(world.y - CARD_H / 2) } };
    const res = store.apply([{ op: 'createNode', node }], { label: uiText("Новый узел", "New node") });
    const id = res?.created?.[0];
    if (id) {
      ui.selectNode(id);
      ui.inspector?.focusNode(id);
    }
  }

  function createAfter(fromId, type) {
    return ui.insertLine(fromId, undefined, type);
  }

  async function deleteNode(id) {
    const node = nodeById(id);
    if (!node) return;
    const hasNext = !!node.next;
    const buttons = [{ label: uiText("Отмена", "Cancel") }];
    if (hasNext) {
      buttons.push({
        label: uiText("Удалить и перенаправить", "Delete and redirect links"),
        kind: 'primary',
        onClick: (api) => {
          api.close();
          store.apply([{ op: 'deleteNode', id, reconnectTo: node.next }], { label: uiText("Удалить узел", "Delete node") });
        },
      });
    }
    buttons.push({
      label: uiText("Удалить", "Delete"),
      kind: 'danger',
      onClick: (api) => {
        api.close();
        store.apply([{ op: 'deleteNode', id }], { label: uiText("Удалить узел", "Delete node") });
      },
    });
    ui.modal({
      title: uiText("Удалить узел?", "Delete node?"),
      body: `<p style="margin:0">${uiText("Узел", "Node")} <code>${esc(id)}</code> ${uiText("будет удалён", "will be deleted")}.</p>
        <p class="hint-text">${hasNext ? uiText("Можно перенаправить входящие связи на следующий узел.", "Incoming links can be redirected to the next node.") : uiText("Входящие связи станут оборванными.", "Incoming links will be broken.")}</p>`,
      buttons,
    });
  }

  function autoLayout() {
    try {
      const { positions } = computeLayout(project());
      if (!positions || !Object.keys(positions).length) {
        ui.toast(uiText("Нечего раскладывать", "Nothing to arrange"), 'warn');
        return;
      }
      if (store.beginGroup) store.beginGroup(uiText("Автораскладка", "Auto layout"));
      store.apply([{ op: 'setPositions', positions }], { label: uiText("Автораскладка", "Auto layout") });
      if (store.endGroup) store.endGroup();
      refresh(true);
      fit();
      ui.toast(uiText("Граф разложен", "Graph arranged"), 'good');
    } catch (e) {
      ui.toast(`${uiText("Автораскладка не удалась", "Auto layout failed")}: ${e.message || e}`, 'bad');
    }
  }

  function setFilter(next) {
    filter = { ...filter, ...(next || {}) };
    document.getElementById('filterChapter').value = filter.chapterId || '';
    document.getElementById('filterText').value = filter.text || '';
    document.getElementById('filterNotes').checked = !!filter.showNotes;
    render();
  }

  // ---------------------------------------------------------------- инициализация

  function zoomFromControls(event) {
    const button = event.target.closest('[data-canvas-zoom]');
    if (button) setZoom(view.k * (button.dataset.canvasZoom === 'in' ? 1.25 : 0.8));
  }

  function wireEvents() {
    if (wired) return;
    wired = true;
    host.addEventListener('click', zoomFromControls);
    svg.addEventListener('wheel', onWheel, { passive: false });
    svg.addEventListener('pointerdown', onMouseDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    svg.addEventListener('dblclick', onDoubleClick);
    svg.addEventListener('contextmenu', onContextMenu);
    svg.addEventListener('dragover', onDragOver);
    svg.addEventListener('dragleave', onDragLeave);
    svg.addEventListener('drop', onDrop);

    const chapterFilter = document.getElementById('filterChapter');
    const textFilter = document.getElementById('filterText');
    const notesFilter = document.getElementById('filterNotes');

    if (chapterFilter) {
      const rebuild = () => {
        const p = project();
        const current = chapterFilter.value;
        chapterFilter.innerHTML =
          `<option value="">${uiText("Все главы", "All chapters")}</option>` +
          (p.chapters || []).map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
        chapterFilter.value = (p.chapters || []).some((c) => c.id === current) ? current : '';
      };
      rebuild();
      chapterFilter.addEventListener('change', () => setFilter({ chapterId: chapterFilter.value }));
      chapterFilter.addEventListener('focus', rebuild);
    }
    if (textFilter) {
      textFilter.addEventListener(
        'input',
        ui.debounce(() => setFilter({ text: textFilter.value.trim() }), 180),
      );
    }
    if (notesFilter) {
      notesFilter.checked = filter.showNotes;
      notesFilter.addEventListener('change', () => setFilter({ showNotes: notesFilter.checked }));
    }
  }

  wireEvents();

  return {
    render,
    refresh,
    fit,
    centerOn,
    showStart,
    autoLayout,
    setFilter,
    setZoom,
    getZoom,
    getView: () => ({ ...view, filter: { ...filter } }),
    setView(saved) {
      if (!saved) return;
      const { x, y, k } = saved;
      if (![x, y, k].every(Number.isFinite)) return;
      Object.assign(view, { x, y, k: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, k)) });
      if (saved.filter) setFilter(saved.filter);
      else applyTransform();
    },
    getSelectedId: () => (store.selection?.kind === 'node' ? store.selection.id : null),
    destroy() {
      sizeWatcher.disconnect();
      host.removeEventListener('click', zoomFromControls);
      svg.removeEventListener('wheel', onWheel);
      svg.removeEventListener('pointerdown', onMouseDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      svg.removeEventListener('dblclick', onDoubleClick);
      svg.removeEventListener('contextmenu', onContextMenu);
      svg.removeEventListener('dragover', onDragOver);
      svg.removeEventListener('dragleave', onDragLeave);
      svg.removeEventListener('drop', onDrop);
      wired = false;
    },
  };
}