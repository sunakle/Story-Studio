// Полный цикл набора текста: где реально уходит время.
const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (v) => Math.round(v * 10) / 10;

const res = await window.sf.file.openPath('demo/stress-overview.sfproj');
store.setProject(JSON.parse(res.content), { filePath: null, dirty: false });
await wait(250);
store.setSelection({ kind: 'node', id: store.project.startNodeId });
await wait(120);

const prof = { graph: 0, graphN: 0, panels: 0, panelsN: 0, inspector: 0, inspectorN: 0, apply: 0, applyN: 0 };

const wrap = (obj, key, stat) => {
  const orig = obj[key];
  if (typeof orig !== 'function') return;
  obj[key] = function (...args) {
    const t = performance.now();
    const r = orig.apply(this, args);
    prof[stat] += performance.now() - t;
    prof[stat + 'N'] += 1;
    return r;
  };
};
wrap(ui.graph, 'refresh', 'graph');
if (ui.graph) {
  for (const k of ['render', 'updateEdges']) if (typeof ui.graph[k] === 'function') wrap(ui.graph, k, 'graph');
}
wrap(ui.panels, 'render', 'panels');
wrap(ui.inspector, 'render', 'inspector');
const origApply = store.apply;
store.apply = function (...args) {
  const t = performance.now();
  const r = origApply.apply(this, args);
  prof.apply += performance.now() - t;
  prof.applyN += 1;
  return r;
};

const area = document.querySelector('#inspectorBody textarea[data-focus="text"]');
if (!area) {
  __sfOut = { summary: { total: 1, passed: 0, failed: 1 }, failed: [{ name: 'поле текста не найдено' }], jsErrors: [], checks: [] };
} else {
  area.focus();
  area.value = '';
  const longTasks = [];
  let last = performance.now();
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTasks.push(Math.round(e.duration));
  });
  try {
    obs.observe({ entryTypes: ['longtask'] });
  } catch {
    /* longtask может быть недоступен */
  }

  const t0 = performance.now();
  for (let i = 0; i < 20; i += 1) {
    area.value += 'а';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(60);
  }
  await wait(400);
  const total = performance.now() - t0;
  try {
    obs.disconnect();
  } catch {
    /* ignore */
  }

  __sfOut = {
    summary: { total: 1, passed: 1, failed: 0 },
    failed: [],
    jsErrors: [],
    checks: [
      { ok: true, name: 'набор 20 символов', info: R(total) + ' мс' },
      { ok: true, name: '  длинных задач (longtask)', info: String(longTasks.length) + ': ' + longTasks.slice(0, 12).join(', ') },
      { ok: true, name: '  ui.graph.refresh', info: R(prof.graph) + ' мс / ' + prof.graphN + ' вызовов' },
      { ok: true, name: '  ui.panels.render', info: R(prof.panels) + ' мс / ' + prof.panelsN + ' вызовов' },
      { ok: true, name: '  ui.inspector.render', info: R(prof.inspector) + ' мс / ' + prof.inspectorN + ' вызовов' },
      { ok: true, name: '  store.apply', info: R(prof.apply) + ' мс / ' + prof.applyN + ' вызовов' },
    ],
  };
}