import { t as uiText } from './i18n.js';
import { icon } from './icons.js';
import { validateProject } from './model.js';
import { entityLists, nodeTitle, jumpCandidates, rankCandidates } from './story-search.js';
import { createScenarioTable } from './scenario-table.js';
import { renderDocument } from './scene-document.js';
import { createScreenplayEditor } from './screenplay.js';

export function createWorkbench(store, ui) {
  const esc = ui.escapeHTML;
  const $ = (id) => document.getElementById(id);
  const tabsHost = $('documentTabs'),
    page = $('workspacePage');
  const tableDefaults = () => ({
    kind: 'table',
    query: '',
    group: '',
    sort: 'title',
    desc: false,
    columns: ['type', 'chapter', 'speaker', 'location', 'issues'],
    offset: 0,
  });
  const tabIcons = {graph:'layout', overview:'graph', table:'table', screenplay:'edit', empty:'file', node:'file', chapter:'folder', character:'user', location:'pin', variable:'hash'};
  const renderScreenplay = createScreenplayEditor(store, ui);
  let trail = [], cursor = -1, lastLocation = '';
  let overviewTab = null, overviewOrigin = null;
  let tabs = [],
    active,
    settings,
    key = '',
    jump = null,
    drawRequest = 0,
    issues = null;
  function storageKey() {
    return (
      'storyforge/workspace/2/' +
      (store.filePath?.replaceAll('\\', '/').toLowerCase() ||
        store.documentKey ||
        'draft/' + store.project.meta.createdAt)
    );
  }
  function persist() {
    key = storageKey();
    try {
      localStorage.setItem(key, JSON.stringify(settings));
    } catch {
      ui.toast(uiText("Не удалось сохранить настройки рабочего места", "Could not save workspace settings"), 'warn');
    }
  }
  function reset() {
    if (jump) jump.close();
    key = storageKey();
    try {
      settings = JSON.parse(localStorage.getItem(key)) || {};
    } catch {
      settings = {};
    }
    for (const k of ['bookmarks', 'recents', 'views']) if (!Array.isArray(settings[k])) settings[k] = [];
    tabs = [{ kind: 'graph' }, tableDefaults(), { kind: 'screenplay' }];
    active = tabs[0];
    overviewTab = null;
    overviewOrigin = null;
    trail = [active];
    cursor = 0;
    lastLocation = '';
    issues = null;
    ui.visualizer?.close();
    render();
  }
  function title(t) {
    if (t.kind === 'graph') return uiText("Схема", "Canvas");
    if (t.kind === 'overview') return uiText("Обзор сюжета", "Story overview");
    if (t.kind === 'table') return uiText("Таблица", "Table");
    if (t.kind === 'screenplay') return uiText("Сценарий", "Screenplay");
    if (t.kind === 'empty') return uiText("Новая вкладка", "New tab");
    const obj = store.project[entityLists[t.kind]]?.find((x) => x.id === t.id);
    return obj ? (t.kind === 'node' ? nodeTitle(obj) : obj.name) : uiText("Удалено", "Deleted");
  }
  function historyState() {
    return { back: cursor > 0, forward: cursor < trail.length - 1 };
  }
  function currentLocation() {
    const n = active.kind === 'node' && store.project.nodes.find(node => node.id === active.id);
    return {
      kind: active.kind, id: active.id || '', title: active.kind === 'table' ? uiText("Таблица сценария", "Story table") : title(active),
      chapter: n ? store.project.chapters.find(chapter => chapter.id === n.chapterId)?.name || '' : ''
    };
  }
  function visit(tab) {
    if (trail[cursor] === tab) return;
    trail.splice(cursor + 1);
    trail.push(tab);
    if (trail.length > 80) trail.shift();
    cursor = trail.length - 1;
  }
  function navigate(delta) {
    const next = cursor + delta;
    if (next < 0 || next >= trail.length) return false;
    cursor = next;
    const destination = trail[cursor];
    if (!tabs.includes(destination)) {
      const slot = tabs.findIndex(t => t.slot && t.slot === destination.slot);
      if (slot >= 0) tabs[slot] = destination;
      else tabs.push(destination);
    }
    activate(destination, false);
    return true;
  }
  function drawTabs() {
    const location = currentLocation();
    tabsHost.innerHTML = tabs.map((t, i) => {
      const label = esc(title(t));
      return `<span class="wb-tab${active === t ? ' active' : ''}"><button type="button" data-tab-index="${i}" data-tab-kind="${t.kind}" ${active === t ? 'aria-current="page"' : ''} title="${label}">${icon(tabIcons[t.kind], 14)}<span class="wb-tab-label">${label}</span></button>${i >= 3 ? `<button type="button" data-close-tab="${i}" class="wb-tab-x" aria-label="${uiText("Закрыть вкладку", "Close tab")} ${label}">${icon('close', 12)}</button>` : ''}</span>`;
    }).join('');
    const detail = { ...location, ...historyState() };
    const signature = JSON.stringify(detail);
    if (lastLocation !== signature) {
      lastLocation = signature;
      tabsHost.dispatchEvent(new CustomEvent('workspace:navigate', {bubbles:true, detail}));
    }
  }
  function issueList() {
    return issues || (issues = validateProject(store.project));
  }
  function render() {
    page.dataset.view = active.kind;
    drawTabs();
    const graph = active.kind === 'graph';
    const canvas = graph || active.kind === 'overview';
    if (!graph) ui.panels?.hideValidation?.();
    $('graphHost').classList.toggle('hidden', !graph);
    $('graphFilters').classList.toggle('hidden', !graph);
    page.classList.toggle('hidden', canvas);
    page.onclick = null;
    if (canvas) {
      page.replaceChildren();
      return;
    }
    if (active.kind === 'table')
      createScenarioTable({
        store,
        ui,
        tab: active,
        page,
        openNode,
        openGraph,
        saveView,
        views: settings.views,
        applyView,
        getIssues: issueList,
      });
    else if (active.kind === 'screenplay') renderScreenplay(page, active);
    else if (active.kind === 'empty') {
      page.innerHTML = `<nav class="wb-start" aria-label="${uiText("Действия новой вкладки", "New tab actions")}">
        <button type="button" data-start="create">${icon('edit', 17)}<span>${uiText("Создать реплику", "Create line")}</span></button>
        <button type="button" data-start="find">${icon('search', 17)}<span>${uiText("Открыть сцену", "Open scene")}</span><kbd>Ctrl K</kbd></button>
        <button type="button" data-start="table">${icon('table', 17)}<span>${uiText("Открыть таблицу", "Open table")}</span></button>
        <button type="button" data-start="screenplay">${icon('edit', 17)}<span>${uiText("Открыть сценарий", "Open screenplay")}</span></button>
      </nav>`;
      page.onclick = (e) => {
        switch (e.target.closest('[data-start]')?.dataset.start) {
          case 'find':
            quickJump();
            break;
          case 'create':
            createLine();
            break;
          case 'table':
            openTable();
            break;
          case 'screenplay':
            openScreenplay();
            break;
        }
      };
    } else
      renderDocument({
        page,
        tab: active,
        store,
        ui,
        openNode,
        openGraph,
        bookmark: toggleNodeMark,
        isMarked,
        openEntity,
        openPlayer,
      });
    page.scrollTop = active.scroll || 0;
  }
  function record(t) {
    if (!t.id) return;
    settings.recents = [
      { kind: t.kind, id: t.id },
      ...settings.recents.filter((x) => x.kind !== t.kind || x.id !== t.id),
    ].slice(0, 35);
    persist();
  }
  function activate(t, recordVisit = true) {
    if (!t) return;
    ui.flushEdits?.();
    ui.voice?.stop?.();
    if (active && active !== t) {
      active.selection = { ...store.selection };
      active.scroll = page.scrollTop;
      if (active.kind === 'graph') active.camera = ui.graph?.getView?.();
      if (t.kind === 'overview') overviewOrigin = active;
    }
    // Mark the destination first so closing the previous canvas cannot navigate back recursively.
    active = t;
    if (t.kind !== 'overview') ui.visualizer?.close();
    if (recordVisit) visit(t);
    const select = t.id ? { kind: t.kind, id: t.id } : t.selection;
    if (select) {
      const exists = !select.id || store.project[entityLists[select.kind]]?.some((o) => o.id === select.id);
      store.setSelection(exists ? select : {kind:null, id:null});
    }
    if (t.id) {
      record(t);
      ui.setRightTab('inspector');
      ui.inspector?.render();
    }
    render();
    if (t.kind === 'graph' && t.camera) ui.graph?.setView?.(t.camera);
    tabsHost.querySelector('.wb-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (t.kind === 'overview') ui.visualizer.open();
    else if (t.kind === 'screenplay') $('screenplayText').focus({ preventScroll: true });
    else if (t.kind !== 'graph') page.focus({ preventScroll: true });
  }
  function openEntity(kind, id, forceNew = false) {
    if (!entityLists[kind]) return;
    let t = !forceNew && tabs.find((t) => t.kind === kind && t.id === id);
    if (!t) {
      t = { kind, id };
      if (kind === 'node') t.lastChapterId = store.project.nodes.find((node) => node.id === id)?.chapterId;
      const index = tabs.indexOf(active);
      if ((active.kind === 'empty' || entityLists[active.kind]) && !forceNew) {
        active.slot ||= Symbol('document');
        t.slot = active.slot;
        tabs[index] = t;
      } else tabs.push(t);
    }
    activate(t);
  }
  function openNode(id, forceNew = false) {
    openEntity('node', id, forceNew);
  }
  function openGraph(id) {
    activate(tabs[0]);
    if (id && store.project.nodes.some((n) => n.id === id)) {
      ui.selectNode(id);
      ui.graph?.centerOn(id);
    }
  }
  function openOverview() {
    if (!ui.visualizer) return;
    if (!overviewTab) overviewTab = {kind:'overview'};
    if (!tabs.includes(overviewTab)) tabs.push(overviewTab);
    if (active !== overviewTab) activate(overviewTab);
    else ui.visualizer.open();
  }
  function returnFromOverview() {
    if (active !== overviewTab || !overviewTab) return;
    const origin = overviewOrigin && tabs.includes(overviewOrigin) ? overviewOrigin : tabs[0];
    if (trail[cursor-1] === origin) navigate(-1);
    else if (trail[cursor+1] === origin) navigate(1);
    else activate(origin);
  }
  function toggleOverview() {
    if (ui.visualizer?.isOpen()) ui.visualizer.close();
    else openOverview();
  }
  ui.onVisualizerClose = returnFromOverview;
  function openTable(query, regex = false) {
    const t = tabs[1];
    if (typeof query === 'string') {
      if (t.query !== query || t.regex !== regex) t.viewName = '';
      t.query = query;
      t.regex = regex;
      t.filterOpen = Boolean(query || regex);
      t.offset = 0;
      t.tableScroll = 0;
    }
    activate(t);
  }
  function openScreenplay() {
    activate(tabs[2]);
  }
  function openPlayer(id) {
    ui.flushEdits?.();
    ui.playBranch?.(id);
  }
  function createLine() {
    const r = store.apply([{ op: 'createNode', node: { type: 'line' } }], { label: uiText("Создать реплику", "Create line") });
    if (r.ok) openNode(r.created[0]);
    else ui.toast(r.error, 'bad');
  }
  function daily() {
    const now = new Date(),
      date = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
      ].join('-');
    const tag = 'journal/' + date;
    let found = store.project.nodes.find((n) => n.type === 'note' && n.tags.includes(tag));
    if (found) return openNode(found.id);
    const res = store.apply([{ op: 'createNode', node: { type: 'note', title: date, tags: [tag] } }], {
      label: uiText("Заметка за сегодня", "Today's note"),
    });
    if (res.ok) openNode(res.created[0]);
    else ui.toast(res.error, 'bad');
  }
  function isMarked(id) {
    return settings.bookmarks.some((b) => b.kind === 'node' && b.id === id);
  }
  function toggleNodeMark(id) {
    if (isMarked(id)) settings.bookmarks = settings.bookmarks.filter((b) => b.kind !== 'node' || b.id !== id);
    else settings.bookmarks.push({ kind: 'node', id });
    persist();
    if (ui.panels?.getTab() === 'bookmarks') ui.panels.render();
  }
  function markSearch(query, regex) {
    if (!query.trim()) return;
    if (!settings.bookmarks.some((x) => x.kind === 'search' && x.query === query && x.regex === regex))
      settings.bookmarks.push({ kind: 'search', query, regex });
    persist();
    ui.toast(uiText("Запрос добавлен в закладки", "Search bookmarked"), 'good');
  }
  function renderBookmarks() {
    if (!settings.bookmarks.length)
      return uiText("<div class=\"panel-head\"><strong>Закладки</strong></div><p class=\"hint-text\">Закрепите сцену в текстовой вкладке или запрос в поиске.</p>", "<div class=\"panel-head\"><strong>Bookmarks</strong></div><p class=\"hint-text\">Bookmark a scene from its text tab or a query from search.</p>");
    return (
      uiText("<div class=\"panel-head\"><strong>Закладки</strong></div>", "<div class=\"panel-head\"><strong>Bookmarks</strong></div>") +
      settings.bookmarks
        .map((b, i) => {
          const n = b.kind === 'node' && store.project.nodes.find((n) => n.id === b.id);
          return `<div class="wb-mark"><button data-wb-mark="${i}" class="list-item"><span class="li-main"><b class="li-title">${esc(b.kind === 'search' ? b.query : n ? nodeTitle(n) : uiText("Удалённый узел", "Deleted node"))}</b><small>${b.kind === 'search' ? (b.regex ? uiText("Поиск · regex", "Search · regex") : uiText("Поиск", "Search")) : esc(b.id)}</small></span></button><button class="tb-icon" title="${uiText("Удалить закладку", "Remove bookmark")}" aria-label="${uiText("Удалить закладку", "Remove bookmark")}" data-rm-mark="${i}">×</button></div>`;
        })
        .join('')
    );
  }
  function openMark(i) {
    const b = settings.bookmarks[i];
    if (!b) return;
    if (b.kind === 'node') openNode(b.id);
    else ui.panels.focusSearch(b.query, b.regex);
  }
  function removeMark(i) {
    settings.bookmarks.splice(i, 1);
    persist();
    ui.panels.render();
  }
  function saveView() {
    const t = tabs[1],
      before = document.activeElement;
    const body = ui.el(uiText("<label class=\"wb-field\">Название вида<input class=\"input\" maxlength=\"80\" /></label>", "<label class=\"wb-field\">View name<input class=\"input\" maxlength=\"80\" /></label>")),
      input = body.querySelector('input');
    input.value = t.viewName || t.query || uiText("Мой вид", "My view");
    const save = (api) => {
      const name = input.value.trim();
      if (!name) {
        input.focus();
        return;
      }
      const value = {
        name,
        query: t.query,
        regex: !!t.regex,
        columns: [...t.columns],
        group: t.group,
        sort: t.sort,
        desc: t.desc,
      };
      settings.views = [...settings.views.filter((v) => v.name !== name), value];
      t.viewName = name;
      persist();
      api.close();
      render();
      ui.toast(uiText("Вид сохранён", "View saved"), 'good');
    };
    const m = ui.modal({
      title: uiText("Сохранить вид таблицы", "Save table view"),
      body,
      buttons: [{ label: uiText("Отмена", "Cancel") }, { label: uiText("Сохранить", "Save"), kind: 'primary', onClick: save }],
      onClose: () => before?.focus(),
    });
    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        save(m);
      }
    };
    input.select();
  }
  function applyView(view) {
    Object.assign(tabs[1], {
      viewName: view.name,
      filterOpen: Boolean(view.query || view.regex),
      query: view.query,
      regex: !!view.regex,
      columns: [...view.columns],
      group: view.group,
      sort: view.sort,
      desc: view.desc,
      offset: 0,
      tableScroll: 0,
    });
    openTable();
  }
  function quickJump() {
    if (jump) return;
    const previous = document.activeElement;
    const candidates = jumpCandidates(store.project);
    let rows = [],
      index = 0;
    const body = ui.el(
      `<div class="wb-switch">
        <div class="wb-switch-field">${icon('search',19)}<input type="search" id="jumpInput" class="input" aria-label="${uiText("Поиск сущности проекта", "Find a project item")}" placeholder="${uiText("Найти сцену, главу, персонажа", "Find a scene, chapter or character")}…" role="combobox" aria-autocomplete="list" aria-controls="jumpList" aria-expanded="true"/></div>
        <div id="jumpList" role="listbox" aria-label="${uiText("Результаты поиска", "Search results")}"></div>
        <footer><span><kbd>↑</kbd><kbd>↓</kbd> ${uiText("выбрать", "select")}</span><span><kbd>Enter</kbd> ${uiText("открыть", "open")}</span><span><kbd>Ctrl Enter</kbd> ${uiText("в новой вкладке", "in a new tab")}</span></footer>
      </div>`,
    );
    const input = body.querySelector('input'),
      list = body.querySelector('#jumpList');
    const m = ui.modal({
      title: uiText("Быстрый переход", "Quick switcher"),
      body,
      onClose: () => {
        jump = null;
        previous?.focus?.();
      },
    });
    m.body.closest('.modal-card').classList.add('wb-switch-dialog');
    function paint() {
      list.innerHTML =
        rows
          .map(
            (r, i) =>
              `<button type="button" role="option" id="jumpRow${i}" aria-selected="${i === index}" tabindex="-1" data-jump="${i}">${icon(tabIcons[r.kind], 16)}<span class="wb-result-copy"><b>${esc(r.title)}</b><small>${esc(r.context)}</small></span><code>${esc(r.id)}</code></button>`,
          )
          .join('') || uiText("<p class=\"hint-text\">Совпадений нет.</p>", "<p class=\"hint-text\">No matches.</p>");
      if (rows.length) {
        input.setAttribute('aria-activedescendant', 'jumpRow' + index);
        list.children[index]?.scrollIntoView({ block: 'nearest' });
      } else input.removeAttribute('aria-activedescendant');
    }
    function find() {
      rows = rankCandidates(candidates, input.value, settings.recents);
      index = 0;
      paint();
    }
    function accept(force) {
      const r = rows[index];
      if (r) {
        m.close();
        openEntity(r.kind, r.id, force);
      }
      return true;
    }
    jump = { close: m.close, accept };
    list.onclick = (e) => {
      const b = e.target.closest('[data-jump]');
      if (b) {
        index = Number(b.dataset.jump);
        accept(e.ctrlKey || e.metaKey);
      }
    };
    input.oninput = find;
    input.onkeydown = (e) => {
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') m.close();
      else if (e.key === 'Enter') accept(e.ctrlKey || e.metaKey);
      else if (rows.length) {
        index = (index + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
        paint();
      }
    };
    find();
    input.focus();
  }
  function actions() {
    const body = ui.el(
      uiText("<div class=\"wb-action-list\"><button data-go=\"play\">Пройти от начала</button><button data-go=\"screenplay\">Открыть сценарий</button><button data-go=\"daily\">Заметка за сегодня</button><button data-go=\"overview\">Обзор сюжета</button><button data-go=\"find\">Быстрый переход</button></div>", "<div class=\"wb-action-list\"><button data-go=\"play\">Play from the start</button><button data-go=\"screenplay\">Open screenplay</button><button data-go=\"daily\">Today's note</button><button data-go=\"overview\">Story overview</button><button data-go=\"find\">Quick switcher</button></div>"),
    );
    const m = ui.modal({ title: uiText("Действия проекта", "Project actions"), body, onClose: () => $('workspaceActions').focus() });
    body.onclick = (e) => {
      const act = e.target.closest('button')?.dataset.go;
      if (!act) return;
      m.close();
      if (act === 'play') openPlayer();
      else if (act === 'screenplay') openScreenplay();
      else if (act === 'daily') daily();
      else if (act === 'overview') openOverview();
      else quickJump();
    };
  }
  tabsHost.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-close-tab')) {
      const i = Number(b.dataset.closeTab),
        was = active === tabs[i];
      if (was && tabs[i] === overviewTab) {
        ui.visualizer?.close();
        returnFromOverview();
        tabs.splice(i, 1);
        drawTabs();
      } else {
        tabs.splice(i, 1);
        if (was) activate(tabs[Math.max(0, i - 1)]);
        else drawTabs();
      }
      return;
    }
    activate(tabs[Number(b.dataset.tabIndex)]);
  };
  $('newWorkspaceTab').onclick = () => {
    const t = { kind: 'empty' };
    tabs.push(t);
    activate(t);
  };
  $('workspaceActions').onclick = actions;
  $('readScene').onclick = () => {
    if (store.selection.kind === 'node') openNode(store.selection.id);
    else quickJump();
  };
  store.subscribe((evt) => {
    if (evt.type === 'project' && !evt.label) {
      reset();
      return;
    }
    if (storageKey() !== key) persist();
    if (evt.type === 'selection') {
      const sel = store.selection;
      document.querySelector('#leftBody .list-item.active')?.classList.remove('active');
      if (sel.id) {
        const attr = sel.kind === 'node' ? 'data-node' : 'data-entity';
        const value = sel.kind === 'node' ? sel.id : sel.kind + ':' + sel.id;
        document
          .querySelector('#leftBody [' + attr + '="' + CSS.escape(value) + '"]')
          ?.classList.add('active');
      }
      if (sel?.id && entityLists[active.kind] && (sel.kind !== active.kind || sel.id !== active.id)) {
        const generation = store.generation;
        queueMicrotask(() => {
          if (
            generation === store.generation &&
            store.selection.id === sel.id &&
            entityLists[active.kind] &&
            (active.id !== sel.id || active.kind !== sel.kind)
          )
            openEntity(sel.kind, sel.id);
        });
      }
      return;
    }
    if (evt.scope === 'screenplay') {
      if (active.kind === 'screenplay') renderScreenplay(page, active);
      return;
    }
    issues = null;
    // Retain the last known chapter even when a background tab's scene is moved and then deleted.
    for (const tab of tabs) {
      if (tab.kind !== 'node') continue;
      const node = store.project.nodes.find((entry) => entry.id === tab.id);
      if (node) tab.lastChapterId = node.chapterId;
    }
    if (active.kind === 'screenplay') {
      if (tabs.length > 3) drawTabs();
      renderScreenplay(page, active);
      return;
    }
    if (drawRequest) return;
    drawRequest = requestAnimationFrame(() => {
      drawRequest = 0;
      const focused = document.activeElement;
      if (active.kind === 'screenplay') return;
      if (active.kind === 'graph') {
        if (tabs.length > 3) drawTabs();
        return;
      }
      if (active.kind === 'node' && focused?.id === 'documentText') {
        const n = store.project.nodes.find((n) => n.id === active.id);
        if (n && n.text === focused.value) {
          drawTabs();
          return;
        }
      }
      const id = page.contains(focused) && focused.id,
        caret = id && focused.selectionStart;
      active.scroll = page.scrollTop;
      render();
      if (id) {
        const field = $(id);
        field?.focus({ preventScroll: true });
        if (caret != null && field?.setSelectionRange) field.setSelectionRange(caret, caret);
      }
    });
  });
  const narrow = window.matchMedia('(max-width:1120px)');
  let wideRight = !$('rightPanel').classList.contains('collapsed');
  narrow.addEventListener('change', () => {
    if (narrow.matches) {
      wideRight = !$('rightPanel').classList.contains('collapsed');
      $('rightPanel').classList.add('collapsed');
    } else $('rightPanel').classList.toggle('collapsed', !wideRight);
  });
  if (narrow.matches) $('rightPanel').classList.add('collapsed');
  reset();
  return {
    back: () => navigate(-1),
    forward: () => navigate(1),
    currentLocation,
    refreshLanguage() { issues = null; render(); },
    historyState,
    openNode,
    openEntity,
    openGraph,
    openOverview,
    toggleOverview,
    openTable,
    openScreenplay,
    openPlayer,
    quickJump,
    persist,
    markSearch,
    renderBookmarks,
    openMark,
    removeMark,
    daily,
    acceptJump: (force) => (jump ? jump.accept(force) : false),
    current: () => active.kind,
  };
}
