// Честный замер набора: без длинных пауз в цикле (раньше 20×60 мс ожидания
// сами давали 1.6 с и маскировали реальную работу).
const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (v) => Math.round(v * 10) / 10;

const { makeStressFixture } = await import(new URL('../tools/test-fixtures.mjs', document.baseURI).href);
store.setProject(makeStressFixture(), { filePath: null, dirty: false });
await wait(300);
store.setSelection({ kind: 'node', id: store.project.startNodeId });
await wait(200);

const out = [];
const add = (name, info) => out.push({ ok: true, name, info });
const body = document.getElementById('inspectorBody');
const svg = document.getElementById('graph');
add('зум', String(R(ui.graph.getZoom())));
add('состав', `${document.querySelectorAll('*').length} элементов в документе, ${svg.querySelectorAll('text').length} текстов в графе`);

async function type(n, gap) {
  const area = body.querySelector('textarea[data-focus="text"]');
  const longTasks = [];
  let last = performance.now();
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTasks.push(Math.round(e.duration));
  });
  try {
    obs.observe({ entryTypes: ['longtask'] });
  } catch {
    /* нет longtask */
  }
  const t0 = performance.now();
  for (let i = 0; i < n; i += 1) {
    area.value += 'а';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(gap);
  }
  const total = performance.now() - t0;
  try {
    obs.disconnect();
  } catch {
    /* ignore */
  }
  const overhead = n * gap;
  return { total: R(total), work: R(total - overhead), long: longTasks.length, top: longTasks.slice(0, 6).join(', ') };
}

const demo = await type(20, 20);
add('20 символов (пауза 20 мс)', `${demo.total} мс, из них работа ${demo.work} мс, longtask ${demo.long}${demo.top ? ': ' + demo.top : ''}`);

const dense = await type(40, 8);
add('40 символов (пауза 8 мс)', `${dense.total} мс, из них работа ${dense.work} мс, longtask ${dense.long}${dense.top ? ': ' + dense.top : ''}`);

// кадры: сколько раз перерисовывался граф за набор
let frames = 0;
const raf = () => {
  frames += 1;
  if (frames < 200) requestAnimationFrame(raf);
};
requestAnimationFrame(raf);
const t0 = performance.now();
const area = body.querySelector('textarea[data-focus="text"]');
for (let i = 0; i < 18; i += 1) {
  area.value += 'б';
  area.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(16);
}
const t1 = performance.now();
add('16 мс/символ', `${R(t1 - t0)} мс, кадров ${frames}`);
last = t1;
void last;

__sfOut = { summary: { total: out.length, passed: out.length, failed: 0 }, failed: [], jsErrors: [], checks: out };