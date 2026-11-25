import { t as uiText } from './i18n.js';
import { icon } from './icons.js';
import { buildGodotDialogue } from './export.js';
import { evaluateCondition, uid } from './model.js';

export function insertionEdges(source) {
  if (!source || source.type === 'end') return [];
  const edges = [];
  if (source.type === 'choice') {
    (source.choices || []).forEach((c, i) => edges.push({ kind: 'choice', id: c.id, target: c.next, label: c.text || uiText("Вариант ", "Choice ") + (i + 1) }));
  }
  if (source.type === 'condition') {
    (source.branches || []).forEach((b, i) => edges.push({ kind: 'branch', id: b.id, target: b.next, label: b.condition || uiText("Ветка ", "Branch ") + (i + 1) }));
  }
  edges.push({ kind: 'next', target: source.next, label: edges.length ? uiText("Иначе (запасной переход)", "Else (fallback transition)") : uiText("Продолжение", "Continuation") });
  return edges;
}

// Все операции выполняются в одной транзакции Store, в том числе перенаправление варианта.
export function insertNodeOnEdge(store, sourceId, edge, type = 'line') {
  const nodes = store.project.nodes;
  const source = nodes.find(n => n.id === sourceId);
  if (sourceId && !source) return { ok: false, error: uiText("Исходный узел уже удалён.", "The source node was deleted.") };
  const id = uid('n_');
  const node = { id, type, chapterId: source?.chapterId || '', locationId: source?.locationId || '' };
  if (source && type === 'line') node.speakerId = source.speakerId || '';
  if (source?.position) node.position = { x: source.position.x + 270, y: source.position.y + 64 };
  if (type === 'choice') {
    node.choices = [uiText("Первый вариант", "First choice"), uiText("Второй вариант", "Second choice")].map(text => ({ id: uid('o_'), text, next: '' }));
  }
  const ops = [{ op: 'createNode', node }];
  if (edge) {
    const current = insertionEdges(source).find(e => e.kind === edge.kind && (e.kind === 'next' || e.id === edge.id));
    if (!current || ('target' in edge && edge.target !== current.target)) return { ok: false, error: uiText("Переход изменился. Выберите его снова.", "The transition changed. Select it again.") };
    if (current.target && !nodes.some(n => n.id === current.target)) return { ok: false, error: uiText("Целевой узел перехода отсутствует.", "Transition target missing.") };
    node.next = current.target || '';
    if (edge.kind === 'next') ops.push({ op: 'updateNode', id: sourceId, patch: { next: id } });
    else ops.push({ op: 'retargetEdge', id: sourceId, kind: edge.kind, edgeId: edge.id, to: id });
  }
  return store.apply(ops, { label: edge ? uiText("Вставить узел на переход", "Insert node on transition") : uiText("Создать отдельный узел", "Create standalone node") });
}

export function requestInsertion(store, ui, sourceId, edge, type = 'line') {
  ui.flushEdits?.();
  const source = store.project.nodes.find(n => n.id === sourceId);
  const generation = store.generation;
  const originalProjectPath = store.filePath;
  const commit = selected => {
    if (generation !== store.generation || originalProjectPath !== store.filePath) return;
    const result = insertNodeOnEdge(store, sourceId, selected, type);
    if (!result.ok) return ui.toast(result.error, 'bad');
    const id = result.created[0];
    ui.selectNode(id);
    ui.refresh();
    return id;
  };
  const options = insertionEdges(source);
  if (edge || options.length === 1 || !source) return commit(edge || options[0]);
  const body = document.createElement('div');
  body.className = 'sf-insert-options';
  const entries = options.length ? options : [{ label: uiText("Создать отдельный узел", "Create standalone node") }];
  const dialog = ui.modal({ title: options.length ? uiText("Вставить на переход", "Insert on transition") : uiText("У концовки нет продолжения", "An ending has no continuation"), body, buttons: [{ label: uiText("Отмена", "Cancel") }] });
  for (const item of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    const dest = store.project.nodes.find(n => n.id === item.target);
    button.textContent = item.label + (dest ? ' → ' + (dest.title || dest.text || dest.id).slice(0, 55) : '');
    button.onclick = () => { dialog.close(); commit(item.kind ? item : null); };
    body.append(button);
  }
  body.firstElementChild?.focus();
}

