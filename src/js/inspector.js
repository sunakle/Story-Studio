import { t as uiText, getLanguage } from './i18n.js';
// StoryForge — правая панель «Инспектор»: карточка узла (7 типов), карточки
// персонажа/локации/переменной/главы, эффекты, связи, метаданные.
import {
  TYPE_LABELS,
  OP_LABELS,
  countWords,
  plural,
  nodeSpeakerName,
  nodeLocationName,
  incomingEdges,
  parseCondition,
  uid,
} from './model.js';
import { icon } from './icons.js';
import { formatBytes } from './media.js';

const COLORS = ['#7c9cff', '#f2a65a', '#6fcf97', '#eb5757', '#bb87f4', '#56ccf2', '#f2c94c', '#9aa6b6'];

const NODE_ICONS = {
  line: '<path d="M4 6h16M4 11h16M4 16h10"/>',
  choice: '<path d="M6 4v7a4 4 0 0 0 4 4h8"/><path d="m15 12 3 3-3 3"/>',
  condition: '<path d="M3 12h5l3-6 3 12 3-6h4"/>',
  jump: '<path d="M5 12h12"/><path d="m13 8 4 4-4 4"/>',
  scene: '<path d="M3 6h18v12H3z"/><path d="m3 16 5-4 4 3 3-2 6 5"/>',
  end: '<path d="M6 6h12v12H6z"/>',
  note: '<path d="M5 4h9l5 5v11H5z"/><path d="M14 4v5h5"/>',
};

const emptyHint = (text) => `<div class="empty">${text}</div>`;

