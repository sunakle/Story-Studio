// Пробник для снимка «Обзора сюжета»: открывает визуалайзер и оставляет его
// на экране, чтобы main.js сфотографировал окно (--selftest-shot=viz).
const ui = window.__sfTest.ui;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const viz = ui.visualizer;
viz.open();
await wait(600);
viz.fit();
await wait(2600); // даём физике улечься
viz.fit();
await wait(400);

__sfOut = {
  summary: { total: 1, passed: 1, failed: 0 },
  failed: [],
  jsErrors: (window.__sfErrors || []).slice(0, 10),
  checks: [{ ok: true, name: 'обзор открыт', info: JSON.stringify(viz.stats) }],
};