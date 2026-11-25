import { t as uiText } from './i18n.js';
// StoryForge — левая панель: 6 вкладок (Сценарий, Персонажи, Локации,
// Переменные, Поиск, Статистика) + оверлей валидации над графом.
import {
  TYPE_LABELS,
  plural,
  countWords,
  validateProject,
  computeStats,
  nodeSpeakerName,
  nodeLocationName,
} from './model.js';
import { icon } from './icons.js';
import { compileNodeQuery } from './story-search.js';

const TAB_ORDER = ['script', 'characters', 'locations', 'variables', 'search', 'stats','bookmarks'];

const TYPE_ICONS = {
  line: '<path d="M4 6h16M4 11h16M4 16h10"/>',
  choice: '<path d="M6 4v7a4 4 0 0 0 4 4h8"/><path d="m15 12 3 3-3 3"/>',
  condition: '<path d="M3 12h5l3-6 3 12 3-6h4"/>',
  jump: '<path d="M5 12h12"/><path d="m13 8 4 4-4 4"/>',
  scene: '<path d="M3 6h18v12H3z"/><path d="m3 16 5-4 4 3 3-2 6 5"/>',
  end: '<path d="M6 6h12v12H6z"/>',
  note: '<path d="M5 4h9l5 5v11H5z"/><path d="M14 4v5h5"/>',
};

const SEV_ORDER = { error: 0, warning: 1, hint: 2 };
const SEV_LABEL = { get error() { return uiText("Ошибка", "Error"); }, get warning() { return uiText("Предупреждение", "Warning"); }, get hint() { return uiText("Подсказка", "Hint"); } };