// Проигрываем именно экспортное представление — общие правила для заметок, имён переменных и переходов.
export function createPlayback(project, startId) {
  const dialogue = buildGodotDialogue(startId ? { ...project, startNodeId: startId } : project);
  const initial = Object.fromEntries(Object.entries(dialogue.variables).map(([key, spec]) => [key, spec.initial]));
  let state;
  const history = [];

  function effects(list) {
    for (const e of list || []) {
      const key = e.var;
      const prev = Object.hasOwn(state.vars, key) ? state.vars[key] : 0;
      const value = e.value ?? 0;
      const numeric = x => Number.isFinite(Number(x)) ? Number(x) : 0;
      let next = value;
      if (e.op === '+=') next = numeric(prev) + numeric(value);
      if (e.op === '-=') next = numeric(prev) - numeric(value);
      if (e.op === 'toggle') next = !prev;
      state.vars[key] = next;
      state.trace.push(key + ': ' + JSON.stringify(prev) + ' → ' + JSON.stringify(next));
    }
  }
  function test(expr) {
    const yes = evaluateCondition(expr, state.vars);
    if (expr) state.trace.push(expr + ' — ' + (yes ? uiText("истина", "true") : uiText("ложь", "false")));
    return yes;
  }
  function enter(target) {
    state.options = [];
    for (let step = 0; step < 512; step++) {
      if (!target) { state.status = 'finished'; state.message = uiText("Ветка завершена", "Branch complete"); return; }
      if (!Object.hasOwn(dialogue.nodes, target)) { state.status = 'error'; state.message = uiText("Цель перехода отсутствует: ", "Missing transition target: ") + target; return; }
      const node = dialogue.nodes[target];
      state.id = target;
      effects(node.effects);
      if (node.type === 'end') { state.status = 'finished'; state.message = uiText("Концовка", "Ending"); return; }
      if (node.type === 'line' || node.type === 'scene') { state.status = 'reading'; return; }
      if (node.type === 'choice') {
        state.options = node.choices.filter(c => test(c.condition));
        if (state.options.length) { state.status = 'choice'; return; }
      }
      if (node.type === 'condition') {
        const chosen = node.branches.find(b => test(b.condition));
        target = chosen ? chosen.next : node.next;
      } else target = node.next;
    }
    state.status = 'error';
    state.message = uiText("Остановлено после 512 автоматических переходов. Проверьте цикл.", "Stopped after 512 automatic transitions. Check for a loop.");
  }
  function reset() {
    history.length = 0;
    state = { id: '', vars: { ...initial }, status: '', options: [], trace: [], message: '' };
    enter(dialogue.start);
  }
  function advance(index) {
    if (!['choice','reading'].includes(state.status)) return false;
    const option = state.options[index];
    if (state.status === 'choice' && !option) return false;
    history.push(structuredClone(state));
    state.trace = [];
    if (option) effects(option.effects);
    enter(option ? option.next : dialogue.nodes[state.id].next);
    return true;
  }
  reset();
  return {
    get state() { return state; },
    get node() { return dialogue.nodes[state.id] || {}; },
    get canBack() { return Boolean(history.length); },
    reset, advance,
    back() { if (history.length) state = history.pop(); },
  };
}

export function showPlayback(store, ui, id) {
  ui.flushEdits?.();
  const player = createPlayback(store.project, id);
  const body = document.createElement('div');
  body.className = 'sf-playback';
  let author = true;
  let unsubscribe;
  const priorFocus = document.activeElement;
  const dialog = ui.modal({ title: uiText("Пройти ветку", "Play branch"), wide: true, body, buttons: [{ label: uiText("Закрыть", "Close") }], onClose: () => { unsubscribe?.(); priorFocus?.focus?.(); } });
  const generation = store.generation;
  unsubscribe = store.subscribe(() => { if (generation !== store.generation) dialog.close(); });
  const esc = ui.escapeHTML;
  function render() {
    const { state, node } = player;
    const speaker = (node.type === 'scene' ? node.location : node.speaker) || ui.TYPE_LABELS[node.type] || uiText("Сценарий", "Story");
    body.innerHTML = `<div class="sf-play-meta"><strong>${icon(node.type === 'scene' ? 'pin' : 'user', 15)}${esc(speaker)}</strong><label><input type="checkbox" data-author ${author ? 'checked' : ''}> ${uiText("Для автора", "Author view")}</label></div>
      <p class="sf-play-line">${esc(node.text || node.title || '')}</p>
      ${state.message ? '<p role="status">' + esc(state.message) + '</p>' : ''}
      <div class="sf-play-options">${state.options.map((opt, i) => '<button class="btn" data-option="' + i + '">' + esc(opt.text || uiText("Вариант ", "Choice ") + (i+1)) + icon('right', 15) + '</button>').join('')}
      ${state.status === 'reading' ? uiText("<button class=\"btn btn-primary\" data-advance>Далее", "<button class=\"btn btn-primary\" data-advance>Next") + icon('right', 15) + '</button>' : ''}</div>
      ${author && state.trace.length ? uiText("<div class=\"sf-play-trace\"><strong>Условия и эффекты</strong>", "<div class=\"sf-play-trace\"><strong>Conditions and effects</strong>") + state.trace.map(t => '<div>' + esc(t) + '</div>').join('') + '</div>' : ''}
      <div class="sf-play-tools"><button class="btn" data-back ${player.canBack ? '' : 'disabled'}>${uiText("Шаг назад", "Step back")}</button>
      <button class="btn" data-reset>${uiText("Начать заново", "Restart")}</button><button class="btn" data-open ${state.id ? '' : 'disabled'}>${uiText("Открыть текущий узел", "Open current node")}</button></div>`;
  }
  body.addEventListener('change', ev => {
    if (ev.target.matches('[data-author]')) { author = ev.target.checked; render(); body.querySelector('[data-author]').focus(); }
  });
  body.addEventListener('click', ev => {
    const t = ev.target.closest('button');
    if (!t) return;
    if (t.hasAttribute('data-open')) {
      dialog.close();
      if (ui.workbench) ui.workbench.openNode(player.state.id);
      else ui.selectNode(player.state.id);
      return;
    }
    if (t.hasAttribute('data-back')) player.back();
    else if (t.hasAttribute('data-reset')) player.reset();
    else if (t.hasAttribute('data-advance')) player.advance();
    else if (t.hasAttribute('data-option')) player.advance(Number(t.dataset.option));
    render();
    body.querySelector('.sf-play-options button, [data-back]:enabled, [data-reset]')?.focus();
  });
  render();
  return dialog;
}
