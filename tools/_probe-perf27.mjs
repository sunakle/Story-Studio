// Проверяем дешёвый способ: прятать текст у карточек вне кадра не через
// display на каждом <text>, а классом на карточке (.graph .node-card.is-far text
// { display:none }). Считаем видимость по мировым координатам, без reflow.
const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (v) => Math.round(v * 10) / 10;

const style = document.createElement('style');
style.textContent = '.graph .node-card.is-far text { display: none !important; }';
document.head.appendChild(style);

const { makeStressFixture } = await import(new URL('../tools/test-fixtures.mjs', document.baseURI).href);
store.setProject(makeStressFixture(), { filePath: null, dirty: false });
await wait(300);
store.setSelection({ kind: 'node', id: store.project.startNodeId });
await wait(150);
window.__sfTest.action('view:layout');
await wait(400);
ui.graph.fit();
await wait(250);
ui.graph.setZoom(1);
await wait(250);

const out = [];
const add = (name, info) => out.push({ ok: true, name, info });
const svg = document.getElementById('graph');
const host = document.getElementById('graphHost');
const body = document.getElementById('inspectorBody');

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

// Мировые координаты вьюпорта вычисляем сами: transform у #sfViewport
function cullByClass(margin) {
  const vp = svg.querySelector('#sfViewport');
  const t = vp.getAttribute('transform') || '';
  const m = /translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/.exec(t);
  if (!m) return { shown: 0, hidden: 0 };
  const vx = Number(m[1]);
  const vy = Number(m[2]);
  const k = Number(m[3]);
  const w = host.clientWidth;
  const h = host.clientHeight;
  const left = (-vx) / k - margin;
  const top = (-vy) / k - margin;
  const right = (w - vx) / k + margin;
  const bottom = (h - vy) / k + margin;
  let shown = 0;
  let hidden = 0;
  for (const card of svg.querySelectorAll('.node-card')) {
    const tr = card.getAttribute('transform') || '';
    const mm = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(tr);
    const x = mm ? Number(mm[1]) : 0;
    const y = mm ? Number(mm[2]) : 0;
    const on = x + 220 > left && x < right && y + 164 > top && y < bottom;
    card.classList.toggle('is-far', !on);
    if (on) shown += 1;
    else hidden += 1;
  }
  return { shown, hidden };
}

const c0 = cullByClass(0);
add('цензура классом (кадр)', `в кадре ${c0.shown}, вне ${c0.hidden} — ${await cost()} мс`);

const c1 = cullByClass(400);
add('цензура классом (+400px)', `в кадре ${c1.shown}, вне ${c1.hidden} — ${await cost()} мс`);

// цена самой цензуры (сброс/установка классов у 201 карточки)
const t0 = performance.now();
for (let i = 0; i < 10; i += 1) cullByClass(400);
add('цена пересчёта цензуры', `${R((performance.now() - t0) / 10)} мс на проход`);

// LOD: при мелком зуме текст не нужен вовсе
svg.querySelectorAll('.node-card').forEach((c) => c.classList.remove('is-far'));
style.textContent = '.graph.is-small .node-card text { display: none !important; }';
svg.classList.add('is-small');
add('LOD: мелкий зум, текст скрыт классом', `${await cost()} мс`);
svg.classList.remove('is-small');
add('контроль: всё видно', `${await cost()} мс`);

style.remove();
__sfOut = { summary: { total: out.length, passed: out.length, failed: 0 }, failed: [], jsErrors: [], checks: out };