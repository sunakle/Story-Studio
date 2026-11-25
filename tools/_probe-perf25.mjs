// Проверяем две стратегии для текста в графе:
// 1) LOD — при мелком зуме подписи карточек не нужны, их можно не раскладывать;
// 2) цензура по вьюпорту — при крупном зуме видны единицы карточек.
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
const texts = [...svg.querySelectorAll('text')];
add('текстовых узлов', String(texts.length));

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

function cullText(margin) {
  const box = svg.getBoundingClientRect();
  let shown = 0;
  let hidden = 0;
  for (const card of svg.querySelectorAll('.node-card')) {
    const r = card.getBoundingClientRect();
    const on =
      r.right > box.left - margin &&
      r.left < box.right + margin &&
      r.bottom > box.top - margin &&
      r.top < box.bottom + margin;
    for (const t of card.querySelectorAll('text')) {
      t.style.display = on ? '' : 'none';
      if (on) shown += 1;
      else hidden += 1;
    }
    if (on) shown += 0;
  }
  return { shown, hidden };
}

ui.graph.fit();
await wait(200);
add('зум после «вписать»', String(R(ui.graph.getZoom())));
add('как есть (мелкий зум)', `${await cost()} мс`);

ui.graph.setZoom(1);
await wait(250);
add('зум 1', String(R(ui.graph.getZoom())));
add('зум 1: как есть', `${await cost()} мс`);

const m0 = cullText(0);
add('зум 1: цензура без запаса', `текст у ${m0.shown}, скрыт у ${m0.hidden} — ${await cost()} мс`);
texts.forEach((t) => {
  t.style.display = '';
});

const m200 = cullText(300);
add('зум 1: цензура с запасом 300px', `текст у ${m200.shown}, скрыт у ${m200.hidden} — ${await cost()} мс`);
texts.forEach((t) => {
  t.style.display = '';
});

// LOD: подписи скрыты целиком, как при мелком зуме
texts.forEach((t) => {
  t.style.display = 'none';
});
ui.graph.fit();
await wait(200);
add('LOD вписать: текст скрыт', `${await cost()} мс`);
texts.forEach((t) => {
  t.style.display = '';
});
add('контроль вписать: текст виден', `${await cost()} мс`);

__sfOut = { summary: { total: out.length, passed: out.length, failed: 0 }, failed: [], jsErrors: [], checks: out };