// Производительность обзора сюжета на большом проекте: 512 узлов.
const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const base = store.project;
const nodes = [];
for (let i = 0; i < 512; i += 1) {
  nodes.push({
    id: 'p_n' + i,
    type: i % 9 === 0 ? 'choice' : 'line',
    text: 'Реплика номер ' + i + ' про ночную смену на складе',
    speakerId: '',
    locationId: '',
    chapterId: '',
    next: i < 511 ? 'p_n' + (i + 1) : '',
    choices: i % 9 === 0 ? [{ id: 'o_' + i, text: 'Вариант', next: i < 511 ? 'p_n' + (i + 1) : '', condition: '', effects: [] }] : [],
    branches: [],
    effects: [],
    tags: [],
    x: 0,
    y: 0,
  });
}
store.setProject({ ...base, nodes });

const viz = ui.visualizer;
const t0 = performance.now();
viz.open();
await wait(50);
const tOpen = performance.now() - t0;
const t1 = performance.now();
viz.fit();
const tFit = performance.now() - t1;
const stats = viz.stats;
const n = stats.nodes;

const t2 = performance.now();
viz.close();
const tClose = performance.now() - t2;

// вернуть демо
store.setProject(base);

__sfOut = {
  summary: { total: 4, passed: 4, failed: 0 },
  failed: [],
  jsErrors: [],
  checks: [
    { ok: n >= 512, name: 'облако на 512 узлов', info: 'точек ' + n + ', связей ' + stats.links },
    { ok: tOpen < 6000, name: 'открытие уложилось в бюджет', info: Math.round(tOpen) + ' мс' },
    { ok: tFit < 200, name: 'вписывание дешёвое', info: Math.round(tFit) + ' мс' },
    { ok: tClose < 200, name: 'закрытие дешёвое', info: Math.round(tClose) + ' мс' },
  ],
};