export function createInspector({ root, store, ui }) {
  const esc = (s) => ui.escapeHTML(s);
  let lastKey = '';
  let pendingFocus = null;

  // ------------------------------------------------------------ утилиты

  const project = () => store.project;

  function nodeById(id) {
    return (project().nodes || []).find((n) => n.id === id) || null;
  }

  function charById(id) {
    return (project().characters || []).find((c) => c.id === id) || null;
  }

  function locById(id) {
    return (project().locations || []).find((l) => l.id === id) || null;
  }

  function varById(id) {
    return (project().variables || []).find((v) => v.id === id) || null;
  }

  /**
   * Применить правку. refresh=false — «тихий» режим: состав панели не меняется
   * (правка внутри поля, значение в списке), поэтому пересобирать её не нужно.
   * Это важно для скорости: полная пересборка панели на каждый символ стоит
   * сотню миллисекунд и вдобавок заставляет браузер перекладывать SVG-граф.
   * Структурные действия — добавить/удалить/переставить элемент, сменить тип
   * узла — наоборот требуют перерисовки, иначе обработчики бьют по устаревшим
   * спискам и теряют элементы.
   */
  function apply(ops, label, { refresh = true } = {}) {
    const res = store.apply(ops, { label });
    if (res && res.ok === false) {
      ui.toast(res.error || uiText("Не удалось применить изменение", "Could not apply change"), 'bad');
      return res;
    }
    if (!refresh) return res;
    setTimeout(() => {
      try {
        render();
      } catch (err) {
        window.__sfRenderErrors = window.__sfRenderErrors || [];
        window.__sfRenderErrors.push(`inspector: ${(err && err.message) || err}`);
      }
    }, 0);
    return res;
  }

  /** Поле формы: label + control + необязательные подсказки. */
  function field(label, controlHtml, { hint = '', counter = '', id = '' } = {}) {
    return `<label class="field"${id ? ` id="${id}"` : ''}>
      <span class="field-label">${esc(label)}${counter ? `<span class="counter">${counter}</span>` : ''}</span>
      ${controlHtml}
      ${hint ? `<span class="hint-text">${esc(hint)}</span>` : ''}
    </label>`;
  }

  function optionsForNodes(exceptId, selectedId) {
    const chapters = project().chapters || [];
    const nodes = project().nodes || [];
    const groups = new Map();
    for (const n of nodes) {
      if (!n.id || n.id === exceptId) continue;
      const chId = n.chapterId || '';
      if (!groups.has(chId)) groups.set(chId, []);
      groups.get(chId).push(n);
    }
    let html = `<option value="">— ${uiText("нет", "none")} —</option>`;
    for (const [chId, list] of groups) {
      const ch = chapters.find((c) => c.id === chId);
      const label = ch ? ch.name : uiText("Без главы", "Unassigned");
      html += `<optgroup label="${esc(label)}">`;
      for (const n of list) {
        const title = n.title || n.text || n.id;
        const short = String(title).replace(/\s+/g, ' ').slice(0, 48);
        html += `<option value="${esc(n.id)}"${n.id === selectedId ? ' selected' : ''}>${esc(TYPE_LABELS[n.type] || n.type)} · ${esc(short)}</option>`;
      }
      html += '</optgroup>';
    }
    return html;
  }

  function optionsForChoices(list, selected) {
    return (
      `<option value="">— ${uiText("нет", "none")} —</option>` +
      list.map((c) => `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(c.name)}</option>`).join('')
    );
  }

  function colorSwatches(current, onPick) {
    const html = `<div class="swatches">
      <button class="swatch swatch-default${!current ? ' active' : ''}" type="button" data-color="" title="${uiText("По умолчанию", "Default")}"></button>
      ${COLORS.map((c) => `<button class="swatch${current === c ? ' active' : ''}" type="button" data-color="${c}" style="--sw:${c}" title="${c}"></button>`).join('')}
    </div>`;
    return html;
  }

  function tagsEditor(tags, focusKey) {
    const list = Array.isArray(tags) ? tags : [];
    return `<div class="chips insp-chips" data-role="tags">
      ${list.map((t, i) => `<span class="chip">${esc(t)}<button class="chip-remove" type="button" data-tag-index="${i}" aria-label="${uiText("Удалить", "Delete")}">×</button></span>`).join('')}
      <input class="input input-sm insp-tag-input" data-focus="${focusKey}-tag" placeholder="+ ${uiText("тег и", "tag and")} Enter" />
    </div>`;
  }

  // ------------------------------------------------------------ сохранение фокуса

  function captureFocus() {
    const active = document.activeElement;
    if (!active || !root.contains(active)) return null;
    const key = active.getAttribute('data-focus');
    if (!key) return null;
    const snap = { key, start: null, end: null };
    try {
      if (typeof active.selectionStart === 'number') {
        snap.start = active.selectionStart;
        snap.end = active.selectionEnd;
      }
    } catch {
      /* у select/checkbox нет выделения */
    }
    return snap;
  }

  function restoreFocus(snap) {
    const target = snap
      ? root.querySelector(`[data-focus="${CSS.escape(snap.key)}"]`)
      : pendingFocus
        ? root.querySelector(`[data-focus="${CSS.escape(pendingFocus)}"]`)
        : null;
    pendingFocus = null;
    if (!target) return;
    target.focus();
    try {
      if (snap && snap.start !== null && typeof target.setSelectionRange === 'function') {
        target.setSelectionRange(snap.start, snap.end);
      }
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------ блоки

  function nodeHeader(node) {
    const isStart = project().startNodeId === node.id;
    return `<div class="insp-head">
      <span class="insp-type insp-type-${esc(node.type)}">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${NODE_ICONS[node.type] || NODE_ICONS.line}</svg>
        ${esc(TYPE_LABELS[node.type] || node.type)}
      </span>
      <code class="insp-id" title="${uiText("Идентификатор узла", "Node ID")}">${esc(node.id)}</code>
      ${isStart ? uiText("<span class=\"insp-start\">СТАРТ</span>", "<span class=\"insp-start\">START</span>") : ''}
      <div class="grow"></div>
      ${
        node.type === 'line' && String(node.text || '').trim()
          ? `<button class="btn btn-icon" type="button" data-act="voice-play" title="${uiText("Прослушать реплику", "Preview line")}">${icon('spark', 14)}</button>`
          : ''
      }
      <button class="btn btn-icon" type="button" data-act="dup" title="${uiText("Дублировать", "Duplicate")} (Ctrl+D)">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a1 1 0 0 1 1-1h9"/></svg>
      </button>
      <button class="btn btn-icon insp-danger" type="button" data-act="del" title="${uiText("Удалить", "Delete")} (Delete)">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>
      </button>
    </div>`;
  }

  function effectsBlock(node) {
    const vars = project().variables || [];
    const effects = Array.isArray(node.effects) ? node.effects : [];
    const varOptions = (selected) =>
      `<option value="">— ${uiText("переменная", "variable")} —</option>` +
      vars.map((v) => `<option value="${esc(v.id)}"${v.id === selected ? ' selected' : ''}>${esc(v.name)}</option>`).join('');

    const rows = effects
      .map((e, i) => {
        const v = varById(e.varId);
        const isToggle = e.op === 'toggle';
        return `<div class="insp-effect" data-effect-index="${i}">
          <select class="select select-sm" data-effect-var="${i}">${varOptions(e.varId)}</select>
          <select class="select select-sm" data-effect-op="${i}">
            ${Object.entries(OP_LABELS)
              .map(([op, label]) => `<option value="${esc(op)}"${op === e.op ? ' selected' : ''}>${esc(label)}</option>`)
              .join('')}
          </select>
          <input class="input input-sm" data-effect-value="${i}" type="text" value="${esc(e.value)}" ${isToggle ? 'disabled placeholder="—"' : uiText("placeholder=\"значение\"", "placeholder=\"value\"")} />
          <button class="btn btn-icon insp-danger" type="button" data-effect-del="${i}" title="${uiText("Удалить эффект", "Delete effect")}">×</button>
          ${v ? '' : uiText("<span class=\"hint-error insp-effect-bad\" title=\"Переменная не найдена\">", "<span class=\"hint-error insp-effect-bad\" title=\"Variable not found\">") + icon('alert', 12) + '</span>'}
        </div>`;
      })
      .join('');

    return `<section class="insp-section">
      <div class="insp-section-head">
        <span class="insp-section-title">${uiText("Эффекты", "Effects")}</span>
        <div class="grow"></div>
        <button class="btn btn-sm btn-ghost" type="button" data-act="effect-add">+ ${uiText("эффект", "effect")}</button>
      </div>
      <div class="insp-effects">${rows || uiText("<div class=\"hint-text\">Нет эффектов: переменные не меняются.</div>", "<div class=\"hint-text\">No effects. Variables stay unchanged.</div>")}</div>
    </section>`;
  }

  function mediaBlock(node) {
    const p = project();
    const library = p.media || {};
    const ids = (Array.isArray(node.media) ? node.media : []).filter((id) => library[id]);
    const preview = ids.includes(node.previewId) ? node.previewId : (ids[0] || '');

    const thumbs = ids
      .map((id) => {
        const m = library[id];
        return `<figure class="insp-media${id === preview ? ' is-preview' : ''}" data-media="${esc(id)}">
          <button class="insp-media-open" type="button" data-media-open="${esc(id)}" title="${uiText("Открыть изображение", "Open image")}">
            <img src="${esc(m.data)}" alt="${esc(m.name)}" loading="lazy" />
          </button>
          <figcaption class="insp-media-cap">
            <span class="insp-media-name" title="${esc(m.name)}">${esc(m.name)}</span>
            <span class="insp-media-size">${esc(formatBytes(m.size))}</span>
          </figcaption>
          <div class="insp-media-bar">
            <button class="btn btn-icon${id === preview ? ' is-on' : ''}" type="button" data-media-preview="${esc(id)}" title="${id === preview ? uiText("Уже превью карточки", "Current card preview") : uiText("Сделать превью карточки", "Use as card preview")}">${icon('target', 13)}</button>
            <button class="btn btn-icon insp-danger" type="button" data-media-del="${esc(id)}" title="${uiText("Убрать из узла", "Detach from node")}">${icon('close', 13)}</button>
          </div>
        </figure>`;
      })
      .join('');

    const hint = ids.length
      ? uiText("Превью (мишень) показывается на карточке в графе. Файл можно перетащить на карточку или вставить Ctrl+V.", "The selected preview appears on the graph card. Drag a file onto the card or paste with Ctrl+V.")
      : uiText("Перетащите файл сюда — картинка станет превью карточки в графе.", "Drop a file here to use it as the card preview.");

    return `<section class="insp-section insp-media-section" data-media-zone>
      <div class="insp-section-head">
        <span class="insp-section-title">${uiText("Изображения", "Images")}${ids.length ? ` · ${ids.length}` : ''}</span>
        <div class="grow"></div>
        <button class="btn btn-sm btn-ghost" type="button" data-act="media-add">${icon('plus', 12)} ${uiText("фото", "image")}</button>
      </div>
      ${ids.length ? `<div class="insp-media-grid">${thumbs}</div>` : ''}
      <div class="hint-text insp-media-hint">${esc(hint)}</div>
    </section>`;
  }

  function connectionsBlock(node) {
    const incoming = incomingEdges(project(), node.id);
    const incomingHtml = incoming.length
      ? `<div class="list insp-incoming">${incoming
          .map((e) => {
            const from = nodeById(e.from);
            if (!from) return '';
            const what =
              e.kind === 'choice'
                ? `${uiText("вариант", "choice")} «${esc((from.choices || []).find((c) => c.id === e.choiceId)?.text || '…')}»`
                : e.kind === 'branch'
                  ? `${uiText("ветка", "branch")} ${Number(e.branchIndex) + 1}`
                  : e.kind === 'else'
                    ? uiText("иначе", "else")
                    : uiText("следующий", "next");
            return `<button class="list-item" type="button" data-goto="${esc(from.id)}">
              <span class="count-pill">${esc(TYPE_LABELS[from.type] || from.type)}</span>
              <span class="li-main"><span class="li-title">${esc(from.title || from.text || from.id)}</span>
              <span class="li-sub">${what}</span></span>
            </button>`;
          })
          .join('')}</div>`
      : uiText("<div class=\"hint-text\">Сюда никто не ведёт.</div>", "<div class=\"hint-text\">No incoming links.</div>");

    return `<section class="insp-section">
      <div class="insp-section-head"><span class="insp-section-title">${uiText("Связи", "Links")}</span></div>
      ${field(
        uiText("Следующий", "Next"),
        `<div class="field-row">
          <select class="select select-sm" data-focus="next" data-bind="next" style="flex:1 1 auto">${optionsForNodes(node.id, node.next || '')}</select>
          <button class="btn btn-sm" type="button" data-act="new-next" title="${uiText("Вставить реплику в продолжение", "Insert a line after this node")}">+</button>
        </div>`,
      )}
      <div class="insp-sub-title">${uiText("Входящие", "Incoming")}</div>
      ${incomingHtml}
    </section>`;
  }

  function metaBlock(node) {
    return `<section class="insp-section">
      <div class="insp-section-head"><span class="insp-section-title">${uiText("Метаданные", "Metadata")}</span></div>
      ${field(uiText("Теги", "Tags"), tagsEditor(node.tags, 'tags'))}
      ${field(uiText("Заметки", "Notes"), `<textarea class="textarea" rows="2" data-focus="notes" data-bind="notes">${esc(node.notes || '')}</textarea>`)}
      <span class="field-label">${uiText("Цвет карточки", "Card color")}</span>
      ${colorSwatches(node.color || '', 'node-color')}
    </section>`;
  }

  // ------------------------------------------------------------ узел

  function renderNode(node) {
    const p = project();
    const chapters = p.chapters || [];
    const chars = p.characters || [];
    const locs = p.locations || [];
    const emotions = [...new Set((p.nodes || []).map((n) => n.emotion).filter(Boolean))].sort((a, b) => a.localeCompare(b, getLanguage()));

    const html = [
      nodeHeader(node),
      `<section class="insp-section">
        ${field(
          uiText("Тип", "Type"),
          `<select class="select" data-focus="type" data-bind="type">${Object.entries(TYPE_LABELS)
            .map(([t, l]) => `<option value="${t}"${t === node.type ? ' selected' : ''}>${esc(l)}</option>`)
            .join('')}</select>`,
        )}
        ${field(
          uiText("Глава", "Chapter"),
          `<select class="select select-sm" data-focus="chapter" data-bind="chapterId">
            <option value="">${uiText("Без главы", "Unassigned")}</option>
            ${chapters.map((c) => `<option value="${esc(c.id)}"${c.id === node.chapterId ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select>`,
        )}
        ${field(uiText("Название для дерева", "Title in explorer"), `<input class="input" data-focus="title" data-bind="title" value="${esc(node.title || '')}" placeholder="${uiText("необязательно", "optional")}" />`)}
      </section>`,
    ];

    if (node.type === 'line') {
      const words = countWords(node.text);
      html.push(`<section class="insp-section">
        ${field(
          uiText("Спикер", "Speaker"),
          `<div class="field-row">
            <select class="select" data-focus="speakerId" data-bind="speakerId" style="flex:1 1 auto">
              <option value="">— ${uiText("рассказчик", "narrator")} —</option>
              ${chars
                .map(
                  (c) =>
                    `<option value="${esc(c.id)}"${c.id === node.speakerId ? ' selected' : ''}>${esc(c.name)}${c.role ? ` — ${esc(c.role)}` : ''}</option>`,
                )
                .join('')}
            </select>
            <button class="btn btn-sm" type="button" data-act="new-char" title="${uiText("Новый персонаж", "New character")}">+</button>
          </div>`,
        )}
        ${field(
          uiText("Эмоция", "Emotion"),
          `<input class="input" list="inspEmotions" data-focus="emotion" data-bind="emotion" value="${esc(node.emotion || '')}" placeholder="${uiText("настороженно", "wary")}" />
           <datalist id="inspEmotions">${emotions.map((e) => `<option value="${esc(e)}"></option>`).join('')}</datalist>`,
        )}
        ${field(
          uiText("Локация", "Location"),
          `<select class="select" data-focus="locationId" data-bind="locationId">
            <option value="">— ${uiText("не указана", "unspecified")} —</option>
            ${locs.map((l) => `<option value="${esc(l.id)}"${l.id === node.locationId ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}
          </select>`,
        )}
        ${field(uiText("Текст", "Text"), `<textarea class="textarea" rows="5" data-focus="text" data-autosize data-bind="text">${esc(node.text || '')}</textarea>`, {
          counter: `${words} ${plural(words, [uiText("слово", "word"), uiText("слова", "words"), uiText("слов", "words")])}`,
        })}
      </section>`);
    }

    if (node.type === 'choice') {
      const choices = Array.isArray(node.choices) ? node.choices : [];
      const cards = choices
        .map((c, i) => {
          const cond = parseCondition(c.condition);
          return `<div class="insp-choice" data-choice-index="${i}">
            <div class="insp-choice-head">
              <span class="insp-choice-num">${uiText("Вариант", "Choice")} ${i + 1}</span>
              <div class="grow"></div>
              <button class="btn btn-icon" type="button" data-choice-up="${i}" title="${uiText("Выше", "Move up")}" ${i === 0 ? 'disabled' : ''}>${icon('up', 14)}</button>
              <button class="btn btn-icon" type="button" data-choice-down="${i}" title="${uiText("Ниже", "Move down")}" ${i === choices.length - 1 ? 'disabled' : ''}>${icon('down', 14)}</button>
              <button class="btn btn-icon insp-danger" type="button" data-choice-del="${i}" title="${uiText("Удалить вариант", "Delete choice")}">×</button>
            </div>
            <input class="input input-sm" data-choice-text="${i}" data-focus="choice-${i}-text" value="${esc(c.text)}" placeholder="${uiText("Текст варианта", "Choice text")}" />
            <div class="field-row insp-choice-row">
              <select class="select select-sm" data-choice-next="${i}" style="flex:1 1 auto">${optionsForNodes(node.id, c.next || '')}</select>
            </div>
            <div class="field-row insp-choice-row">
              <input class="input input-sm" data-choice-cond="${i}" data-focus="choice-${i}-cond" value="${esc(c.condition || '')}" placeholder="${uiText("условие, напр", "condition, e.g.")}. trust_mark >= 3" style="flex:1 1 auto" />
              ${c.condition ? (cond.ok ? uiText("<span class=\"insp-ok\" title=\"Условие разбирается\">", "<span class=\"insp-ok\" title=\"Valid condition\">") + icon('check', 12) + '</span>' : uiText("<span class=\"insp-bad\" title=\"Ошибка в условии\">", "<span class=\"insp-bad\" title=\"Invalid condition\">") + icon('alert', 12) + '</span>') : ''}
            </div>
            <input class="input input-sm" data-choice-hint="${i}" data-focus="choice-${i}-hint" value="${esc(c.hint || '')}" placeholder="${uiText("подсказка игроку (необязательно", "player hint (optional")})" />
            <div class="insp-choice-effects">
              ${(c.effects || [])
                .map((e, j) => {
                  const v = varById(e.varId);
                  return `<div class="insp-effect" data-ceffect="${i}-${j}">
                    <select class="select select-sm" data-ceffect-var="${i}-${j}">
                      <option value="">— ${uiText("переменная", "variable")} —</option>
                      ${(p.variables || [])
                        .map((vv) => `<option value="${esc(vv.id)}"${vv.id === e.varId ? ' selected' : ''}>${esc(vv.name)}</option>`)
                        .join('')}
                    </select>
                    <select class="select select-sm" data-ceffect-op="${i}-${j}">
                      ${Object.entries(OP_LABELS)
                        .map(([op, label]) => `<option value="${esc(op)}"${op === e.op ? ' selected' : ''}>${esc(label)}</option>`)
                        .join('')}
                    </select>
                    <input class="input input-sm" data-ceffect-value="${i}-${j}" value="${esc(e.value)}" ${e.op === 'toggle' ? 'disabled' : ''} />
                    <button class="btn btn-icon insp-danger" type="button" data-ceffect-del="${i}-${j}">×</button>
                    ${v ? '' : '<span class="insp-bad">' + icon('alert', 12) + '</span>'}
                  </div>`;
                })
                .join('')}
              <button class="btn btn-sm btn-ghost" type="button" data-ceffect-add="${i}">+ ${uiText("эффект варианта", "choice effect")}</button>
            </div>
          </div>`;
        })
        .join('');

      html.push(`<section class="insp-section">
        ${field(uiText("Ремарка перед выбором", "Direction before choice"), `<textarea class="textarea" rows="2" data-focus="text" data-autosize data-bind="text">${esc(node.text || '')}</textarea>`)}
        <div class="insp-section-head">
          <span class="insp-section-subtitle">${uiText("Варианты", "Choices")} (${choices.length})</span>
          <div class="grow"></div>
          <button class="btn btn-sm" type="button" data-act="choice-add">+ ${uiText("вариант", "choice")}</button>
        </div>
        ${cards || uiText("<div class=\"hint-text\">Пока нет ни одного варианта — валидатор сочтёт это ошибкой.</div>", "<div class=\"hint-text\">Add at least one choice to pass validation.</div>")}
      </section>`);
    }

    if (node.type === 'condition') {
      const branches = Array.isArray(node.branches) ? node.branches : [];
      html.push(`<section class="insp-section">
        <div class="insp-section-head">
          <span class="insp-section-subtitle">${uiText("Ветви", "Branches")} (${branches.length})</span>
          <div class="grow"></div>
          <button class="btn btn-sm" type="button" data-act="branch-add">+ ${uiText("ветка", "branch")}</button>
        </div>
        ${branches
          .map((b, i) => {
            const parsed = parseCondition(b.condition);
            return `<div class="insp-branch" data-branch-index="${i}">
              <div class="insp-choice-head">
                <span class="insp-choice-num">${uiText("Ветка", "Branch")} ${i + 1}</span>
                <div class="grow"></div>
                <button class="btn btn-icon" type="button" data-branch-up="${i}" ${i === 0 ? 'disabled' : ''}>${icon('up', 14)}</button>
                <button class="btn btn-icon" type="button" data-branch-down="${i}" ${i === branches.length - 1 ? 'disabled' : ''}>${icon('down', 14)}</button>
                <button class="btn btn-icon insp-danger" type="button" data-branch-del="${i}">×</button>
              </div>
              <div class="field-row">
                <input class="input input-sm" data-branch-cond="${i}" data-focus="branch-${i}-cond" value="${esc(b.condition || '')}" placeholder="${uiText("условие", "condition")}" style="flex:1 1 auto" />
                ${b.condition ? (parsed.ok ? '<span class="insp-ok">' + icon('check', 12) + '</span>' : uiText("<span class=\"insp-bad\" title=\"Ошибка в условии\">", "<span class=\"insp-bad\" title=\"Invalid condition\">") + icon('alert', 12) + '</span>') : ''}
              </div>
              <select class="select select-sm" data-branch-next="${i}">${optionsForNodes(node.id, b.next || '')}</select>
            </div>`;
          })
          .join('') || uiText("<div class=\"hint-text\">Ветвей нет — останется только «иначе».</div>", "<div class=\"hint-text\">No branches. Only the fallback remains».</div>")}
      </section>`);
    }

    if (node.type === 'scene') {
      html.push(`<section class="insp-section">
        ${field(
          uiText("Локация", "Location"),
          `<select class="select" data-focus="locationId" data-bind="locationId">
            <option value="">— ${uiText("не указана", "unspecified")} —</option>
            ${locs.map((l) => `<option value="${esc(l.id)}"${l.id === node.locationId ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}
          </select>`,
        )}
        ${field(uiText("Описание сцены", "Scene description"), `<textarea class="textarea" rows="5" data-focus="text" data-autosize data-bind="text">${esc(node.text || '')}</textarea>`, {
          counter: `${countWords(node.text)} ${plural(countWords(node.text), [uiText("слово", "word"), uiText("слова", "words"), uiText("слов", "words")])}`,
        })}
      </section>`);
    }

    if (node.type === 'end') {
      html.push(`<section class="insp-section">
        ${field(uiText("Финальный текст", "Ending text"), `<textarea class="textarea" rows="4" data-focus="text" data-autosize data-bind="text">${esc(node.text || '')}</textarea>`)}
        <p class="hint-text">${uiText("Узел-концовка. Исходящих связей у него нет", "Ending node with no outgoing links")}.</p>
      </section>`);
    }

    if (node.type === 'note') {
      html.push(`<section class="insp-section">
        ${field(uiText("Текст заметки", "Note text"), `<textarea class="textarea" rows="5" data-focus="text" data-autosize data-bind="text">${esc(node.text || '')}</textarea>`)}
        <p class="hint-text">${uiText("Заметки не попадают в экспорт и статистику слов", "Notes are excluded from export and word counts")}.</p>
      </section>`);
    }

    if (node.type === 'jump') {
      html.push(`<section class="insp-section">
        ${field(
          uiText("Цель перехода", "Jump target"),
          `<select class="select" data-focus="next" data-bind="next">${optionsForNodes(node.id, node.next || '')}</select>`,
        )}
      </section>`);
    }

    html.push(mediaBlock(node));
    html.push(effectsBlock(node));
    if (node.type !== 'jump') html.push(connectionsBlock(node));
    html.push(metaBlock(node));

    if (project().startNodeId !== node.id) {
      html.push(`<section class="insp-section insp-actions">
        <button class="btn btn-sm" type="button" data-act="make-start">${uiText("Сделать стартовым", "Set as start")}</button>
      </section>`);
    }

    return html.join('');
  }

  // ------------------------------------------------------------ карточки сущностей

  function entityHeader(kind, entity) {
    const titles = { character: uiText("Персонаж", "Character"), location: uiText("Локация", "Location"), variable: uiText("Переменная", "Variable"), chapter: uiText("Глава", "Chapter") };
    return `<div class="insp-head">
      <span class="insp-type insp-type-${kind}">${esc(titles[kind] || kind)}</span>
      <code class="insp-id">${esc(entity.id)}</code>
      <div class="grow"></div>
      <button class="btn btn-icon insp-danger" type="button" data-act="entity-del" title="${uiText("Удалить", "Delete")}">×</button>
    </div>`;
  }

  function usageStats(kind, id) {
    const p = project();
    const nodes = p.nodes || [];
    if (kind === 'character') {
      const list = nodes.filter((n) => n.speakerId === id);
      const words = list.reduce((s, n) => s + countWords(n.text), 0);
      return `${list.length} ${plural(list.length, [uiText("реплика", "line"), uiText("реплики", "lines"), uiText("реплик", "lines")])} · ${words} ${plural(words, [uiText("слово", "word"), uiText("слова", "words"), uiText("слов", "words")])}`;
    }
    if (kind === 'location') {
      const list = nodes.filter((n) => n.locationId === id);
      return `${list.length} ${plural(list.length, [uiText("сцена", "scene"), uiText("сцены", "scenes"), uiText("сцен", "scenes")])}`;
    }
    if (kind === 'variable') {
      const v = varById(id);
      if (!v) return '';
      const name = v.name;
      const condRe = new RegExp(`(^|[^\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w]|$)`);
      let conds = 0;
      let effs = 0;
      for (const n of nodes) {
        for (const c of n.choices || []) if (c.condition && condRe.test(c.condition)) conds++;
        for (const b of n.branches || []) if (b.condition && condRe.test(b.condition)) conds++;
        for (const e of n.effects || []) if (e.varId === id) effs++;
        for (const c of n.choices || []) for (const e of c.effects || []) if (e.varId === id) effs++;
      }
      return `${conds} ${plural(conds, [uiText("условие", "condition"), uiText("условия", "conditions"), uiText("условий", "conditions")])} · ${effs} ${plural(effs, [uiText("эффект", "effect"), uiText("эффекта", "effects"), uiText("эффектов", "effects")])}`;
    }
    if (kind === 'chapter') {
      const list = nodes.filter((n) => n.chapterId === id);
      return `${list.length} ${plural(list.length, [uiText("узел", "node"), uiText("узла", "nodes"), uiText("узлов", "nodes")])}`;
    }
    return '';
  }

  function renderCharacter(c) {
    const p = project();
    return [
      entityHeader('character', c),
      `<div class="insp-usage">${esc(usageStats('character', c.id))}</div>`,
      `<section class="insp-section">
        ${field(uiText("Имя", "Name"), `<input class="input" data-focus="name" data-bind="name" value="${esc(c.name)}" />`)}
        <span class="field-label">${uiText("Цвет", "Color")}</span>
        ${colorSwatches(c.color || '', 'color')}
        ${field(uiText("Роль", "Role"), `<input class="input" data-focus="role" data-bind="role" value="${esc(c.role || '')}" placeholder="${uiText("Главная героиня", "Protagonist")}" />`)}
        ${field(uiText("Возраст", "Age"), `<input class="input input-sm" data-focus="age" data-bind="age" value="${esc(c.age || '')}" />`)}
        ${field(uiText("Описание", "Description"), `<textarea class="textarea" rows="3" data-focus="description" data-bind="description">${esc(c.description || '')}</textarea>`)}
        ${field(uiText("Внешность", "Appearance"), `<textarea class="textarea" rows="2" data-focus="appearance" data-bind="appearance">${esc(c.appearance || '')}</textarea>`)}
        ${field(uiText("Характер", "Personality"), `<textarea class="textarea" rows="2" data-focus="personality" data-bind="personality">${esc(c.personality || '')}</textarea>`)}
        ${field(uiText("Манера речи", "Speech style"), `<textarea class="textarea" rows="2" data-focus="speech" data-bind="speech">${esc(c.speech || '')}</textarea>`)}
        ${field(uiText("Заметки", "Notes"), `<textarea class="textarea" rows="2" data-focus="notes" data-bind="notes">${esc(c.notes || '')}</textarea>`)}
        ${field(uiText("Теги", "Tags"), tagsEditor(c.tags, 'tags'))}
      </section>`,
      p.characters.length > 1
        ? ''
        : uiText("<p class=\"hint-text\" style=\"padding:0 10px 10px\">Удалить единственного персонажа нельзя.</p>", "<p class=\"hint-text\" style=\"padding:0 10px 10px\">The last character cannot be deleted.</p>"),
    ].join('');
  }

  function renderLocation(l) {
    return [
      entityHeader('location', l),
      `<div class="insp-usage">${esc(usageStats('location', l.id))}</div>`,
      `<section class="insp-section">
        ${field(uiText("Название", "Name"), `<input class="input" data-focus="name" data-bind="name" value="${esc(l.name)}" />`)}
        ${field(uiText("Описание", "Description"), `<textarea class="textarea" rows="3" data-focus="description" data-bind="description">${esc(l.description || '')}</textarea>`)}
        ${field(uiText("Атмосфера", "Atmosphere"), `<textarea class="textarea" rows="3" data-focus="atmosphere" data-bind="atmosphere">${esc(l.atmosphere || '')}</textarea>`)}
        ${field(uiText("Время суток", "Time of day"), `<input class="input input-sm" data-focus="timeOfDay" data-bind="timeOfDay" value="${esc(l.timeOfDay || '')}" placeholder="${uiText("Ночь", "Night")}" />`)}
        ${field(uiText("Заметки", "Notes"), `<textarea class="textarea" rows="2" data-focus="notes" data-bind="notes">${esc(l.notes || '')}</textarea>`)}
        ${field(uiText("Теги", "Tags"), tagsEditor(l.tags, 'tags'))}
      </section>`,
    ].join('');
  }

  function renderVariable(v) {
    const initialControl =
      v.type === 'bool'
        ? `<select class="select select-sm" data-focus="initial" data-bind="initial">
             <option value="false"${!v.initial ? ' selected' : ''}>${uiText("Ложь", "False")}</option>
             <option value="true"${v.initial ? ' selected' : ''}>${uiText("Истина", "True")}</option>
           </select>`
        : v.type === 'string'
          ? `<input class="input input-sm" data-focus="initial" data-bind="initial" value="${esc(v.initial || '')}" />`
          : `<input class="input input-sm" data-focus="initial" data-bind="initial" type="number" step="1" value="${esc(v.initial ?? 0)}" />`;

    return [
      entityHeader('variable', v),
      `<div class="insp-usage">${esc(usageStats('variable', v.id))}</div>`,
      `<section class="insp-section">
        ${field(uiText("Имя (латиницей)", "Name (Latin letters)"), `<input class="input" data-focus="name" data-bind="name" value="${esc(v.name)}" placeholder="trust_mark" />`, {
          hint: uiText("Используется в условиях и эффектах: только латиница, цифры, _.", "Used in conditions and effects: Latin letters, digits, _."),
        })}
        ${field(
          uiText("Тип", "Type"),
          `<select class="select" data-focus="type" data-bind="type">
            <option value="number"${v.type === 'number' ? ' selected' : ''}>${uiText("Число", "Number")}</option>
            <option value="bool"${v.type === 'bool' ? ' selected' : ''}>${uiText("Логическое", "Boolean")}</option>
            <option value="string"${v.type === 'string' ? ' selected' : ''}>${uiText("Строка", "String")}</option>
          </select>`,
        )}
        ${field(uiText("Начальное значение", "Initial value"), initialControl)}
        ${field(uiText("Описание", "Description"), `<textarea class="textarea" rows="2" data-focus="description" data-bind="description">${esc(v.description || '')}</textarea>`)}
      </section>`,
    ].join('');
  }

  function renderChapter(ch) {
    return [
      entityHeader('chapter', ch),
      `<div class="insp-usage">${esc(usageStats('chapter', ch.id))}</div>`,
      `<section class="insp-section">
        ${field(uiText("Название", "Name"), `<input class="input" data-focus="name" data-bind="name" value="${esc(ch.name)}" />`)}
        <span class="field-label">${uiText("Цвет", "Color")}</span>
        ${colorSwatches(ch.color || '', 'color')}
        <label class="checkbox"><input type="checkbox" data-focus="collapsed" data-bind="collapsed" ${ch.collapsed ? 'checked' : ''} /> ${uiText("Свёрнута в дереве", "Collapse in explorer")}</label>
      </section>`,
    ].join('');
  }

  // ------------------------------------------------------------ разбор правок

  function bindNode(node, key) {
    const act = (patch, label, quiet = false) => {
      apply([{ op: 'updateNode', id: node.id, patch }], label, { refresh: !quiet });
    };

    // Правки, которые не меняют состав полей панели.
    const QUIET_PROPS = new Set(['title', 'text', 'emotion', 'speakerId', 'locationId', 'tags']);

    root.querySelectorAll('[data-bind]').forEach((input) => {
      const prop = input.getAttribute('data-bind');
      const evt = input.tagName === 'SELECT' || input.type === 'checkbox' ? 'change' : 'input';
      const quiet = QUIET_PROPS.has(prop);
      const handler = () => {
        const value = input.type === 'checkbox' ? input.checked : input.value;
        act({ [prop]: value }, prop === 'text' ? uiText("Правка текста", "Edit text") : uiText("Правка узла", "Edit node"), quiet);
        if (prop === 'text') updateWordCounter(input, value);
      };
      const wrapped = evt === 'input' ? ui.editAfterPause(handler, 150) : handler;
      input.addEventListener(evt, wrapped);
    });

    // выбор целевого узла у line/scene/jump/end и у блока «Связи»
    root.querySelectorAll('select[data-bind="next"].select.select-sm, select[data-focus="next"]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const to = sel.value;
        if (!to) {
          apply([{ op: 'updateNode', id: node.id, patch: { next: '' } }], uiText("Убрать связь", "Remove link"));
          return;
        }
        apply([{ op: 'connect', from: node.id, to }], uiText("Связать узлы", "Connect nodes"));
      });
    });
  }

  /**
   * Счётчик слов обновляется на месте: пересборка панели ради одной подписи
   * не нужна. Высоту текстового поля считает CSS (field-sizing: content),
   * поэтому чтение scrollHeight — а с ним и принудительный лэйаут — убрано.
   */
  function updateWordCounter(textarea, value) {
    const counter = textarea.closest('.field')?.querySelector('.counter');
    if (!counter) return;
    const words = countWords(value);
    counter.textContent = `${words} ${plural(words, [uiText("слово", "word"), uiText("слова", "words"), uiText("слов", "words")])}`;
  }

  function wireMediaActions(node) {
    const section = root.querySelector('[data-media-zone]');
    if (!section) return;

    root.querySelector('[data-act="media-add"]')?.addEventListener('click', () => {
      ui.pickMediaForNode?.(node.id);
    });

    root.querySelectorAll('[data-media-preview]').forEach((btn) => {
      btn.addEventListener('click', () => ui.setNodePreview?.(node.id, btn.dataset.mediaPreview));
    });

    root.querySelectorAll('[data-media-del]').forEach((btn) => {
      btn.addEventListener('click', () => ui.removeNodeMedia?.(node.id, btn.dataset.mediaDel));
    });

    root.querySelectorAll('[data-media-open]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const media = (project().media || {})[btn.dataset.mediaOpen];
        if (!media) return;
        ui.modal({
          title: media.name,
          wide: true,
          body: `<div class="media-viewer"><img src="${esc(media.data)}" alt="${esc(media.name)}" /></div>
            <div class="hint-text">${media.w}×${media.h} · ${esc(formatBytes(media.size))} · ${esc(media.mime)}</div>`,
        });
      });
    });

    section.addEventListener('dragover', (e) => {
      if (!e.dataTransfer) return;
      if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      section.classList.add('drop-target');
    });
    section.addEventListener('dragleave', (e) => {
      if (section.contains(e.relatedTarget)) return;
      section.classList.remove('drop-target');
    });
    section.addEventListener('drop', (e) => {
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((file) =>
        String(file.type || '').startsWith('image/'),
      );
      section.classList.remove('drop-target');
      if (!files.length) return;
      e.preventDefault();
      ui.attachImages?.(node.id, files);
    });
  }

  function wireNodeActions(node) {
    const head = root.querySelector('.insp-head');
    wireMediaActions(node);
    head?.querySelector('[data-act="dup"]')?.addEventListener('click', () => duplicateNode(node));
    head?.querySelector('[data-act="del"]')?.addEventListener('click', () => deleteNode(node));
    head?.querySelector('[data-act="voice-play"]')?.addEventListener('click', () => {
      if (!ui.voice) {
        ui.toast(uiText("Озвучка не инициализирована", "Voice engine is not ready"), 'bad');
        return;
      }
      ui.voice.playNode(node.id);
    });
    root.querySelector('[data-act="make-start"]')?.addEventListener('click', () => {
      apply([{ op: 'setStart', id: node.id }], uiText("Сделать стартовым", "Set as start"));
      ui.toast(uiText("Стартовый узел изменён", "Start node changed"), 'good');
    });

    root.querySelector('[data-act="new-next"]')?.addEventListener('click', () => {
      ui.insertLine(node.id, node.type === 'end' ? undefined : { kind: 'next' });
    });

    root.querySelector('[data-act="new-char"]')?.addEventListener('click', () => {
      const res = apply([{ op: 'createCharacter', character: { name: uiText("Новый персонаж", "New character") } }], uiText("Новый персонаж", "New character"));
      const id = res?.created?.[0];
      if (id) apply([{ op: 'updateNode', id: node.id, patch: { speakerId: id } }], uiText("Сменить спикера", "Change speaker"));
    });

    // эффекты
    root.querySelector('[data-act="effect-add"]')?.addEventListener('click', () => {
      const vars = project().variables || [];
      if (!vars.length) {
        ui.toast(uiText("Сначала создайте переменную", "Create a variable first"), 'warn');
        return;
      }
      const effects = [...(node.effects || []), { varId: vars[0].id, op: 'set', value: 0 }];
      apply([{ op: 'setEffects', id: node.id, effects }], uiText("Добавить эффект", "Add effect"));
    });

    root.querySelectorAll('[data-effect-var]').forEach((sel) => {
      const i = Number(sel.dataset.effectVar);
      sel.addEventListener('change', () => {
        const effects = (node.effects || []).map((e, j) => (j === i ? { ...e, varId: sel.value } : e));
        apply([{ op: 'setEffects', id: node.id, effects }], uiText("Изменить эффект", "Edit effect"), { refresh: false });
      });
    });
    root.querySelectorAll('[data-effect-op]').forEach((sel) => {
      const i = Number(sel.dataset.effectOp);
      sel.addEventListener('change', () => {
        const effects = (node.effects || []).map((e, j) =>
          j === i ? { ...e, op: sel.value, value: sel.value === 'toggle' ? true : e.value } : e,
        );
        apply([{ op: 'setEffects', id: node.id, effects }], uiText("Изменить эффект", "Edit effect"), { refresh: false });
      });
    });
    root.querySelectorAll('[data-effect-value]').forEach((input) => {
      const i = Number(input.dataset.effectValue);
      input.addEventListener(
        'input',
        ui.editAfterPause(() => {
          const raw = input.value.trim();
          const num = Number(raw);
          const value = raw !== '' && !Number.isNaN(num) ? num : raw;
          const effects = (node.effects || []).map((e, j) => (j === i ? { ...e, value } : e));
          apply([{ op: 'setEffects', id: node.id, effects }], uiText("Изменить эффект", "Edit effect"), { refresh: false });
        }, 200),
      );
    });
    root.querySelectorAll('[data-effect-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.effectDel);
        const effects = (node.effects || []).filter((_, j) => j !== i);
        apply([{ op: 'setEffects', id: node.id, effects }], uiText("Удалить эффект", "Delete effect"));
      });
    });

    // варианты выбора
    const setChoices = (choices, label, refresh = true) => apply([{ op: 'setChoices', id: node.id, choices }], label, { refresh });
    const choices = () => (node.choices || []).map((c) => ({ ...c }));

    root.querySelector('[data-act="choice-add"]')?.addEventListener('click', () => {
      const list = choices();
      list.push({ id: uid('o_'), text: uiText("Новый вариант", "New choice"), next: '', condition: '', effects: [], hint: '' });
      setChoices(list, uiText("Добавить вариант", "Add choice"));
    });

    root.querySelectorAll('[data-choice-text]').forEach((input) => {
      const i = Number(input.dataset.choiceText);
      input.addEventListener(
        'input',
        ui.editAfterPause(() => {
          const list = choices();
          if (!list[i]) return;
          list[i].text = input.value;
          setChoices(list, uiText("Правка варианта", "Edit choice"), false);
        }, 150),
      );
    });
    root.querySelectorAll('[data-choice-next]').forEach((sel) => {
      const i = Number(sel.dataset.choiceNext);
      sel.addEventListener('change', () => {
        const list = choices();
        if (!list[i]) return;
        list[i].next = sel.value;
        setChoices(list, uiText("Цель варианта", "Choice target"), false);
      });
    });
    root.querySelectorAll('[data-choice-cond]').forEach((input) => {
      const i = Number(input.dataset.choiceCond);
      input.addEventListener(
        'input',
        ui.editAfterPause(() => {
          const list = choices();
          if (!list[i]) return;
          list[i].condition = input.value;
          setChoices(list, uiText("Условие варианта", "Choice condition"), false);
        }, 250),
      );
    });
    root.querySelectorAll('[data-choice-hint]').forEach((input) => {
      const i = Number(input.dataset.choiceHint);
      input.addEventListener(
        'input',
        ui.editAfterPause(() => {
          const list = choices();
          if (!list[i]) return;
          list[i].hint = input.value;
          setChoices(list, uiText("Подсказка варианта", "Choice hint"), false);
        }, 200),
      );
    });
    root.querySelectorAll('[data-choice-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.choiceDel);
        setChoices(choices().filter((_, j) => j !== i), uiText("Удалить вариант", "Delete choice"));
      });
    });
    root.querySelectorAll('[data-choice-up]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.choiceUp);
        const list = choices();
        if (i <= 0 || !list[i - 1]) return;
        [list[i - 1], list[i]] = [list[i], list[i - 1]];
        setChoices(list, uiText("Порядок вариантов", "Choice order"));
      });
    });
    root.querySelectorAll('[data-choice-down]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.choiceDown);
        const list = choices();
        if (i >= list.length - 1) return;
        [list[i + 1], list[i]] = [list[i], list[i + 1]];
        setChoices(list, uiText("Порядок вариантов", "Choice order"));
      });
    });

    // эффекты вариантов
    const ceffect = (key) => {
      const [iRaw, jRaw] = key.split('-');
      const i = Number(iRaw);
      const j = Number(jRaw);
      const list = choices();
      if (!list[i] || !list[i].effects[j]) return null;
      return { list, i, j };
    };
    root.querySelectorAll('[data-ceffect-add]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.ceffectAdd);
        const vars = project().variables || [];
        if (!vars.length) {
          ui.toast(uiText("Сначала создайте переменную", "Create a variable first"), 'warn');
          return;
        }
        const list = choices();
        list[i].effects = [...(list[i].effects || []), { varId: vars[0].id, op: 'set', value: 0 }];
        setChoices(list, uiText("Эффект варианта", "Choice effect"));
      });
    });
    root.querySelectorAll('[data-ceffect-var]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const ctx = ceffect(sel.dataset.ceffectVar);
        if (!ctx) return;
        ctx.list[ctx.i].effects[ctx.j] = { ...ctx.list[ctx.i].effects[ctx.j], varId: sel.value };
        setChoices(ctx.list, uiText("Эффект варианта", "Choice effect"), false);
      });
    });
    root.querySelectorAll('[data-ceffect-op]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const ctx = ceffect(sel.dataset.ceffectOp);
        if (!ctx) return;
        const prev = ctx.list[ctx.i].effects[ctx.j];
        ctx.list[ctx.i].effects[ctx.j] = { ...prev, op: sel.value, value: sel.value === 'toggle' ? true : prev.value };
        setChoices(ctx.list, uiText("Эффект варианта", "Choice effect"), false);
      });
    });
    root.querySelectorAll('[data-ceffect-value]').forEach((input) => {
      input.addEventListener(
        'input',
        ui.editAfterPause(() => {
          const ctx = ceffect(input.dataset.ceffectValue);
          if (!ctx) return;
          const raw = input.value.trim();
          const num = Number(raw);
          ctx.list[ctx.i].effects[ctx.j] = { ...ctx.list[ctx.i].effects[ctx.j], value: raw !== '' && !Number.isNaN(num) ? num : raw };
          setChoices(ctx.list, uiText("Эффект варианта", "Choice effect"), false);
        }, 200),
      );
    });
    root.querySelectorAll('[data-ceffect-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ctx = ceffect(btn.dataset.ceffectDel);
        if (!ctx) return;
        ctx.list[ctx.i].effects = ctx.list[ctx.i].effects.filter((_, k) => k !== ctx.j);
        setChoices(ctx.list, uiText("Удалить эффект варианта", "Delete choice effect"));
      });
    });

    // ветви условия
    const setBranches = (branches, label, refresh = true) => apply([{ op: 'setBranches', id: node.id, branches }], label, { refresh });
    const branches = () => (node.branches || []).map((b) => ({ ...b }));

    root.querySelector('[data-act="branch-add"]')?.addEventListener('click', () => {
      const list = branches();
      list.push({ id: uid('b_'), condition: '', next: '' });
      setBranches(list, uiText("Добавить ветку", "Add branch"));
    });
    root.querySelectorAll('[data-branch-cond]').forEach((input) => {
      const i = Number(input.dataset.branchCond);
      input.addEventListener(
        'input',
        ui.editAfterPause(() => {
          const list = branches();
          if (!list[i]) return;
          list[i].condition = input.value;
          setBranches(list, uiText("Условие ветки", "Branch condition"), false);
        }, 250),
      );
    });
    root.querySelectorAll('[data-branch-next]').forEach((sel) => {
      const i = Number(sel.dataset.branchNext);
      sel.addEventListener('change', () => {
        const list = branches();
        if (!list[i]) return;
        list[i].next = sel.value;
        setBranches(list, uiText("Цель ветки", "Branch target"), false);
      });
    });
    root.querySelectorAll('[data-branch-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.branchDel);
        setBranches(branches().filter((_, j) => j !== i), uiText("Удалить ветку", "Delete branch"));
      });
    });
    root.querySelectorAll('[data-branch-up]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.branchUp);
        const list = branches();
        if (i <= 0 || !list[i - 1]) return;
        [list[i - 1], list[i]] = [list[i], list[i - 1]];
        setBranches(list, uiText("Порядок веток", "Branch order"));
      });
    });
    root.querySelectorAll('[data-branch-down]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.branchDown);
        const list = branches();
        if (i >= list.length - 1) return;
        [list[i + 1], list[i]] = [list[i], list[i + 1]];
        setBranches(list, uiText("Порядок веток", "Branch order"));
      });
    });

    // переходы по входящим связям
    root.querySelectorAll('[data-goto]').forEach((btn) => {
      btn.addEventListener('click', () => ui.selectNode(btn.dataset.goto));
    });

    // цвет узла
    root.querySelectorAll('.swatch[data-color]').forEach((sw) => {
      sw.addEventListener('click', () => {
        apply([{ op: 'updateNode', id: node.id, patch: { color: sw.dataset.color } }], uiText("Цвет узла", "Node color"));
      });
    });

    wireTags((tags) => apply([{ op: 'updateNode', id: node.id, patch: { tags } }], uiText("Теги узла", "Node tags"), { refresh: false }), node.tags);
  }

  async function duplicateNode(node) {
    const copy = structuredClone(node);
    copy.id = undefined;
    const res = apply([{ op: 'createNode', node: copy }], uiText("Дублировать узел", "Duplicate node"));
    const id = res?.created?.[0];
    if (id) {
      ui.selectNode(id);
      ui.toast(uiText("Узел продублирован", "Node duplicated"), 'good');
    }
  }

  async function deleteNode(node) {
    const incoming = incomingEdges(project(), node.id);
    const hasNext = !!node.next;
    const buttons = [{ label: uiText("Отмена", "Cancel") }];
    if (incoming.length && hasNext) {
      buttons.push({
        label: uiText("Удалить и перенаправить", "Delete and redirect links"),
        kind: 'primary',
        onClick: (api) => {
          api.close();
          apply([{ op: 'deleteNode', id: node.id, reconnectTo: node.next }], uiText("Удалить узел", "Delete node"));
        },
      });
    }
    buttons.push({
      label: uiText("Удалить", "Delete"),
      kind: 'danger',
      onClick: (api) => {
        api.close();
        apply([{ op: 'deleteNode', id: node.id }], uiText("Удалить узел", "Delete node"));
      },
    });

    ui.modal({
      title: uiText("Удалить узел?", "Delete node?"),
      body: `<p style="margin:0 0 6px">${uiText("Узел", "Node")} <code>${esc(node.id)}</code> ${uiText("будет удалён", "will be deleted")}.</p>
        ${incoming.length ? `<p class="hint-text">${uiText("Входящих связей", "Incoming links")}: ${incoming.length}. ${hasNext ? uiText("Их можно перенаправить на следующий узел.", "They can be redirected to the next node.") : uiText("Они станут оборванными.", "They will be broken.")}</p>` : ''}`,
      buttons,
    });
  }

  // ------------------------------------------------------------ теги

  function wireTags(onChange, currentTags) {
    const host = root.querySelector('[data-role="tags"]');
    if (!host) return;
    let tags = Array.isArray(currentTags) ? [...currentTags] : [];
    host.querySelectorAll('[data-tag-index]').forEach((btn) => {
      btn.addEventListener('click', () => {
        tags = tags.filter((_, i) => i !== Number(btn.dataset.tagIndex));
        onChange(tags);
      });
    });
    const input = host.querySelector('.insp-tag-input');
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const value = input.value.trim();
          if (!value) return;
          if (!tags.includes(value)) tags = [...tags, value];
          input.value = '';
          onChange(tags);
        }
      });
    }
  }

  // ------------------------------------------------------------ карточки сущностей: действия

  function wireEntityActions(kind, entity) {
    root.querySelector('[data-act="entity-del"]')?.addEventListener('click', () => deleteEntity(kind, entity));

    root.querySelectorAll('[data-bind]').forEach((input) => {
      const prop = input.getAttribute('data-bind');
      const isSelect = input.tagName === 'SELECT' || input.type === 'checkbox';
      const handler = () => {
        let value = input.type === 'checkbox' ? input.checked : input.value;
        if (prop === 'initial') {
          if (entity.type === 'number') value = Number(value) || 0;
          else if (entity.type === 'bool') value = value === 'true';
        }
        if (prop === 'name' && kind === 'variable') value = String(value).replace(/[^A-Za-z0-9_]/g, '_');
        const opName =
          kind === 'character' ? 'updateCharacter' : kind === 'location' ? 'updateLocation' : kind === 'variable' ? 'updateVariable' : 'updateChapter';
        apply([{ op: opName, id: entity.id, patch: { [prop]: value } }], uiText("Правка объекта", "Edit entry"));
        if (prop === 'type') {
          const fallback = value === 'bool' ? false : value === 'string' ? '' : 0;
          apply([{ op: opName, id: entity.id, patch: { initial: fallback } }], uiText("Тип переменной", "Variable type"));
        }
      };
      input.addEventListener(isSelect ? 'change' : 'input', isSelect ? handler : ui.editAfterPause(handler, 150));
    });

    root.querySelectorAll('.swatch[data-color]').forEach((sw) => {
      sw.addEventListener('click', () => {
        const opName =
          kind === 'character' ? 'updateCharacter' : kind === 'location' ? 'updateLocation' : kind === 'variable' ? 'updateVariable' : 'updateChapter';
        apply([{ op: opName, id: entity.id, patch: { color: sw.dataset.color } }], uiText("Цвет", "Color"));
      });
    });

    wireTags(
      (tags) => {
        const opName =
          kind === 'character' ? 'updateCharacter' : kind === 'location' ? 'updateLocation' : kind === 'variable' ? 'updateVariable' : 'updateChapter';
        apply([{ op: opName, id: entity.id, patch: { tags } }], uiText("Теги", "Tags"));
      },
      entity.tags,
    );
  }

  async function deleteEntity(kind, entity) {
    const p = project();
    const titles = { character: uiText("персонажа", "character"), location: uiText("локацию", "location"), variable: uiText("переменную", "variable"), chapter: uiText("главу", "chapter") };
    const counts = usageStats(kind, entity.id);
    const ok = await ui.confirm(`${uiText("Удалить", "Delete")} ${titles[kind]} «${entity.name || entity.id}»?`, {
      detail: counts ? `${uiText("Используется", "Used")}: ${counts}.` : '',
      danger: true,
      okLabel: uiText("Удалить", "Delete"),
    });
    if (!ok) return;
    const op = kind === 'character' ? 'deleteCharacter' : kind === 'location' ? 'deleteLocation' : kind === 'variable' ? 'deleteVariable' : 'deleteChapter';
    const res = apply([{ op, id: entity.id }], uiText("Удалить объект", "Delete entry"));
    if (res?.ok !== false) {
      store.setSelection({ kind: 'node', id: store.selection?.id || null });
      ui.refresh();
      ui.toast(uiText("Удалено", "Deleted"), 'good');
    }
  }

  // ------------------------------------------------------------ публичный рендер

  function render() {
    const sel = store.selection || {};
    const key = `${sel.kind || 'none'}:${sel.id || ''}`;
    const focusSnap = captureFocus();
    lastKey = key;
    root.innerHTML = '';
    root.scrollTop = 0;

    if (sel.kind === 'node' && sel.id) {
      const node = nodeById(sel.id);
      if (!node) {
        root.innerHTML = emptyHint(uiText("Узел не найден. Возможно, он был удалён.", "Node not found. It may have been deleted."));
        return;
      }
      root.innerHTML = renderNode(node);
      bindNode(node);
      wireNodeActions(node);
      restoreFocus(focusSnap);
      return;
    }

    if (sel.kind === 'character' && sel.id) {
      const c = charById(sel.id);
      if (!c) {
        root.innerHTML = emptyHint(uiText("Персонаж не найден.", "Character not found."));
        return;
      }
      root.innerHTML = renderCharacter(c);
      wireEntityActions('character', c);
      restoreFocus(focusSnap);
      return;
    }

    if (sel.kind === 'location' && sel.id) {
      const l = locById(sel.id);
      if (!l) {
        root.innerHTML = emptyHint(uiText("Локация не найдена.", "Location not found."));
        return;
      }
      root.innerHTML = renderLocation(l);
      wireEntityActions('location', l);
      restoreFocus(focusSnap);
      return;
    }

    if (sel.kind === 'variable' && sel.id) {
      const v = varById(sel.id);
      if (!v) {
        root.innerHTML = emptyHint(uiText("Переменная не найдена.", "Variable not found."));
        return;
      }
      root.innerHTML = renderVariable(v);
      wireEntityActions('variable', v);
      restoreFocus(focusSnap);
      return;
    }

    if (sel.kind === 'chapter' && sel.id) {
      const ch = (project().chapters || []).find((c) => c.id === sel.id);
      if (!ch) {
        root.innerHTML = emptyHint(uiText("Глава не найдена.", "Chapter not found."));
        return;
      }
      root.innerHTML = renderChapter(ch);
      wireEntityActions('chapter', ch);
      restoreFocus(focusSnap);
      return;
    }

    // ничего не выбрано — сводка по проекту
    const p = project();
    const nodes = p.nodes || [];
    const lines = nodes.filter((n) => n.type === 'line');
    const words = nodes.reduce((s, n) => s + countWords(n.text), 0);
    root.innerHTML = `<div class="insp-empty">
      <div class="insp-empty-title">${esc(p.meta?.title || uiText("Проект", "Project"))}</div>
      <div class="insp-empty-stats">
        <div><b>${nodes.length}</b> ${plural(nodes.length, [uiText("узел", "node"), uiText("узла", "nodes"), uiText("узлов", "nodes")])}</div>
        <div><b>${lines.length}</b> ${plural(lines.length, [uiText("реплика", "line"), uiText("реплики", "lines"), uiText("реплик", "lines")])}</div>
        <div><b>${words}</b> ${plural(words, [uiText("слово", "word"), uiText("слова", "words"), uiText("слов", "words")])}</div>
      </div>
      <p class="hint-text">${uiText("Выберите узел на графе или в левой панели, чтобы редактировать его здесь", "Select a node in the graph or left sidebar to edit it here")}.</p>
    </div>`;
  }

  function focusNode(id) {
    const node = nodeById(id);
    if (!node) return;
    store.setSelection({ kind: 'node', id });
    pendingFocus = null;
    render();
    const text = root.querySelector('[data-focus="text"]');
    if (text) {
      text.focus();
      if (typeof text.setSelectionRange === 'function') text.setSelectionRange(text.value.length, text.value.length);
    }
  }

  function openEntity(kind, id) {
    store.setSelection({ kind, id });
    pendingFocus = null;
    render();
  }

  return { render, focusNode, openEntity };
}