// Стресс-проект держит все узлы в позиции {0,0} — карточки лежат стопкой.
// Проверяем цену лэйаута на разложенном проекте (после автораскладки) и
// сколько текста реально попадает в кадр при рабочем зуме.
const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (v) => Math.round(v * 10) / 10;

const { makeStressFixture } = await import(new URL('../tools/test-fixtures.mjs', document.baseURI).href);
store.setProject(makeStressFixture(), { filePath: null, dirty: false });
await wait(300);
store.setSelection({ kind: 'node', id: store.project.startNodeId });
await wait(150);

const out = [];
const add = (name, info) => out.push({ ok: true, name, info });
const svg = document.getElementById('graph');
const body = document.getElementById('inspectorBody');

async function cost(n = 5) {
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

add('до раскладки', `${svg.querySelectorAll('text').length} текстов, ${await cost()} мс`);

window.__sfTest.action('view:layout');
await wait(400);
ui.graph.fit();
await wait(250);
ui.graph.setZoom(1);
await wait(250);

add('после автораскладки', `${svg.querySelectorAll('text').length} текстов, зум ${R(ui.graph.getZoom())}`);
add('разложено, зум 1', `${await cost()} мс`);

// цензура по вьюпорту с запасом
function cull(margin) {
  const box = svg.getBoundingClientRect();
  let hidden = 0;
  let shown = 0;
  for (const card of svg.querySelectorAll('.node-card')) {
    const r = card.getBoundingClientRect();
    const on = r.right > box.left - margin && r.left < box.right + margin && r.bottom > box.top - margin && r.top < box.bottom + margin;
    for (const t of card.querySelectorAll('text')) {
      t.style.display = on ? '' : 'none';
      if (on) shown += 1;
      else hidden += 1;
    }
  }
  return { shown, hidden };
}

const c0 = cull(0);
add('цензура без запаса', `показано ${c0.shown}, скрыто ${c0.hidden} — ${await cost()} мс`);
svg.querySelectorAll('text').forEach((t) => {
  t.style.display = '';
});

const c1 = cull(400);
add('цензура с запасом 400px', `показано ${c1.shown}, скрыто ${c1.hidden} — ${await cost()} мс`);
svg.querySelectorAll('text').forEach((t) => {
  t.style.display = '';
});

ui.graph.fit();
await wait(250);
add('вписать целиком', `зум ${R(ui.graph.getZoom())}, ${await cost()} мс`);

__sfOut = { summary: { total: out.length, passed: out.length, failed: 0 }, failed: [], jsErrors: [], checks: out };