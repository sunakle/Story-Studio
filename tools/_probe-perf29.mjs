// Интерактивность: кадры при пане, зуме, перетаскивании узла и смене выделения.
// Меряем длительность кадров через rAF, пока делаем действие.
const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (v) => Math.round(v * 10) / 10;

const res = await window.sf.file.openPath('demo/stress-overview.sfproj');
store.setProject(JSON.parse(res.content), { filePath: null, dirty: false });
await wait(300);
window.__sfTest.action('view:layout');
await wait(400);
ui.graph.fit();
await wait(250);

const out = [];
const add = (name, info) => out.push({ ok: true, name, info });
const host = document.getElementById('graphHost');
const svg = document.getElementById('graph');
const body = document.getElementById('inspectorBody');

// Кадры во время асинхронного действия: возвращает массив длительностей кадров
async function frames(action, ms = 500) {
  const gaps = [];
  let running = true;
  let lastT = performance.now();
  const loop = () => {
    const now = performance.now();
    gaps.push(now - lastT);
    lastT = now;
    if (running) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  await action();
  await wait(ms);
  running = false;
  await wait(60);
  gaps.shift();
  const sorted = [...gaps].sort((a, b) => a - b);
  const max = sorted[sorted.length - 1] || 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  return { n: gaps.length, max: R(max), p95: R(p95), avg: R(gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length)) };
}

add('зум после «вписать»', String(R(ui.graph.getZoom())));

// 1. зум колесом: 20 тиков
const rect = host.getBoundingClientRect();
const zoomFrames = await frames(async () => {
  for (let i = 0; i < 20; i += 1) {
    host.dispatchEvent(
      new WheelEvent('wheel', { deltaY: i < 10 ? -120 : 120, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true }),
    );
    await wait(24);
  }
});
add('зум 20 тиков', `кадров ${zoomFrames.n}: средний ${zoomFrames.avg} мс, p95 ${zoomFrames.p95}, максимум ${zoomFrames.max}`);

// 2. пан: тянем фон мышью
const panFrames = await frames(async () => {
  svg.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: rect.left + 40, clientY: rect.top + 700, bubbles: true }));
  for (let i = 0; i < 20; i += 1) {
    svg.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + 40 + i * 12, clientY: rect.top + 700 - i * 6, bubbles: true }));
    await wait(24);
  }
  svg.dispatchEvent(new PointerEvent('pointerup', { clientX: rect.left + 280, clientY: rect.top + 580, bubbles: true }));
});
add('пан 20 шагов', `кадров ${panFrames.n}: средний ${panFrames.avg} мс, p95 ${panFrames.p95}, максимум ${panFrames.max}`);

// 3. перетаскивание карточки
const card = svg.querySelector('.node-card');
const cr = card.getBoundingClientRect();
ui.graph.fit();
await wait(200);
const dragFrames = await frames(async () => {
  const b = card.getBoundingClientRect();
  card.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: b.left + 60, clientY: b.top + 30, bubbles: true }));
  for (let i = 0; i < 20; i += 1) {
    card.dispatchEvent(new PointerEvent('pointermove', { clientX: b.left + 60 + i * 10, clientY: b.top + 30 + i * 5, bubbles: true }));
    await wait(24);
  }
  card.dispatchEvent(new PointerEvent('pointerup', { clientX: b.left + 260, clientY: b.top + 130, bubbles: true }));
});
add('перетаскивание узла', `кадров ${dragFrames.n}: средний ${dragFrames.avg} мс, p95 ${dragFrames.p95}, максимум ${dragFrames.max}`);
void cr;

// 4. смена выделения (переход по узлам)
const ids = store.project.nodes.map((n) => n.id);
const selFrames = await frames(async () => {
  for (let i = 0; i < 12; i += 1) {
    store.setSelection({ kind: 'node', id: ids[i % ids.length] });
    await wait(30);
  }
});
add('смена выделения 12 раз', `кадров ${selFrames.n}: средний ${selFrames.avg} мс, p95 ${selFrames.p95}, максимум ${selFrames.max}`);

// 5. стоимость одного inspector.render() по замеру напрямую
const t0 = performance.now();
ui.inspector.render();
void body.offsetHeight;
add('инспектор: render + лэйаут', `${R(performance.now() - t0)} мс`);

// 6. открытие обзора сюжета
const t1 = performance.now();
ui.visualizer.open();
const openMs = performance.now() - t1;
await wait(300);
const t2 = performance.now();
ui.visualizer.close();
add('обзор сюжета', `открытие ${R(openMs)} мс, закрытие ${R(performance.now() - t2)} мс`);

__sfOut = { summary: { total: out.length, passed: out.length, failed: 0 }, failed: [], jsErrors: [], checks: out };