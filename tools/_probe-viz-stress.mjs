// Снимок «Обзора сюжета» на большом тестовом проекте (demo/stress-overview.sfproj).
const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const add = (ok, name, info = '') => checks.push({ ok, name, info });

const path = 'demo/stress-overview.sfproj';
const res = await window.sf.file.openPath(path);
add(!!res && res.ok === true, 'большой проект читается с диска', res ? String(res.ok) : 'нет ответа');

if (res && res.content) {
  const project = JSON.parse(res.content);
  store.setProject(project, { filePath: null, dirty: false });
  await wait(200);
  add(store.project.nodes.length === project.nodes.length, 'узлов в модели', String(store.project.nodes.length));

  const viz = ui.visualizer;
  viz.open();
  await wait(2600);
  const stats = viz.stats;
  add(stats.nodes > 200, 'точек в облаке', String(stats.nodes));
  add(stats.links > 200, 'связей в облаке', String(stats.links));
  viz.fit();
  await wait(500);
}

__sfOut = {
  summary: { total: checks.length, passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length },
  failed: checks.filter((c) => !c.ok),
  jsErrors: window.__sfErrors || [],
  checks,
};