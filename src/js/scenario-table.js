import { t as uiText } from './i18n.js';
import { icon } from './icons.js';
import { TYPE_LABELS } from './model.js';
import { nodeTitle, compileNodeQuery } from './story-search.js';

export function createScenarioTable({
  store,
  ui,
  tab,
  page,
  openNode,
  openGraph,
  saveView,
  views,
  applyView,
  getIssues,
}) {
  const esc = ui.escapeHTML;
  const columns = {
    title: uiText("Название / реплика", "Title / line"),
    type: uiText("Тип", "Type"),
    chapter: uiText("Глава", "Chapter"),
    speaker: uiText("Спикер", "Speaker"),
    location: uiText("Локация", "Location"),
    tags: uiText("Теги", "Tags"),
    issues: uiText("Проблемы", "Issues"),
  };
  const p = store.project;
  const choices = (entries, selected) =>
    Object.entries(entries)
      .map(
        ([key, label]) =>
          `<option value="${esc(key)}"${key === selected ? ' selected' : ''}>${esc(label)}</option>`,
      )
      .join('');
  const btn = (action, label) =>
    `<button type="button" class="btn btn-sm" data-table="${action}">${label}</button>`;
  const groups = { '': uiText("Без группировки", "No grouping"), chapter:uiText("По главам", "By chapter"), speaker:uiText("По спикерам", "By speaker"), type:uiText("По типам", "By type"), location:uiText("По локациям", "By location") };
  const glyphs = {title:'file',type:'type',chapter:'folder',speaker:'user',location:'pin',tags:'hash',issues:'alert'};
  const tool = (name, glyph, label) =>
    `<button type="button" class="wb-control" data-table="${name}" title="${label}" aria-label="${label}">${icon(glyph,15)}<span>${label}</span></button>`;
  const popup = (name, glyph, label, content) =>
    `<details class="wb-popup wb-popup-${name}" name="workbench-table-tools"><summary class="wb-control" title="${label}" aria-label="${label}">${icon(glyph,15)}<span>${label}</span></summary><div class="wb-popover">${content}</div></details>`;
  const viewLabel = tab.viewName || uiText("Все узлы", "All nodes");
  const viewOptions = views.map((v, i) =>
    `<button type="button" data-view="${i}" role="menuitemradio" aria-checked="${v.name === tab.viewName}">${icon('table',15)}<span>${esc(v.name)}</span></button>`).join('');
  page.innerHTML = `<header class="wb-base-bar" aria-label="${uiText("Представление таблицы", "Table view")}">
    <details class="wb-popup wb-views" name="workbench-table-tools"><summary class="wb-control" aria-label="${uiText("Представление таблицы", "Table view")}" title="${uiText("Представление таблицы", "Table view")}">${icon('table',16)}<b id="tableViewName">${esc(viewLabel)}</b>${icon('chevronDown',13)}</summary>
      <div class="wb-popover" id="tableViews" role="menu" aria-label="${uiText("Представления таблицы", "Table views")}">
        <button type="button" data-table="default" role="menuitemradio" aria-checked="${!tab.viewName}">${icon('table',15)}<span>${uiText("Все узлы", "All nodes")}</span></button>
        ${viewOptions}<hr><button type="button" data-table="save">${icon('bookmark',15)}<span>${uiText("Сохранить вид", "Save view")}…</span></button>
      </div>
    </details>
    <span class="wb-count" id="tableCount" aria-live="polite"></span><div class="wb-base-spacer"></div>
    ${popup('sort','sort',uiText("Сортировка", "Sort"),`<label>${uiText("Сортировать по", "Sort by")}<select class="select" id="tableSort">${choices(columns,tab.sort)}</select></label><label>${uiText("Порядок", "Order")}<select class="select" id="tableDirection">${choices({asc:uiText("По возрастанию", "Ascending"),desc:uiText("По убыванию", "Descending")},tab.desc ? 'desc':'asc')}</select></label>`)}
    ${popup('group','group',uiText("Группа", "Group"),`<label>${uiText("Группировать", "Group by")}<select class="select" id="tableGroup">${choices(groups,tab.group)}</select></label>`)}
    ${tool('filter','filter',uiText("Фильтр", "Filter"))}
    ${popup('props','columns',uiText("Свойства", "Properties"),Object.entries(columns).filter(([k])=>k !== 'title').map(([k,v]) =>
      `<label class="wb-column-check"><input type="checkbox" data-col="${k}"${tab.columns.includes(k) ? ' checked' : ''}>${icon(glyphs[k],14)}${esc(v)}</label>`).join(''))}
    ${tool('new','plus',uiText("Реплика", "Line"))}
  </header>
  <div id="tableFilterBar" class="wb-filter-bar" ${(tab.filterOpen ?? Boolean(tab.query || tab.regex)) ? '' : 'hidden'}>
    ${icon('search',15)}<input class="input" type="search" id="tableQuery" aria-label="${uiText("Фильтр таблицы", "Table filter")}" placeholder="${uiText("Найти по тексту или speaker:Марк", "Find text or speaker:Марк")}" value="${esc(tab.query)}">
    <label class="wb-regex-toggle" title="${uiText("Регулярное выражение", "Regular expression")}"><input type="checkbox" id="tableRegex" aria-label="${uiText("Регулярное выражение", "Regular expression")}"${tab.regex ? ' checked' : ''}><span>.*</span></label>
  </div>
  <div id="tableBody" class="wb-table-scroll" tabindex="-1"></div><footer id="tablePages" class="wb-pages"></footer>`;
  const target = page.querySelector('#tableBody');
  const names = (items) => new Map((items || []).map((x) => [x.id, x.name]));
  const chapters = names(p.chapters),
    speakers = names(p.characters),
    locations = names(p.locations);
  const issuesByNode = new Map();
  for (const issue of getIssues())
    if (issue.nodeId) {
      if (!issuesByNode.has(issue.nodeId)) issuesByNode.set(issue.nodeId, []);
      issuesByNode.get(issue.nodeId).push(issue);
    }
  function value(n, col) {
    switch (col) {
      case 'title':
        return nodeTitle(n);
      case 'type':
        return TYPE_LABELS[n.type] || n.type;
      case 'chapter':
        return chapters.get(n.chapterId) || uiText("Без главы", "Unassigned");
      case 'speaker':
        return speakers.get(n.speakerId) || uiText("Без спикера", "No speaker");
      case 'location':
        return locations.get(n.locationId) || uiText("Без локации", "No location");
      case 'tags':
        return (n.tags || []).join(', ');
      case 'issues':
        return String(issuesByNode.get(n.id)?.length || 0);
    }
  }
  const collate = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
  const perPage = 75;
  function drawRows() {
    const predicate = compileNodeQuery(p, tab.query, { regex: tab.regex });
    const filtered = p.nodes.filter(predicate.matches);
    const order = (a, b, k) => collate.compare(value(a, k), value(b, k));
    filtered.sort(
      (a, b) => (tab.group && order(a, b, tab.group)) || order(a, b, tab.sort) * (tab.desc ? -1 : 1),
    );
    tab.offset = Math.min(
      Math.max(0, tab.offset),
      Math.max(0, (Math.ceil(filtered.length / perPage) - 1) * perPage),
    );
    const visible = Object.keys(columns).filter((k) => k === 'title' || tab.columns.includes(k));
    page.querySelector('#tableCount').textContent = `${filtered.length} ${uiText("из", "of")} ${p.nodes.length}`;
    const filterButton = page.querySelector('[data-table=filter]');
    filterButton.setAttribute('aria-controls', 'tableFilterBar');
    filterButton.setAttribute('aria-expanded', String(!page.querySelector('#tableFilterBar').hidden));
    page.querySelector('[data-table=filter]').classList.toggle('has-value', Boolean(tab.query || tab.regex));
    page.querySelector('.wb-popup-group summary').classList.toggle('has-value', Boolean(tab.group));
    page.querySelector('#tableSort').value = tab.sort;
    page.querySelector('#tableDirection').value = tab.desc ? 'desc' : 'asc';
    let groupName = null;
    const rows = filtered
      .slice(tab.offset, tab.offset + perPage)
      .map((n) => {
        const id = esc(n.id);
        let head = '';
        if (tab.group && groupName !== value(n, tab.group)) {
          groupName = value(n, tab.group);
          head = `<tr class="wb-group"><th colspan="${visible.length + 1}" scope="rowgroup">${esc(groupName)}</th></tr>`;
        }
        return (
          head +
          `<tr data-row="${id}"${store.selection.id === n.id ? ' class="current"' : ''}>` +
          visible
            .map((col) => {
              const val = esc(value(n, col));
              if (col === 'title')
                return `<td class="wb-name-cell"><button data-doc="${id}" class="wb-title" title="${esc(n.text || n.title || n.id)}"><span>${val}</span>${n.title && n.text ? `<small>${esc(n.text)}</small>` : ''}</button></td>`;
              if (col === 'speaker')
                return `<td><button data-speaker="${id}" class="wb-cell-edit" title="${uiText("Изменить спикера", "Change speaker")}">${val}</button></td>`;
              if (col === 'issues')
                return `<td title="${esc((issuesByNode.get(n.id) || []).map((i) => i.message).join('\n'))}">${val === '0' ? '<span class="wb-blank">—</span>' : icon('alert', 13) + ' ' + val}</td>`;
              return `<td>${val}</td>`;
            })
            .join('') +
          `<td><button class="wb-cell-edit" data-graph="${id}" aria-label="${uiText("На схеме", "Show on canvas")}: ${esc(nodeTitle(n))}" title="${uiText("На схеме", "Show on canvas")}">${icon('external',14)}</button></td></tr>`
        );
      })
      .join('');
    target.innerHTML = filtered.length
      ? `<table class="wb-table"><thead><tr>${visible.map((col) => `<th scope="col" aria-sort="${col !== tab.sort ? 'none' : tab.desc ? 'descending' : 'ascending'}"><button data-sort="${col}">${icon(glyphs[col],13)}<span>${esc(columns[col])}</span>${tab.sort === col ? icon(tab.desc ? 'down' : 'up',12) : ''}</button></th>`).join('')}<th scope="col" aria-label="${uiText("Схема", "Canvas")}"></th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="wb-empty">${predicate.error ? uiText("Ошибка регулярного выражения: ", "Invalid regular expression: ") + esc(predicate.error) : p.nodes.length ? uiText("Нет узлов с такими значениями. ", "No matching nodes. ") + btn('clear', uiText("Сбросить фильтр", "Clear filter")) : uiText("В проекте пока нет узлов.", "This project has no nodes yet.")}</div>`;
    page.querySelector('#tablePages').innerHTML =
      filtered.length > perPage
        ? `${btn('prev', uiText("Назад", "Back"))}<span>${tab.offset + 1}–${Math.min(tab.offset + perPage, filtered.length)} ${uiText("из", "of")} ${filtered.length}</span>${btn('next', uiText("Далее", "Next"))}`
        : '';
  }
  drawRows();
  target.scrollTop = tab.tableScroll || 0;
  target.scrollLeft = tab.tableLeft || 0;
  target.onscroll = () => {
    tab.tableScroll = target.scrollTop;
    tab.tableLeft = target.scrollLeft;
  };
  page.querySelector('#tableQuery').oninput = (e) => {
    tab.query = e.target.value;
    tab.offset = 0;
    drawRows();
  };
  page.querySelector('#tableRegex').onchange = (e) => {
    tab.regex = e.target.checked;
    tab.offset = 0;
    drawRows();
  };
  page.querySelector('#tableGroup').onchange = (e) => {
    tab.group = e.target.value;
    tab.offset = 0;
    drawRows();
  };
  page.querySelectorAll('[data-col]').forEach(
    (box) =>
      (box.onchange = () => {
        tab.columns = Array.from(page.querySelectorAll('[data-col]:checked')).map((x) => x.dataset.col);
        drawRows();
      }),
  );
  page.querySelector('#tableSort').onchange = (e) => {
    tab.sort = e.target.value;
    tab.offset = 0;
    drawRows();
  };
  page.querySelector('#tableDirection').onchange = (e) => {
    tab.desc = e.target.value === 'desc';
    tab.offset = 0;
    drawRows();
  };
  page.querySelectorAll('.wb-popup').forEach(details => {
    const summary = details.querySelector('summary');
    details.addEventListener('focusout', e => {
      if (e.relatedTarget && !details.contains(e.relatedTarget)) details.open = false;
    });
    details.addEventListener('keydown', e => {
      if (e.key === 'Escape' && details.open) {
        e.preventDefault();
        e.stopPropagation();
        details.open = false;
        summary.focus();
      }
    });
  });
  page.onclick = (e) => {
    const opened = page.querySelector('.wb-popup[open]');
    if (opened && !opened.contains(e.target)) opened.open = false;
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-view')) return applyView(views[Number(b.dataset.view)]);
    const { doc, graph, speaker, sort, table } = b.dataset;
    if (table === 'default') return applyView({name:'',query:'',regex:false,columns:['type','chapter','speaker','location','issues'],group:'',sort:'title',desc:false});
    if (table === 'new') {
      const res = store.apply([{op:'createNode', node:{type:'line'}}], {label:uiText("Создать реплику", "Create line")});
      if (res.ok) openNode(res.created[0]);
      else ui.toast(res.error, 'bad');
      return;
    }
    if (table === 'filter') {
      const bar = page.querySelector('#tableFilterBar');
      bar.hidden = !bar.hidden;
      tab.filterOpen = !bar.hidden;
      b.setAttribute('aria-expanded', String(tab.filterOpen));
      if (tab.filterOpen) page.querySelector('#tableQuery').focus();
      return;
    }
    if (doc || graph) {
      store.setSelection({ kind: 'node', id: doc || graph });
      if (doc) return openNode(doc);
      return openGraph(graph);
    }
    if (speaker) {
      const node = store.project.nodes.find((n) => n.id === speaker);
      if (!node) return;
      const select = document.createElement('select');
      select.className = 'select select-sm';
      select.setAttribute('aria-label', uiText("Спикер реплики", "Line speaker"));
      select.add(new Option(uiText("Без спикера", "No speaker"), ''));
      for (const c of p.characters) select.add(new Option(c.name, c.id));
      select.value = node.speakerId || '';
      b.replaceWith(select);
      select.focus();
      select.onchange = () => {
        const result = store.apply([{ op: 'updateNode', id: speaker, patch: { speakerId: select.value } }], {
          label: uiText("Спикер в таблице", "Table speaker"),
        });
        if (!result.ok) {
          select.value = node.speakerId || '';
          ui.toast(result.error, 'bad');
        }
        // A successful Store change schedules the workbench render.
      };
      select.onblur = () => {
        // Blur can fire while Chromium is replacing the entire table.
        // Finish a cancelled edit only after that DOM mutation completes.
        requestAnimationFrame(() => {
          if (select.isConnected && document.activeElement !== select) select.replaceWith(b);
        });
      };
      return;
    }
    if (sort) {
      tab.desc = sort === tab.sort ? !tab.desc : false;
      tab.sort = sort;
      tab.offset = 0;
    } else if (table === 'clear') {
      tab.query = '';
      page.querySelector('#tableQuery').value = '';
      tab.offset = 0;
    } else if (table === 'prev') tab.offset -= perPage;
    else if (table === 'next') tab.offset += perPage;
    else if (table === 'save') return saveView();
    else return;
    drawRows();
  };
}
