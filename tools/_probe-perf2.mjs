// Разбор по частям: что внутри inspector.render() стоит дорого.
const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const root = document.getElementById('inspectorBody');
const results = [];

function timeIt(name, fn, rounds = 6) {
  const times = [];
  for (let i = 0; i < rounds; i += 1) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  results.push({ name, median: Math.round(times[Math.floor(times.length / 2)] * 10) / 10 });
}

timeIt('innerHTML = "" (сброс)', () => { root.innerHTML = ''; });
timeIt('ui.inspector.render() целиком', () => { ui.inspector.render(); });
timeIt('innerHTML = тот же html', () => {
  const html = root.innerHTML;
  root.innerHTML = '';
  root.innerHTML = html;
});
timeIt('JSON сериализация проекта', () => { JSON.stringify(store.project); });

// сколько узлов в проекте и сколько option-элементов в первом select
const nodeCount = store.project.nodes.length;
const selects = root.querySelectorAll('select');
const optionsTotal = [...selects].reduce((s, el) => s + el.options.length, 0);

// стоимость одного updateNode через store.apply (без UI)
const target = store.project.nodes.find((n) => n.type === 'line');
timeIt('store.apply updateNode', () => {
  store.apply([{ op: 'updateNode', id: target.id, patch: { text: 'x' + Math.random() } }], { label: 't' });
});

__sfOut = {
  summary: { total: results.length, passed: results.length, failed: 0 },
  failed: [],
  jsErrors: [],
  checks: [
    ...results.map((r) => ({ ok: true, name: r.name, info: r.median + ' мс' })),
    { ok: true, name: 'в проекте узлов', info: String(nodeCount) },
    { ok: true, name: 'select-ов в панели', info: String(selects.length) },
    { ok: true, name: 'option-ов всего', info: String(optionsTotal) },
    { ok: true, name: 'выбранный узел', info: target ? target.type : 'нет' },
  ],
};