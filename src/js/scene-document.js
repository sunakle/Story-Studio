import { t as uiText } from './i18n.js';
import { icon } from './icons.js';
import { TYPE_LABELS, outgoingEdges, incomingEdges, parseCondition } from './model.js';
import { entityLists, kindLabels, nodeTitle } from './story-search.js';

export function renderDocument({
  page,
  tab,
  store,
  ui,
  openNode,
  openGraph,
  bookmark,
  isMarked,
  openEntity,
  openPlayer,
}) {
  const p = store.project,
    esc = ui.escapeHTML;
  const collection = p[entityLists[tab.kind]] || [];
  const obj = collection.find((o) => o.id === tab.id);
  const actionIcons = {graph:'graph',listen:'volume',play:'play',bookmark:'bookmark',around:'link',insert:'plus',chapter:'folder',overview:'graph'};
  const button = (act, label, pressed = null) =>
    `<button type="button" class="wb-doc-action" data-doc-act="${act}"${pressed === null ? '' : ` aria-pressed="${pressed}"`}>${icon(actionIcons[act],15)}<span>${esc(label)}</span></button>`;
  const nodeMap = new Map(p.nodes.map((n) => [n.id, n]));
  const edgeLabel = (edge) =>
    edge.label || { next: uiText("Далее", "Next"), else: uiText("Иначе", "Else"), choice: uiText("Выбор", "Choice"), branch: uiText("Условие", "Condition") }[edge.kind];
  function openLink(id, label, target = '') {
    return `<button type="button" class="wb-link" data-open-node="${esc(id)}" data-focus-field="${esc(target)}">${icon('file',14)}<b>${esc(nodeTitle(nodeMap.get(id)) || id)}</b><span>${esc(label)}</span></button>`;
  }
  if (!obj) {
    const chapter = p.chapters.find((item) => item.id === tab.lastChapterId);
    page.innerHTML = `<div class="wb-empty"><h2>${uiText("Объект удалён", "Entry deleted")}</h2>
      ${chapter ? button('chapter', uiText("К главе «", "Go to chapter «") + chapter.name + '»') : ''}
      ${button('overview', uiText("Открыть обзор", "Open overview"))}</div>`;
    page.onclick = (event) => {
      const action = event.target.closest('[data-doc-act]')?.dataset.docAct;
      if (action === 'chapter' && chapter) openEntity('chapter', chapter.id);
      if (action === 'overview') ui.workbench?.openOverview();
    };
    return;
  }
  function section(key, heading, count, content, extra = '') {
    return `<details class="wb-doc-section" data-doc-section="${key}" ${tab.folded?.[key] ? '' : 'open'}>
      <summary>${icon('chevronDown',14)}<strong>${heading}</strong><span class="wb-count">${count}</span></summary>
      <div class="wb-links">${content}</div>${extra}</details>`;
  }
  if (tab.kind !== 'node') {
    const links = [];
    for (const n of p.nodes) {
      if (
        (tab.kind === 'character' && n.speakerId === obj.id) ||
        (tab.kind === 'location' && n.locationId === obj.id) ||
        (tab.kind === 'chapter' && n.chapterId === obj.id)
      )
        links.push(openLink(n.id, TYPE_LABELS[n.type]));
      if (tab.kind !== 'variable') continue;
      const condition = (expr, label, field) => {
        if (expr && parseCondition(expr).names?.includes(obj.name))
          links.push(openLink(n.id, `${label} · ${expr}`, field));
      };
      const effects = (items, label, field) => {
        (items || []).forEach((effect, index) => {
          if (effect.varId === obj.id)
            links.push(
              openLink(
                n.id,
                `${label} · ${obj.name} ${effect.op} ${effect.value ?? ''}`,
                field + '-' + index,
              ),
            );
        });
      };
      effects(n.effects, uiText("Эффект узла", "Node effect"), 'effect');
      (n.choices || []).forEach((c, i) => {
        condition(c.condition, c.text, 'choice-' + i);
        effects(c.effects, c.text, 'ceffect-' + i);
      });
      (n.branches || []).forEach((b, i) => condition(b.condition, uiText("Условие", "Condition"), 'branch-' + i));
    }
    page.innerHTML = `<article class="wb-document"><header class="wb-doc-head"><div class="wb-doc-kind">${esc(kindLabels[tab.kind])}</div><h1>${esc(obj.name)}</h1></header>
      ${obj.description ? `<p class="wb-description">${esc(obj.description)}</p>` : ''}
      ${section('usage',uiText("Используется в сценарии", "Used in story"),links.length,links.join('') || uiText("<p class=\"hint-text\">Ссылок пока нет.</p>", "<p class=\"hint-text\">No links yet.</p>"))}</article>`;

  } else {
    const n = obj;
    const chapter = p.chapters.find((c) => c.id === n.chapterId),
      speaker = p.characters.find((c) => c.id === n.speakerId),
      location = p.locations.find((l) => l.id === n.locationId);
    const incoming = incomingEdges(p, n.id),
      outgoing = outgoingEdges(p, n.id);
    const entityLink = (kind, id, name) =>
      id
        ? `<button class="wb-inline" data-entity-id="${esc(id)}" data-kind="${kind}">${esc(name)}</button>`
        : esc(name);
    const property = (glyph, name, value) =>
      `<div class="wb-property"><dt>${icon(glyph,14)}${name}</dt><dd>${value}</dd></div>`;
    const properties = [
      chapter && property('folder',uiText("Глава", "Chapter"),entityLink('chapter',chapter.id,chapter.name)),
      speaker && property('user',uiText("Спикер", "Speaker"),entityLink('character',speaker.id,speaker.name)),
      location && property('pin',uiText("Место", "Place"),entityLink('location',location.id,location.name))
    ].filter(Boolean).join('');
    page.innerHTML = `<article class="wb-document">
      <header class="wb-doc-head"><div class="wb-doc-kind">${icon(n.type === 'choice' ? 'branch' : 'file',14)}${esc(TYPE_LABELS[n.type])}</div>
      <h1>${esc(n.title || nodeTitle(n))}</h1></header>
      ${properties ? `<dl class="wb-properties" aria-label="${uiText("Свойства сцены", "Scene properties")}">${properties}</dl>` : ''}
      <label class="wb-field wb-editor"><span class="wb-sr">${n.type === 'note' ? uiText("Текст заметки", "Note text") : uiText("Текст узла", "Node text")}</span><textarea id="documentText" spellcheck="true" placeholder="${n.type === 'note' ? uiText("Напишите заметку…", "Write a note…") : uiText("Введите текст сцены…", "Enter scene text…")}" rows="3">${esc(n.text)}</textarea></label>
      <div class="wb-tools wb-doc-actions" aria-label="${uiText("Действия сцены", "Scene actions")}">${button('graph',uiText("На схеме", "Show on canvas"))}${n.type === 'line' ? button('listen',uiText("Прослушать", "Listen")) : ''}
        ${n.type !== 'note' ? button('play',uiText("Пройти отсюда", "Play from here")) : ''}${button('bookmark',isMarked(n.id) ? uiText("Убрать закладку", "Remove bookmark") : uiText("В закладки", "Bookmark"),isMarked(n.id))}${button('around',uiText("Связи в обзоре", "View connections"))}</div>
      ${section('incoming',uiText("Входящие переходы", "Incoming transitions"),incoming.length,incoming.map(e => openLink(e.from,edgeLabel(e))).join('') || uiText("<p class=\"hint-text\">Входящих переходов нет.</p>", "<p class=\"hint-text\">No incoming transitions.</p>"))}
      ${section('outgoing',uiText("Продолжение", "Continuation"),outgoing.length,outgoing.map(e => openLink(e.to,edgeLabel(e))).join('') || uiText("<p class=\"hint-text\">Исходящих переходов нет.</p>", "<p class=\"hint-text\">No outgoing transitions.</p>"),n.type === 'note' ? '' : button('insert',uiText("Вставить реплику…", "Insert line…")))}
      </article>`;
    const input = page.querySelector('#documentText');
    input.oninput = () => {
      const res = store.apply([{ op: 'updateNode', id: n.id, patch: { text: input.value } }], {
        label: uiText("Текст сцены", "Scene text"),
        group: 'scene-text/' + n.id,
      });
      if (!res.ok) ui.toast(res.error, 'bad');
    };
  }
  page.querySelectorAll('[data-doc-section]').forEach(details => {
    details.ontoggle = () => {
      tab.folded ||= {};
      tab.folded[details.dataset.docSection] = !details.open;
    };
  });
  page.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.openNode) {
      openNode(b.dataset.openNode);
      if (b.dataset.focusField) {
        const field = b.dataset.focusField;
        const parts = field.split('-');
        const selector =
          parts[0] === 'ceffect'
            ? '[data-ceffect-var="' + parts[1] + '-' + parts[2] + '"]'
            : parts[0] === 'effect'
              ? '[data-effect-var="' + parts[1] + '"]'
              : '[data-' + parts[0] + '-cond="' + parts[1] + '"]';
        document.getElementById('rightPanel').classList.remove('collapsed');
        const dest = document.querySelector('#inspectorBody ' + selector);
        dest?.scrollIntoView({ block: 'center' });
        dest?.focus();
      }
      return;
    }
    if (b.dataset.entityId) return openEntity(b.dataset.kind, b.dataset.entityId);
    switch (b.dataset.docAct) {
      case 'graph':
        openGraph(obj.id);
        break;
      case 'listen':
        ui.flushEdits?.();
        ui.voice?.playNode(obj.id);
        break;
      case 'play':
        openPlayer(obj.id);
        break;
      case 'around':
        ui.visualizer?.openNeighborhood(obj.id);
        break;
      case 'insert':
        ui.insertLine?.(obj.id);
        break;
      case 'bookmark':
        bookmark(obj.id);
        b.querySelector('span').textContent = isMarked(obj.id) ? uiText("Убрать закладку", "Remove bookmark") : uiText("В закладки", "Bookmark");
        b.setAttribute('aria-pressed', String(isMarked(obj.id)));
        break;
    }
  };
}
