// Замер узких мест на большом проекте: что именно тормозит при правках.
const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const {} = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const time = async (name, fn, rounds = 5) => {
  const times = [];
  for (let i = 0; i < rounds; i += 1) {
    const t0 = performance.now();
    await fn(i);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { name, median: Math.round(times[Math.floor(times.length / 2)] * 10) / 10, max: Math.round(times[times.length - 1] * 10) / 10 };
};

const results = [];
const nodes = store.project.nodes;
const target = nodes.find((n) => n.type === 'line');

results.push(await time('graph.refresh()', () => { ui.graph.refresh(); }));
results.push(await time('panels.render()', () => { ui.panels.render(); }));
results.push(await time('inspector.render()', () => { ui.inspector.render(); }));
results.push(await time('store.apply setText', () => {
  store.apply([{ op: 'setNodeTexts', id: target.id, patch: { text: 'Проверка задержки ' + Math.random().toFixed(4) } }], 'замер');
}));
results.push(await time('validateProject', () => { window.__sfTest.validateProject(store.project); }));
results.push(await time('JSON.stringify(project,null,2)', () => { JSON.stringify(store.project, null, 2); }, 3));
results.push(await time('полный цикл правки (apply+refresh)', async () => {
  store.apply([{ op: 'setNodeTexts', id: target.id, patch: { text: 'Цикл ' + Math.random().toFixed(4) } }], 'замер');
  ui.graph.refresh();
  ui.inspector.render();
  ui.panels.render();
}));

// профайл computeStats
results.push(await time('computeStats', () => { window.__sfTest.countWords(' '.repeat(10)); }));

const checks = results.map((r) => ({
  ok: r.median < 120,
  name: r.name,
  info: 'медиана ' + r.median + ' мс, максимум ' + r.max + ' мс',
}));

__sfOut = {
  summary: { total: checks.length, passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length },
  failed: checks.filter((c) => !c.ok),
  jsErrors: [],
  checks,
};