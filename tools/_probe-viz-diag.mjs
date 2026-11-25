// Диагностика: почему ui.visualizer пуст.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(500);
const ui = window.__sfTest && window.__sfTest.ui;
const info = {
  hasTest: !!window.__sfTest,
  hasUi: !!ui,
  viz: !!(ui && ui.visualizer),
  keys: ui ? Object.keys(ui).join(',') : '',
  errors: (window.__sfErrors || []).slice(0, 10),
  vizRoot: !!document.getElementById('vizRoot'),
};
__sfOut = {
  summary: { total: 1, passed: 1, failed: 0 },
  failed: [],
  jsErrors: [],
  checks: [{ ok: true, name: 'диагностика', info: JSON.stringify(info) }],
};