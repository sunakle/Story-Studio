// Тот же интерактив, но при рабочем зуме 1.0 (а не 0.3 после «вписать»):
// именно так пользователь и работает, когда до него доносятся лаги.
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
await wait(200);
ui.graph.setZoom(1);
await wait(250);

// Инспектор показывает поле текста только у реплики: выбираем line-узел.
const lineNode = store.project.nodes.find((n) => n.type === 'line');
store.setSelection({ kind: 'node', id: lineNode ? lineNode.id : store.project.startNodeId });
await wait(250);

const out = [];
const add = (name, info) => out.push({ ok: true, name, info });
const host = document.getElementById('graphHost');
const svg = document.getElementById('graph');
const body = document.getElementById('inspectorBody');
const area = body.querySelector('textarea[data-focus="text"]') || body.querySelector('textarea');

add('условия', `зум ${R(ui.graph.getZoom())}, класс svg: ${svg.className}`);
add('текста раскладывается', `${[...svg.querySelectorAll('.node-card')].filter((c) => !c.classList.contains('is-far')).length} карточек из ${svg.querySelectorAll('.node-card').length} не отсечены`);

async function frames(action, ms = 400) {
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
  return { n: gaps.length, max: R(sorted[sorted.length - 1] || 0), p95: R(sorted[Math.floor(sorted.length * 0.95)] || 0), avg: R(gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length)) };
}

// 1. набор текста при зуме 1
const typeFrames = await frames(async () => {
  for (let i = 0; i < 16; i += 1) {
    area.value += 'а';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(30);
  }
});
add('набор при зуме 1', `кадров ${typeFrames.n}: средний ${typeFrames.avg} мс, p95 ${typeFrames.p95}, максимум ${typeFrames.max}`);

// 2. пан при зуме 1
const rect = host.getBoundingClientRect();
const panFrames = await frames(async () => {
  svg.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, isPrimary: true, clientX: rect.left + 40, clientY: rect.top + 400, bubbles: true }));
  for (let i = 0; i < 24; i += 1) {
    svg.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, isPrimary: true, clientX: rect.left + 40 + i * 14, clientY: rect.top + 400 - i * 4, bubbles: true }));
    await wait(16);
  }
  svg.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, isPrimary: true, clientX: rect.left + 360, clientY: rect.top + 300, bubbles: true }));
});
add('пан при зуме 1', `кадров ${panFrames.n}: средний ${panFrames.avg} мс, p95 ${panFrames.p95}, максимум ${panFrames.max}`);

// 3. зум при зуме 1
const zoomFrames = await frames(async () => {
  for (let i = 0; i < 16; i += 1) {
    host.dispatchEvent(new WheelEvent('wheel', { deltaY: i < 8 ? -100 : 100, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true }));
    await wait(20);
  }
});
add('зум при зуме ~1', `кадров ${zoomFrames.n}: средний ${zoomFrames.avg} мс, p95 ${zoomFrames.p95}, максимум ${zoomFrames.max}`);

// 4. один render инспектора и смена выделения — прямой замер
ui.graph.setZoom(1);
await wait(200);
const t0 = performance.now();
ui.inspector.render();
void body.offsetHeight;
add('render инспектора + лэйаут', `${R(performance.now() - t0)} мс`);

const ids = store.project.nodes.map((n) => n.id);
const selTimes = [];
for (let i = 0; i < 10; i += 1) {
  const t = performance.now();
  store.setSelection({ kind: 'node', id: ids[(i * 7) % ids.length] });
  await wait(40);
  selTimes.push(performance.now() - t - 40);
}
add('смена выделения', `средняя работа ${R(selTimes.reduce((a, b) => a + b, 0) / selTimes.length)} мс`);

// 5. автораскладка
const t1 = performance.now();
window.__sfTest.action('view:layout');
await wait(50);
add('автораскладка 201 узла', `${R(performance.now() - t1)} мс (включая кадр)`);

// 6. бейдж валидации после правки
const t2 = performance.now();
store.apply([{ op: 'updateNode', id: ids[0], patch: { text: 'Проверка валидации' } }], { label: 'тест' });
await wait(600);
add('правка + пересчёт валидации', `${R(performance.now() - t2)} мс (с паузой 600 мс)`);

void area;
__sfOut = { summary: { total: out.length, passed: out.length, failed: 0 }, failed: [], jsErrors: [], checks: out };