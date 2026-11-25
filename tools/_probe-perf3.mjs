// Замер на большом проекте: обзор, инспектор, набор текста.
const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];

const res = await window.sf.file.openPath('demo/stress-overview.sfproj');
const project = JSON.parse(res.content);
store.setProject(project, { filePath: null, dirty: false });
await wait(300);
ui.graph.fit();

const nodeId = store.project.startNodeId;
store.setSelection({ kind: 'node', id: nodeId });
ui.inspector.render();
await wait(100);

const node = store.project.nodes.find((n) => n.id === nodeId);
const counts = {
  nodes: store.project.nodes.length,
  chapterOptions: document.querySelectorAll('#inspectorBody optgroup option').length,
  selects: document.querySelectorAll('#inspectorBody select').length,
};

function median(fn, rounds = 6) {
  const times = [];
  for (let i = 0; i < rounds; i += 1) {
    const t0 = performance.now();
    fn(i);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return Math.round(times[Math.floor(times.length / 2)] * 10) / 10;
}

const tInspector = median(() => ui.inspector.render());
const tGraph = median(() => ui.graph.refresh());
const tPanels = median(() => ui.panels.render());
const tApply = median(() => {
  store.apply([{ op: 'updateNode', id: nodeId, patch: { text: 'x' + Math.random() } }], { label: 't' });
});

// набор текста: 25 «нажатий» через реальное поле
const ta = document.querySelector('#inspectorBody textarea[data-bind="text"]');
let frames = [];
let typingTotal = 0;
if (ta) {
  ta.focus();
  const t0 = performance.now();
  for (let i = 0; i < 25; i += 1) {
    ta.value = 'Строка набора ' + i;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(60);
  }
  typingTotal = Math.round(performance.now() - t0);
} else {
  typingTotal = -1;
}

// долгие задачи во время набора
const longTasks = [];
let observer = null;
try {
  observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration));
  });
  observer.observe({ entryTypes: ['longtask'] });
} catch {
  /* нет поддержки */
}
await wait(50);
if (ta) {
  for (let i = 0; i < 20; i += 1) {
    ta.value = 'Быстрый набор ' + i;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(40);
  }
}
await wait(600);
observer?.disconnect();

checks.push({ ok: tInspector < 16, name: 'инспектор перерисовывается быстро', info: tInspector + ' мс' });
checks.push({ ok: tGraph < 40, name: 'граф перерисовывается быстро', info: tGraph + ' мс' });
checks.push({ ok: tPanels < 40, name: 'панели перерисовываются быстро', info: tPanels + ' мс' });
checks.push({ ok: tApply < 8, name: 'правка модели дешёвая', info: tApply + ' мс' });
checks.push({ ok: typingTotal < 4000, name: 'набор текста не увязает', info: typingTotal + ' мс на 25 символов' });
checks.push({ ok: longTasks.length <= 3, name: 'долгих задач при наборе мало', info: longTasks.length + ' шт: ' + longTasks.slice(0, 8).join(', ') });

__sfOut = {
  summary: { total: checks.length, passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length },
  failed: checks.filter((c) => !c.ok),
  jsErrors: [],
  checks: [
    ...checks,
    { ok: true, name: 'узлов в проекте', info: String(counts.nodes) },
    { ok: true, name: 'option-ов в селектах', info: String(counts.chapterOptions) },
    { ok: true, name: 'select-ов в панели', info: String(counts.selects) },
  ],
};