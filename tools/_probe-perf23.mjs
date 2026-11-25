// Что именно в SVG стоит денег при лэйауте: текст, карточки целиком или рёбра.
// Меряем принудительный лэйаут панели после смены одной подписи.
const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (v) => Math.round(v * 10) / 10;

const res = await window.sf.file.openPath('demo/stress-overview.sfproj');
store.setProject(JSON.parse(res.content), { filePath: null, dirty: false });
await wait(300);
store.setSelection({ kind: 'node', id: store.project.startNodeId });
await wait(200);

const out = [];
const add = (name, info) => out.push({ ok: true, name, info });
const host = document.getElementById('graphHost');
const svg = document.getElementById('graph');
const body = document.getElementById('inspectorBody');
const textCount = svg.querySelectorAll('text').length;
const cards = svg.querySelectorAll('.node-card').length;
const edges = svg.querySelectorAll('.edges [data-edge]').length;
add('состав svg', `${svg.querySelectorAll('*').length} элементов: ${cards} карточек, ${edges} рёбер, ${textCount} текстовых узлов`);

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

const stored = { text: [], nums: [], cards: [] };

add('как есть', `${await cost()} мс`);

// 1. прячем весь текст в графе (display:none на text)
svg.querySelectorAll('text').forEach((t) => {
  stored.text.push([t, t.getAttribute('style')]);
  t.style.display = 'none';
});
add('текст в графе скрыт', `${await cost()} мс`);
stored.text.forEach(([t, s]) => {
  if (s == null) t.removeAttribute('style');
  else t.setAttribute('style', s);
});

// 2. карточки скрыты (только рёбра)
svg.querySelectorAll('.node-card').forEach((c) => {
  stored.cards.push([c, c.getAttribute('style')]);
  c.style.display = 'none';
});
add('карточки скрыты (видны рёбра)', `${await cost()} мс`);
stored.cards.forEach(([c, s]) => {
  if (s == null) c.removeAttribute('style');
  else c.setAttribute('style', s);
});

// 3. рёбра скрыты (только карточки)
for (const e of svg.querySelectorAll('.edges > *')) {
  stored.nums.push([e, e.getAttribute('style')]);
  e.style.display = 'none';
}
add('рёбра скрыты (видны карточки)', `${await cost()} мс`);
stored.nums.forEach(([e, s]) => {
  if (s == null) e.removeAttribute('style');
  else e.setAttribute('style', s);
});

// 4. в каждой карточке оставлен только фон (без текста, бейджей, иконок)
for (const c of svg.querySelectorAll('.node-card')) {
  for (const child of [...c.children]) {
    if (!child.classList.contains('node-bg')) {
      stored.nums.push([child, child.getAttribute('style')]);
      child.style.display = 'none';
    }
  }
}
add('карточки как прямоугольники (без текста)', `${await cost()} мс`);
stored.nums.forEach(([e, s]) => {
  if (s == null) e.removeAttribute('style');
  else e.setAttribute('style', s);
});

add('контроль: как есть снова', `${await cost()} мс`);

__sfOut = { summary: { total: out.length, passed: out.length, failed: 0 }, failed: [], jsErrors: [], checks: out };