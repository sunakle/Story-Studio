// Виноват текст в SVG: 1239 текстовых узлов дают ~45 мс, без них — 3.7 мс.
// Проверяем, как цена зависит от числа текстовых узлов и помогает ли
// отсечение невидимых карточек (цензура по вьюпорту).
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
const svg = document.getElementById('graph');
const body = document.getElementById('inspectorBody');
const allTexts = [...svg.querySelectorAll('text')];
add('текстовых узлов', String(allTexts.length));

async function cost(n = 6) {
  const area = body.querySelector('textarea[data-focus="text"]');
  const samples = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    area.value += 'а';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    void body.offsetHeight;
    samples.push(performance.now() - t0);
    await wait(40);
  }
  area.value = area.value.slice(0, -n);
  return R(samples.reduce((a, b) => a + b, 0) / samples.length);
}

function showTexts(limit) {
  allTexts.forEach((t, i) => {
    t.style.display = i < limit ? '' : 'none';
  });
}

for (const limit of [allTexts.length, 800, 400, 200, 100, 40, 0]) {
  showTexts(limit);
  add(`текст: оставлено ${limit}`, `${await cost()} мс`);
}
allTexts.forEach((t) => {
  t.style.display = '';
});

// цензура по вьюпорту: текст только у карточек, попавших в видимую область
const view = svg.querySelector('#sfViewport') || svg;
const box = svg.getBoundingClientRect();
const visible = [];
for (const card of svg.querySelectorAll('.node-card')) {
  const r = card.getBoundingClientRect();
  const on = r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom;
  card.querySelectorAll('text').forEach((t) => {
    t.style.display = on ? '' : 'none';
  });
  if (on) visible.push(card);
}
add('цензура по вьюпорту', `${visible.length} карточек из ${svg.querySelectorAll('.node-card').length} — ${await cost()} мс`);
allTexts.forEach((t) => {
  t.style.display = '';
});

add('контроль: всё видимо', `${await cost()} мс`);
void view;

__sfOut = { summary: { total: out.length, passed: out.length, failed: 0 }, failed: [], jsErrors: [], checks: out };