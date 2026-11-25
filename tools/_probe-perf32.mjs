// Что ещё может тормозить на реальном проекте: автосохранение (сериализация
// проекта с картинками), автопроверка валидации и клонирование проекта в apply.
const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (v) => Math.round(v * 10) / 10;

const out = [];
const add = (name, info) => out.push({ ok: true, name, info });

// 1. Демо с картинкой + 200 реплик: имитируем «тяжёлый» проект.
const { makeStoryFixture, makeStressFixture } = await import(new URL('../tools/test-fixtures.mjs', document.baseURI).href);
const demo = makeStoryFixture();
const media = Object.keys(demo.media || {});
add('демо', `узлов ${demo.nodes.length}, картинок ${media.length}, размер ${JSON.stringify(demo).length} байт`);

const big = makeStressFixture();
// переносим картинку из демо в большой проект — так выглядит реальный проект с фото
big.media = demo.media || {};
const withPhoto = big.nodes.find((n) => n.type === 'scene') || big.nodes[0];
withPhoto.media = media.slice(0, 1);
withPhoto.previewId = media[0] || '';
store.setProject(big, { filePath: null, dirty: false });
await wait(400);
add('большой проект с фото', `узлов ${store.project.nodes.length}, JSON ${R(JSON.stringify(store.project).length / 1024)} КБ`);

// 2. цена клонирования проекта в одной правке
const node = store.project.nodes.find((n) => n.type === 'line');
const times = [];
for (let i = 0; i < 6; i += 1) {
  const t = performance.now();
  store.apply([{ op: 'updateNode', id: node.id, patch: { text: `Правка ${i}` } }], { label: 'замер' });
  times.push(performance.now() - t);
}
add('store.apply (одна правка)', `${R(times.reduce((a, b) => a + b, 0) / times.length)} мс в среднем на ${store.project.nodes.length} узлах`);

// 3. сериализация для автосохранения
const t0 = performance.now();
const json = JSON.stringify(store.project, null, 2);
add('JSON.stringify для автосохранения', `${R(performance.now() - t0)} мс, ${R(json.length / 1024)} КБ`);

// 4. валидация
const t1 = performance.now();
window.__sfTest.validateProject(store.project);
add('validateProject', `${R(performance.now() - t1)} мс`);

// 5. автосохранение в сборе: правка → 800 мс → запись
const t2 = performance.now();
store.apply([{ op: 'updateNode', id: node.id, patch: { text: 'Правка для автосохранения' } }], { label: 'замер' });
await wait(1200);
add('правка + автосохранение (пауза 1200)', `${R(performance.now() - t2)} мс`);

// 6. нажатия при наличии фото
store.setSelection({ kind: 'node', id: node.id });
await wait(300);
const body = document.getElementById('inspectorBody');
const area = body.querySelector('textarea[data-focus="text"]');
const gaps = [];
let lastT = performance.now();
let running = true;
const loop = () => {
  const now = performance.now();
  gaps.push(now - lastT);
  lastT = now;
  if (running) requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
const t3 = performance.now();
for (let i = 0; i < 16; i += 1) {
  area.value += 'а';
  area.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(40);
}
running = false;
await wait(150);
gaps.shift();
const sorted = [...gaps].sort((a, b) => a - b);
add(
  'набор с фото в проекте',
  `${R(performance.now() - t3)} мс; кадров ${gaps.length}: средний ${R(gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length))} мс, p95 ${R(sorted[Math.floor(sorted.length * 0.95)] || 0)}, максимум ${R(sorted[sorted.length - 1] || 0)}`,
);

void ui;
__sfOut = { summary: { total: out.length, passed: out.length, failed: 0 }, failed: [], jsErrors: [], checks: out };