export function createPanels({ root, store, ui }) {
  const esc = (s) => ui.escapeHTML(s);

  let tab = 'script';
  let searchQuery = '';
  let searchRegex = false;
  let searchFocus = false;
  let sev = 'all';
  let issues = [];
  let wired = false;

  const project = () => store.project;
  const nodes = () => project().nodes || [];
  const chapters = () => project().chapters || [];

  function stats() {
    try {
      return computeStats(project());
    } catch {
      return {
        nodes: nodes().length,
        lines: nodes().filter((n) => n.type === 'line').length,
        words: nodes().reduce((s, n) => s + countWords(n.text), 0),
        chars: (project().characters || []).length,
        choices: nodes().reduce((s, n) => s + (n.choices || []).length, 0),
        endings: nodes().filter((n) => n.type === 'end').length,
        notes: nodes().filter((n) => n.type === 'note').length,
        minutes: 0,
        byType: {},
        bySpeaker: [],
        byLocation: [],
        longestChain: 0,
        unreachable: 0,
        chapters: [],
      };
    }
  }

  const typeIcon = (type, size = 13) =>
    `<svg class="type-icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${TYPE_ICONS[type] || TYPE_ICONS.line}</svg>`;

  const nodeTitle = (n) => {
    const raw = n.title || n.text || (n.choices && n.choices[0] && n.choices[0].text) || n.id;
    const flat = String(raw).replace(/\s+/g, ' ').trim();
    return flat.length > 64 ? `${flat.slice(0, 64)}…` : flat || uiText("(пусто)", "(empty)");
  };

  // ---------------------------------------------------------------- вкладка «Сценарий»

  function renderScript() {
    const p = project();
    const all = nodes();
    if (!all.length) {
      return `<div class="empty">${uiText("Проект пуст", "Empty project")}.<br />${uiText("Создайте первый узел в центре экрана", "Create the first node in the center of the workspace")}.</div>`;
    }

    const chs = chapters();
    const byChapter = new Map();
    for (const n of all) {
      const key = n.chapterId || '';
      if (!byChapter.has(key)) byChapter.set(key, []);
      byChapter.get(key).push(n);
    }

    let html = `<div class="panel-head">
      <span class="panel-title">${uiText("Сценарий", "Story")}</span>
      <div class="grow"></div>
      <button class="btn btn-sm btn-ghost" type="button" data-act="add-chapter" title="${uiText("Добавить главу", "Add chapter")}">+ ${uiText("глава", "chapter")}</button>
    </div>`;

    const groups = [];
    for (const ch of chs) groups.push({ id: ch.id, name: ch.name, color: ch.color, collapsed: !!ch.collapsed, list: byChapter.get(ch.id) || [] });
    const loose = byChapter.get('') || [];
    if (loose.length) groups.push({ id: '', name: uiText("Без главы", "Unassigned"), color: '', collapsed: false, list: loose });

    for (const g of groups) {
      const isStartChapter = g.list.some((n) => n.id === p.startNodeId);
      html += `<div class="ch-group" data-chapter="${esc(g.id)}">
        <div class="ch-head">
          <button class="ch-toggle" type="button" data-ch-toggle="${esc(g.id)}" aria-expanded="${!g.collapsed}">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="transform:rotate(${g.collapsed ? 0 : 90}deg)"><path d="m9 6 6 6-6 6"/></svg>
          </button>
          ${g.color ? `<span class="dot" style="--dot:${esc(g.color)}"></span>` : ''}
          <button class="ch-name" type="button" data-ch-open="${esc(g.id)}">${esc(g.name)}</button>
          <span class="count-pill">${g.list.length}</span>
          <div class="grow"></div>
          <button class="btn btn-icon" type="button" data-ch-add="${esc(g.id)}" title="${uiText("Узел в этой главе", "Node in this chapter")}">+</button>
        </div>
        ${g.collapsed
          ? ''
          : `<div class="list ch-list">${g.list
              .map((n) => {
                const sel = store.selection?.kind === 'node' && store.selection.id === n.id;
                const isStart = n.id === p.startNodeId;
                const broken = !!(n.next && !all.some((x) => x.id === n.next));
                return `<button class="list-item${sel ? ' active' : ''}" type="button" data-node="${esc(n.id)}" title="${esc(n.id)}">
                  ${typeIcon(n.type)}
                  <span class="li-main">
                    <span class="li-title">${esc(nodeTitle(n))}</span>
                    <span class="li-sub">${esc(TYPE_LABELS[n.type] || n.type)}${isStart ? uiText(" · <span class=\"dot-start\"></span>старт", " · <span class=\"dot-start\"></span>start") : ''}${broken ? ' · ' + icon('alert', 11) + uiText(" битая связь", " broken link") : ''}</span>
                  </span>
                  ${n.type === 'line' && n.speakerId ? `<span class="dot" style="--dot:${esc((project().characters || []).find((c) => c.id === n.speakerId)?.color || '#9aa6b6')}"></span>` : ''}
                </button>`;
              })
              .join('') || uiText("<div class=\"hint-text\" style=\"padding:6px 10px\">В главе пока нет узлов.</div>", "<div class=\"hint-text\" style=\"padding:6px 10px\">This chapter has no nodes yet.</div>")}</div>`}
      </div>`;
    }

    return html;
  }

  // ---------------------------------------------------------------- списки сущностей

  function entityList({ kind, items, title, addLabel, emptyText, renderSub, colorOf }) {
    const head = `<div class="panel-head">
      <span class="panel-title">${esc(title)}</span>
      <div class="grow"></div>
      <button class="btn btn-sm btn-ghost" type="button" data-act="add-${kind}">${esc(addLabel)}</button>
    </div>`;
    if (!items.length) return head + `<div class="empty">${esc(emptyText)}</div>`;
    const rows = items
      .map((it) => {
        const sel = store.selection?.kind === kind && store.selection.id === it.id;
        return `<button class="list-item${sel ? ' active' : ''}" type="button" data-entity="${kind}:${esc(it.id)}">
          <span class="dot" style="--dot:${esc(colorOf(it) || '#9aa6b6')}"></span>
          <span class="li-main">
            <span class="li-title">${esc(it.name || it.id)}</span>
            <span class="li-sub">${renderSub(it)}</span>
          </span>
        </button>`;
      })
      .join('');
    return head + `<div class="list">${rows}</div>`;
  }

  function renderCharacters() {
    const p = project();
    const all = nodes();
    return entityList({
      kind: 'character',
      items: p.characters || [],
      title: uiText("Персонажи", "Characters"),
      addLabel: uiText("+ персонаж", "+ character"),
      emptyText: uiText("Пока нет персонажей.", "No characters yet."),
      colorOf: (c) => c.color,
      renderSub: (c) => {
        const lines = all.filter((n) => n.speakerId === c.id).length;
        const words = all.filter((n) => n.speakerId === c.id).reduce((s, n) => s + countWords(n.text), 0);
        const role = c.role ? `${esc(c.role)} · ` : '';
        return `${role}${lines} ${plural(lines, [uiText("реплика", "line"), uiText("реплики", "lines"), uiText("реплик", "lines")])} · ${words} ${plural(words, [uiText("слово", "word"), uiText("слова", "words"), uiText("слов", "words")])}`;
      },
    });
  }

  function renderLocations() {
    const p = project();
    const all = nodes();
    return entityList({
      kind: 'location',
      items: p.locations || [],
      title: uiText("Локации", "Locations"),
      addLabel: uiText("+ локация", "+ location"),
      emptyText: uiText("Пока нет локаций.", "No locations yet."),
      colorOf: () => '',
      renderSub: (l) => {
        const cnt = all.filter((n) => n.locationId === l.id).length;
        const t = l.timeOfDay ? `${esc(l.timeOfDay)} · ` : '';
        return `${t}${cnt} ${plural(cnt, [uiText("сцена", "scene"), uiText("сцены", "scenes"), uiText("сцен", "scenes")])}`;
      },
    });
  }

  function renderVariables() {
    const p = project();
    const all = nodes();
    return entityList({
      kind: 'variable',
      items: p.variables || [],
      title: uiText("Переменные", "Variables"),
      addLabel: uiText("+ переменная", "+ variable"),
      emptyText: uiText("Пока нет переменных.", "No variables yet."),
      colorOf: () => '',
      renderSub: (v) => {
        let uses = 0;
        for (const n of all) {
          for (const e of n.effects || []) if (e.varId === v.id) uses++;
          for (const c of n.choices || []) for (const e of c.effects || []) if (e.varId === v.id) uses++;
        }
        const typeLabel = v.type === 'bool' ? uiText("логическое", "boolean") : v.type === 'string' ? uiText("строка", "string") : uiText("число", "number");
        const initial = v.type === 'bool' ? (v.initial ? uiText("истина", "true") : uiText("ложь", "false")) : v.initial === '' || v.initial === undefined ? '—' : v.initial;
        return `${esc(v.name)} = ${esc(String(initial))} · ${typeLabel} · ${uses} ${plural(uses, [uiText("эффект", "effect"), uiText("эффекта", "effects"), uiText("эффектов", "effects")])}`;
      },
    });
  }

  // ---------------------------------------------------------------- поиск

  function collectMatches(query) {
    const q = query.trim();
    const p = project();
    const matcher = compileNodeQuery(p,query,{regex:searchRegex});
    const result = { nodes: [], characters: [], locations: [], variables: [], invalid: matcher.error, text:matcher.text };
    if (q.length < 2 || matcher.error) return result;
    const hit = matcher.testText;

    for (const n of nodes()) {
      if (matcher.matches(n)) {
        const where = n.text && hit(n.text) ? n.text : n.title || (n.choices || []).map((c) => c.text).join(' · ') || n.id;
        result.nodes.push({ node: n, snippet: where });
      }
    }
    if (matcher.hasFilters) return result;
    for (const c of p.characters || []) {
      const hay = [c.name, c.role, c.description, c.appearance, c.personality, c.speech, c.notes, (c.tags || []).join(' ')].filter(Boolean).join(' ');
      if (hit(hay)) result.characters.push({ item: c, snippet: c.description || c.role || c.name });
    }
    for (const l of p.locations || []) {
      const hay = [l.name, l.description, l.atmosphere, l.notes, l.timeOfDay, (l.tags || []).join(' ')].filter(Boolean).join(' ');
      if (hit(hay)) result.locations.push({ item: l, snippet: l.description || l.atmosphere || l.name });
    }
    for (const v of p.variables || []) {
      const hay = [v.name, v.description].filter(Boolean).join(' ');
      if (hit(hay)) result.variables.push({ item: v, snippet: v.description || v.name });
    }
    return result;
  }

  function renderSearch() {
    const m = collectMatches(searchQuery);
    const total = m.nodes.length + m.characters.length + m.locations.length + m.variables.length;
    const head = `<div class="panel-head">
      <span class="panel-title">${uiText("Поиск", "Search")}</span>
      <div class="grow"></div>
      ${searchQuery.trim().length >= 2 ? `<span class="count-pill">${total}</span>` : ''}
    </div>`;

    let html = `${head}<div class="search-wrap">
      <input id="panelSearchInput" class="input input-sm" type="search" placeholder="${uiText("Текст, имена, заметки… (или", "Text, names, notes… (or")} regex)" value="${esc(searchQuery)}" autocomplete="off" />
      <label class="checkbox search-regex" title="${uiText("Искать регулярным выражением", "Use regular expressions")}"><input id="panelSearchRegex" type="checkbox"${searchRegex ? ' checked' : ''} /> regex</label>
    </div>`;

    html += uiText("<p class=\"wb-search-tip\">Фильтры: type:, chapter:, speaker:, location:, tag:. Например, speaker:Марк</p>", "<p class=\"wb-search-tip\">Filters: type:, chapter:, speaker:, location:, tag:. Example: speaker:Марк</p>");
    if (searchQuery.trim().length >= 2 && !m.invalid) html += uiText("<div class=\"wb-search-tools\"><button class=\"btn btn-sm\" data-save-query>В закладки</button><button class=\"btn btn-sm\" data-table-query>В таблицу</button></div>", "<div class=\"wb-search-tools\"><button class=\"btn btn-sm\" data-save-query>Bookmark</button><button class=\"btn btn-sm\" data-table-query>Open in table</button></div>");
    if (m.invalid) {
      return html + `<div class="empty">${uiText("Некорректное регулярное выражение", "Invalid regular expression")}:<br /><code>${esc(m.invalid)}</code></div>`;
    }
    if (searchQuery.trim().length < 2) {
      return html + `<div class="empty">${uiText("Введите минимум два символа", "Enter at least two characters")}.<br />${uiText("Ищет по тексту узлов, вариантам, заметкам, персонажам, локациям и переменным", "Searches node text, choices, notes, characters, locations and variables")}.</div>`;
    }
    if (!total) return html + `<div class="empty">${uiText("Ничего не найдено. Проверьте текст или значения фильтров", "No results. Check the text or filter values")}.</div>`;

    const q = m.text;
    const group = (title, rows) => (rows.length ? `<div class="search-group"><div class="search-group-title">${title} · ${rows.length}</div>${rows.join('')}</div>` : '');

    html += group(
      uiText("Узлы", "Nodes"),
      m.nodes.map(
        ({ node, snippet }) =>
          `<button class="list-item" type="button" data-node="${esc(node.id)}">
            ${typeIcon(node.type)}
            <span class="li-main">
              <span class="li-title">${ui.highlight(snippet, q, { regex: searchRegex })}</span>
              <span class="li-sub">${esc(TYPE_LABELS[node.type] || node.type)} · ${esc(node.id)}${node.type === 'line' && node.speakerId ? ` · ${esc(nodeSpeakerName(project(), node))}` : ''}</span>
            </span>
          </button>`,
      ),
    );
    html += group(
      uiText("Персонажи", "Characters"),
      m.characters.map(
        ({ item, snippet }) =>
          `<button class="list-item" type="button" data-entity="character:${esc(item.id)}">
            <span class="dot" style="--dot:${esc(item.color || '#9aa6b6')}"></span>
            <span class="li-main"><span class="li-title">${ui.highlight(item.name, q, { regex: searchRegex })}</span>
            <span class="li-sub">${ui.highlight(snippet || '', q, { regex: searchRegex })}</span></span>
          </button>`,
      ),
    );
    html += group(
      uiText("Локации", "Locations"),
      m.locations.map(
        ({ item, snippet }) =>
          `<button class="list-item" type="button" data-entity="location:${esc(item.id)}">
            <span class="li-main"><span class="li-title">${ui.highlight(item.name, q, { regex: searchRegex })}</span>
            <span class="li-sub">${ui.highlight(snippet || '', q, { regex: searchRegex })}</span></span>
          </button>`,
      ),
    );
    html += group(
      uiText("Переменные", "Variables"),
      m.variables.map(
        ({ item, snippet }) =>
          `<button class="list-item" type="button" data-entity="variable:${esc(item.id)}">
            <span class="li-main"><span class="li-title">${ui.highlight(item.name, q, { regex: searchRegex })}</span>
            <span class="li-sub">${ui.highlight(snippet || '', q, { regex: searchRegex })}</span></span>
          </button>`,
      ),
    );
    return html;
  }

  // ---------------------------------------------------------------- статистика

  function renderStats() {
    const s = stats();
    const all = nodes();
    const chs = chapters();

    const typeRows = Object.entries(TYPE_LABELS)
      .map(([type, label]) => {
        const cnt = (s.byType && s.byType[type]) || all.filter((n) => n.type === type).length;
        return { label, cnt };
      })
      .filter((r) => r.cnt > 0);
    const typeMax = Math.max(1, ...typeRows.map((r) => r.cnt));

    const speakers = Array.isArray(s.bySpeaker) ? s.bySpeaker : [];
    const spMax = Math.max(1, ...speakers.map((x) => x.words || 0));

    const chapterRows = Array.isArray(s.chapters) && s.chapters.length
      ? s.chapters
      : chs.map((c) => {
          const list = all.filter((n) => n.chapterId === c.id);
          return { id: c.id, name: c.name, nodes: list.length, words: list.reduce((sum, n) => sum + countWords(n.text), 0) };
        });
    const chMax = Math.max(1, ...chapterRows.map((r) => r.nodes || 0));

    const issuesCount = issues.length;
    const errCount = issues.filter((i) => i.severity === 'error').length;

    const card = (value, label, extra = '') => `<div class="stat-card"><div class="stat-value">${value}</div><div class="stat-label">${esc(label)}</div>${extra}</div>`;

    return `<div class="panel-head">
      <span class="panel-title">${uiText("Статистика", "Statistics")}</span>
      <div class="grow"></div>
      <button class="btn btn-sm btn-ghost" type="button" data-act="revalidate">${uiText("Обновить", "Refresh")}</button>
    </div>
    <div class="stat-grid">
      ${card(s.nodes ?? all.length, uiText("узлов", "nodes"))}
      ${card(s.lines ?? 0, uiText("реплик", "lines"))}
      ${card(s.words ?? 0, uiText("слов", "words"))}
      ${card(s.choices ?? 0, uiText("выборов", "choices"))}
      ${card(s.endings ?? 0, uiText("концовок", "endings"))}
      ${card(s.minutes ?? 0, uiText("минут чтения", "min read"))}
    </div>
    <div class="stat-line">
      <span class="chip${errCount ? ' bad' : ' good'}">${errCount} ${plural(errCount, [uiText("ошибка", "error"), uiText("ошибки", "errors"), uiText("ошибок", "errors")])}</span>
      <span class="chip">${issuesCount - errCount} ${plural(issuesCount - errCount, [uiText("замечание", "issue"), uiText("замечания", "issues"), uiText("замечаний", "issues")])}</span>
      <span class="chip">${s.unreachable || 0} ${uiText("недостижимых", "unreachable")}</span>
      <span class="chip">${uiText("глубина", "depth")} ${s.longestChain || 0}</span>
    </div>

    <div class="card">
      <div class="card-head"><span class="card-title">${uiText("Узлы по типам", "Nodes by type")}</span></div>
      ${typeRows
        .map(
          (r) => `<div class="bar-row">
            <span class="bar-name">${esc(r.label)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${Math.round((r.cnt / typeMax) * 100)}%"></span></span>
            <span class="bar-value">${r.cnt}</span>
          </div>`,
        )
        .join('') || uiText("<div class=\"hint-text\">Нет данных.</div>", "<div class=\"hint-text\">No data.</div>")}
    </div>

    <div class="card">
      <div class="card-head"><span class="card-title">${uiText("Слова по персонажам", "Words by character")}</span></div>
      ${speakers
        .map(
          (sp) => `<div class="bar-row">
            <span class="bar-name"><span class="dot" style="--dot:${esc(sp.color || '#9aa6b6')}"></span>${esc(sp.name)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${Math.round(((sp.words || 0) / spMax) * 100)}%"></span></span>
            <span class="bar-value">${sp.words || 0}</span>
          </div>`,
        )
        .join('') || uiText("<div class=\"hint-text\">Нет реплик.</div>", "<div class=\"hint-text\">No lines.</div>")}
    </div>

    <div class="card">
      <div class="card-head"><span class="card-title">${uiText("Главы", "Chapters")}</span></div>
      ${chapterRows
        .map(
          (r) => `<div class="bar-row">
            <span class="bar-name">${esc(r.name)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${Math.round(((r.nodes || 0) / chMax) * 100)}%"></span></span>
            <span class="bar-value">${r.nodes || 0}</span>
          </div>`,
        )
        .join('') || uiText("<div class=\"hint-text\">Глав нет.</div>", "<div class=\"hint-text\">No chapters.</div>")}
    </div>`;
  }

  // ---------------------------------------------------------------- рендер

  function render() {
    if (!root) return;
    const wasSearchFocused = tab === 'search' && document.activeElement && document.activeElement.id === 'panelSearchInput';
    let html = '';
    if (tab === 'script') html = renderScript();
    else if (tab === 'characters') html = renderCharacters();
    else if (tab === 'locations') html = renderLocations();
    else if (tab === 'variables') html = renderVariables();
    else if (tab === 'search') html = renderSearch();
    else if (tab === 'bookmarks') html = ui.workbench?.renderBookmarks() || '';
    else if (tab === 'stats') html = renderStats();
    root.innerHTML = html;

    // активная вкладка
    document.querySelectorAll('#leftTabs .tab').forEach((btn) => {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });

    wire(wasSearchFocused || searchFocus);
    searchFocus = false;
  }

  function wire(focusSearchInput) {
    root.querySelector('[data-save-query]')?.addEventListener('click',()=>ui.workbench.markSearch(searchQuery,searchRegex));
    root.querySelector('[data-table-query]')?.addEventListener('click',()=>ui.workbench.openTable(searchQuery,searchRegex));
    root.querySelectorAll('[data-wb-mark]').forEach(b=>b.onclick=()=>ui.workbench.openMark(Number(b.dataset.wbMark)));
    root.querySelectorAll('[data-rm-mark]').forEach(b=>b.onclick=()=>ui.workbench.removeMark(Number(b.dataset.rmMark)));
    // узлы
    root.querySelectorAll('[data-node]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if(tab==='search'||(ui.workbench && ui.workbench.current()!=='graph'))ui.workbench.openNode(btn.dataset.node);
        else ui.selectNode(btn.dataset.node);
      });
      btn.addEventListener('dblclick', () => {
        ui.workbench.openNode(btn.dataset.node);
      });
    });

    // сущности
    root.querySelectorAll('[data-entity]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const [kind, id] = btn.dataset.entity.split(':');
        ui.workbench.openEntity(kind,id);
      });
    });

    // главы
    root.querySelectorAll('[data-ch-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.chToggle;
        const ch = chapters().find((c) => c.id === id);
        if (!ch) return;
        store.apply([{ op: 'updateChapter', id, patch: { collapsed: !ch.collapsed } }], { label: uiText("Свернуть главу", "Collapse chapter") });
      });
    });
    root.querySelectorAll('[data-ch-open]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.chOpen;
        if (!id) return;
        ui.selectEntity('chapter', id);
      });
    });
    root.querySelectorAll('[data-ch-add]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const chapterId = btn.dataset.chAdd;
        const res = store.apply([{ op: 'createNode', node: { type: 'line', chapterId } }], { label: uiText("Новый узел", "New node") });
        const id = res?.created?.[0];
        if (id) {
          ui.selectNode(id);
          ui.inspector?.focusNode(id);
        }
      });
    });

    root.querySelector('[data-act="add-chapter"]')?.addEventListener('click', () => {
      const n = chapters().length + 1;
      const res = store.apply([{ op: 'createChapter', chapter: { name: `${uiText("Глава", "Chapter")} ${n}` } }], { label: uiText("Новая глава", "New chapter") });
      const id = res?.created?.[0];
      if (id) ui.selectEntity('chapter', id);
    });

    root.querySelector('[data-act="add-character"]')?.addEventListener('click', () => {
      const res = store.apply([{ op: 'createCharacter', character: { name: uiText("Новый персонаж", "New character") } }], { label: uiText("Новый персонаж", "New character") });
      const id = res?.created?.[0];
      if (id) ui.selectEntity('character', id);
    });
    root.querySelector('[data-act="add-location"]')?.addEventListener('click', () => {
      const res = store.apply([{ op: 'createLocation', location: { name: uiText("Новая локация", "New location") } }], { label: uiText("Новая локация", "New location") });
      const id = res?.created?.[0];
      if (id) ui.selectEntity('location', id);
    });
    root.querySelector('[data-act="add-variable"]')?.addEventListener('click', () => {
      const res = store.apply([{ op: 'createVariable', variable: { name: 'new_variable', type: 'number', initial: 0 } }], { label: uiText("Новая переменная", "New variable") });
      const id = res?.created?.[0];
      if (id) ui.selectEntity('variable', id);
    });

    root.querySelector('[data-act="revalidate"]')?.addEventListener('click', () => {
      issues = safeValidate();
      render();
    });

    // поиск
    const input = root.querySelector('#panelSearchInput');
    if (input) {
      const run = ui.debounce(() => {
        searchQuery = input.value;
        const pos = input.selectionStart;
        render();
        const again = root.querySelector('#panelSearchInput');
        if (again) {
          again.focus();
          try {
            again.setSelectionRange(pos, pos);
          } catch {
            /* ignore */
          }
        }
      }, 75);
      input.addEventListener('input', run);
      const reBox = root.querySelector('#panelSearchRegex');
      if (reBox) {
        reBox.addEventListener('change', () => {
          searchRegex = reBox.checked;
          render();
          const again = root.querySelector('#panelSearchInput');
          if (again) again.focus();
        });
      }
      if (focusSearchInput) {
        input.focus();
        try {
          input.setSelectionRange(input.value.length, input.value.length);
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ---------------------------------------------------------------- валидация

  function safeValidate() {
    try {
      const list = validateProject(project());
      return Array.isArray(list) ? list.slice() : [];
    } catch (e) {
      console.error(uiText("[panels] validateProject упал:", "[panels] validateProject failed:"), e);
      return [{ severity: 'error', code: 'internal', message: `${uiText("Валидатор не смог отработать", "Validation could not complete")}: ${e.message}` }];
    }
  }

  function renderValidation() {
    const body = document.getElementById('validationBody');
    if (!body) return;
    const filtered = sev === 'all' ? issues : issues.filter((i) => i.severity === sev);
    filtered.sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3));

    if (!filtered.length) {
      body.innerHTML = `<div class="empty">${issues.length ? uiText("В этой категории ничего нет.", "Nothing in this category.") : uiText("Проблем не найдено — проект чистый.", "No issues found.")}</div>`;
      return;
    }

    body.innerHTML = filtered
      .map((issue, i) => {
        const clickable = !!issue.nodeId;
        return `<div class="sev-row${clickable ? ' clickable' : ''}" data-issue="${i}" data-node-id="${esc(issue.nodeId || '')}" title="${esc(issue.message)}">
          <span class="sev-mark sev-${esc(issue.severity)}">${issue.severity === 'error' ? '!' : issue.severity === 'warning' ? '!' : 'i'}</span>
          <span class="sev-text">${esc(issue.message)}</span>
          <span class="sev-code">${esc(issue.code)}</span>
        </div>`;
      })
      .join('');

    body.querySelectorAll('.sev-row[data-node-id]').forEach((row) => {
      const id = row.dataset.nodeId;
      if (!id) return;
      row.addEventListener('click', () => {
        ui.selectNode(id);
        ui.centerOn(id);
      });
    });
  }

  function showValidation() {
    if (ui.workbench && ui.workbench.current() !== 'graph') ui.workbench.openGraph();
    issues = safeValidate();
    const panel = document.getElementById('validationPanel');
    if (panel) panel.classList.remove('hidden');
    renderValidation();
    updateBadge();
    return issues;
  }

  function hideValidation() {
    const panel = document.getElementById('validationPanel');
    if (panel) panel.classList.add('hidden');
  }

  function toggleValidation() {
    const panel = document.getElementById('validationPanel');
    if (!panel) return;
    if (panel.classList.contains('hidden')) showValidation();
    else hideValidation();
  }

  function updateBadge() {
    const badge = document.getElementById('badgeIssues');
    if (!badge) return;
    const err = issues.filter((i) => i.severity === 'error').length;
    const warn = issues.filter((i) => i.severity === 'warning').length;
    if (!issues.length) {
      badge.textContent = '0';
      badge.className = 'badge badge-ok';
      badge.title = uiText("Проблем не найдено", "No issues found");
      return;
    }
    badge.textContent = String(issues.length);
    badge.className = `badge ${err ? 'badge-bad' : warn ? 'badge-warn' : ''}`.trim();
    badge.title = `${err} ${uiText("ошибок", "errors")}, ${warn} ${uiText("предупреждений", "warnings")}`;
  }

  // ---------------------------------------------------------------- вкладки

  function setTab(next) {
    if (!TAB_ORDER.includes(next)) return;
    tab = next;
    const menu=document.getElementById('projectSections');
    if(menu)menu.open=false;
    render();
  }

  function getTab() {
    return tab;
  }

  function focusSearch(query,regex) {
    tab = 'search';
    if(typeof regex==='boolean')searchRegex=regex;
    document.getElementById('leftPanel').classList.remove('collapsed');
    if (typeof query === 'string') searchQuery = query;
    searchFocus = true;
    render();
    const input = root.querySelector('#panelSearchInput');
    if (input) {
      input.focus();
      input.select();
    }
  }

  // ---------------------------------------------------------------- инициализация

  function init() {
    if (wired) return;
    wired = true;
    document.querySelectorAll('#leftTabs .tab').forEach((btn) => {
      btn.addEventListener('click', () => setTab(btn.dataset.tab));
    });
    const filter = document.getElementById('sevFilter');
    filter?.querySelectorAll('button[data-sev]').forEach((btn) => {
      btn.addEventListener('click', () => {
        sev = btn.dataset.sev;
        filter.querySelectorAll('button[data-sev]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        renderValidation();
      });
    });
    document.getElementById('btnCloseValidation')?.addEventListener('click', hideValidation);
    issues = safeValidate();
    updateBadge();
  }

  init();

  return {
    render,
    setTab,
    getTab,
    focusSearch,
    showValidation,
    hideValidation,
    toggleValidation,
    getIssues: () => issues,
    refreshIssues: () => {
      issues = safeValidate();
      updateBadge();
      return issues;
    },
  };
}
