// Стоимость точечных изменений в графе против полной пересборки.
const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (v) => Math.round(v * 100) / 100;

const res = await window.sf.file.openPath('demo/stress-overview.sfproj');
store.setProject(JSON.parse(res.content), { filePath: null, dirty: false });
await wait(250);
ui.graph.refresh(true);
store.setSelection({ kind: 'node', id: store.project.startNodeId });
await wait(80);

const svg = document.getElementById('graph');
const card = svg.querySelector('.node-card');
const textEl = card.querySelector('.node-text');
const body = document.body;
const warm = () => body.offsetHeight;
const out = [];
const measure = (label, fn) => {
  warm();
  const t = performance.now();
  fn();
  const mut = performance.now() - t;
  const t2 = performance.now();
  body.offsetHeight;
  const layout = performance.now() - t2;
  out.push({ label, mut: R(mut), layout: R(layout) });
};

measure('ничего не делать (базовая цена лэйаута)', () => {});
measure('правка текста одной карточки', () => { textEl.textContent = 'правка'; });
measure('правка текста второй раз', () => { textEl.textContent = 'правка2'; });
const speaker = card.querySelector('.node-speaker');
measure('правка подписи спикера', () => { if (speaker) speaker.textContent = 'Спикер'; });
const path = svg.querySelector('.edge');
measure('перезапись d у одного ребра', () => { if (path) path.setAttribute('d', path.getAttribute('d')); });
measure('класс на карточке', () => { card.classList.toggle('dim'); });
measure('сдвиг карточки (transform)', () => {
  const t = card.getAttribute('transform');
  card.setAttribute('transform', t.replace(/translate\([^)]*\)/, 'translate(1 1)'));
});
const svgHtml = svg.innerHTML;
measure('полная пересборка svg (innerHTML)', () => { svg.innerHTML = svgHtml; });
measure('ещё одна пересборка', () => { svg.innerHTML = svgHtml; });

// убрать/вернуть svg через placeholder (replaceChild фрагментом отвязывает узел)
const host = svg.parentElement;
const ph = document.createElement('div');
host.replaceChild(ph, svg);
measure('без svg в документе', () => {});
host.replaceChild(svg, ph);
measure('svg вернулся в документ', () => {});

const cards = svg.querySelectorAll('.node-card').length;
const els = svg.querySelectorAll('*').length;
const sheets = [...document.styleSheets].map((s) => {
  try {
    return s.cssRules.length;
  } catch {
    return -1;
  }
});

__sfOut = {
  summary: { total: 1, passed: 1, failed: 0 },
  failed: [],
  jsErrors: [],
  checks: [
    { ok: true, name: 'карточек / элементов в svg', info: cards + ' / ' + els },
    { ok: true, name: 'таблиц стилей / правил', info: sheets.length + ' / ' + sheets.filter((n) => n > 0).reduce((a, b) => a + b, 0) },
    ...out.map((m) => ({ ok: true, name: m.label, info: 'мутация ' + m.mut + ' мс, лэйаут ' + m.layout + ' мс' })),
  ],
};