// Замер стоимости отдельных querySelectorAll на готовой панели.
const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { makeStressFixture } = await import(new URL('../tools/test-fixtures.mjs', document.baseURI).href);
store.setProject(makeStressFixture(), { filePath: null, dirty: false });
await wait(250);
store.setSelection({ kind: 'node', id: store.project.startNodeId });
await wait(80);
ui.inspector.render();
await wait(20);

const root = document.getElementById('inspectorBody');
const sels = [
  '[data-effect-var]', '[data-effect-op]', '[data-effect-value]', '[data-effect-del]',
  '[data-choice-text]', '[data-choice-next]', '[data-choice-cond]', '[data-choice-hint]',
  '[data-choice-del]', '[data-choice-up]', '[data-choice-down]', '[data-ceffect-add]',
  '[data-branch-cond]', '[data-branch-next]', '.swatch[data-color]', 'textarea[data-autosize]',
  '[data-bind]', 'select[data-bind="next"]',
];
const rows = [];
for (const sel of sels) {
  const t = performance.now();
  for (let i = 0; i < 5; i += 1) root.querySelectorAll(sel);
  const dt = (performance.now() - t) / 5;
  rows.push({ sel, ms: Math.round(dt * 100) / 100, n: root.querySelectorAll(sel).length });
}

__sfOut = {
  summary: { total: 1, passed: 1, failed: 0 },
  failed: [],
  jsErrors: [],
  checks: [
    { ok: true, name: 'элементов в панели', info: String(root.querySelectorAll('*').length) },
    { ok: true, name: 'размер html', info: String(root.innerHTML.length) },
    ...rows.map((r) => ({ ok: true, name: 'qs ' + r.sel, info: r.ms + ' мс, найдено ' + r.n })),
  ],
};