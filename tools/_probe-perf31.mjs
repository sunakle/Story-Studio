// Кто ещё отнимает время при наборе в рабочем зуме: longtask-профиль
// с обёртками вокруг store.apply / graph.refresh / panels.render / inspector.render.
const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (v) => Math.round(v * 10) / 10;

const { makeStressFixture } = await import(new URL('../tools/test-fixtures.mjs', document.baseURI).href);
store.setProject(makeStressFixture(), { filePath: null, dirty: false });
await wait(300);
window.__sfTest.action('view:layout');
await wait(400);
ui.graph.fit();
await wait(200);
ui.graph.setZoom(1);
await wait(200);
const lineNode = store.project.nodes.find((n) => n.type === 'line');
store.setSelection({ kind: 'node', id: lineNode.id });
await wait(250);

const out = [];
const add = (name, info) => out.push({ ok: true, name, info });
const body = document.getElementById('inspectorBody');
const area = body.querySelector('textarea[data-focus="text"]');

const prof = {};
const wrap = (obj, key, name) => {
  const orig = obj[key];
  if (typeof orig !== 'function') return;
  prof[name] = { time: 0, n: 0, max: 0 };
  obj[key] = function (...args) {
    const t = performance.now();
    const r = orig.apply(this, args);
    const d = performance.now() - t;
    prof[name].time += d;
    prof[name].n += 1;
    prof[name].max = Math.max(prof[name].max, d);
    return r;
  };
};
wrap(store, 'apply', 'store.apply');
wrap(ui.graph, 'refresh', 'graph.refresh');
wrap(ui.panels, 'render', 'panels.render');
wrap(ui.inspector, 'render', 'inspector.render');
wrap(store, 'emit', 'store.emit');
if (typeof ui.graph.setZoom === 'function') wrap(ui.graph, 'setZoom', 'graph.setZoom');

const longTasks = [];
const obs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) longTasks.push(Math.round(e.duration));
});
try {
  obs.observe({ entryTypes: ['longtask'] });
} catch {
  /* ignore */
}

const t0 = performance.now();
for (let i = 0; i < 20; i += 1) {
  area.value += 'а';
  area.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(50);
}
const total = performance.now() - t0;
await wait(300);
try {
  obs.disconnect();
} catch {
  /* ignore */
}

add('набор 20 символов при зуме 1', `${R(total)} мс (из них паузы 1000 мс), longtask ${longTasks.length}${longTasks.length ? ': ' + longTasks.join(', ') : ''}`);
for (const [name, s] of Object.entries(prof)) {
  add(name, `${R(s.time)} мс за ${s.n} вызовов, максимум ${R(s.max)} мс`);
}

// отдельно: цена одного кадра с обновлением карточки
const g = performance.now();
store.apply([{ op: 'updateNode', id: lineNode.id, patch: { text: 'Проверка обновления карточки' } }], { label: 'тест' });
await wait(100);
add('одна правка текста (без инспектора)', `${R(performance.now() - g)} мс, включая паузу 100`);

__sfOut = { summary: { total: out.length, passed: out.length, failed: 0 }, failed: [], jsErrors: [], checks: out };