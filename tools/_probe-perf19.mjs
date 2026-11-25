// Что дороже в render() инспектора: option-элементы, autosize с принудительным
// лэйаутом, навешивание обработчиков или лэйаут SVG-графа.
const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (v) => Math.round(v * 10) / 10;

const { makeStressFixture } = await import(new URL('../tools/test-fixtures.mjs', document.baseURI).href);
store.setProject(makeStressFixture(), { filePath: null, dirty: false });
await wait(300);

const nodes = store.project.nodes || [];
const choice = nodes.find((n) => n.type === 'choice') || nodes[0];
store.setSelection({ kind: 'node', id: choice.id });
await wait(150);

const root = document.getElementById('inspectorBody');
const out = [];
const add = (name, info) => out.push({ ok: true, name, info });

add('панель', `${root.querySelectorAll('*').length} элементов, ${root.querySelectorAll('option').length} option, узел ${choice.type}`);

const time = (fn) => {
  void root.offsetHeight;
  const t = performance.now();
  fn();
  const inside = performance.now() - t;
  void root.offsetHeight;
  const total = performance.now() - t;
  return { inside: R(inside), layout: R(total - inside) };
};

// 1) чистый рендер панели
const fresh = time(() => ui.inspector.render());

// 2) сколько стоит лэйаут документа, если трогать только панель (граф на месте)
const html = root.innerHTML;
const assign = time(() => {
  root.innerHTML = html;
});

// 3) без option-списков
const noOpts = html
  .replace(/<optgroup[\s\S]*?<\/optgroup>/g, '<option value="">—</option>')
  .replace(/<option[^>]*>[^<]*<\/option>/g, '');
const withoutOpts = time(() => {
  root.innerHTML = noOpts;
});
const graphHiddenProbe = time(() => {
  const g = document.getElementById('graphHost');
  const prev = g.style.display;
  g.style.display = 'none';
  root.innerHTML = html;
  g.style.display = prev;
});

// 4) autosize отдельно
root.innerHTML = html;
await wait(30);
const auto = time(() => {
  root.querySelectorAll('textarea[data-autosize]').forEach((el) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 420)}px`;
  });
});

// 5) обходы querySelectorAll из wireNodeActions
const sels = ['[data-choice-up]', '[data-choice-down]', '[data-choice-del]', '[data-choice-text]', '[data-choice-next]', '[data-choice-cond]', '[data-choice-hint]', '[data-effect-var]', '[data-goto]', '.swatch[data-color]'];
let hits = 0;
const qsa = time(() => {
  for (const s of sels) hits += root.querySelectorAll(s).length;
});

add('render() панели', `${fresh.inside} мс внутри + ${fresh.layout} мс лэйаут = ${R(fresh.inside + fresh.layout)} мс`);
add('только innerHTML той же строки', `${assign.inside} мс + лэйаут ${assign.layout} мс`);
add('без option-списков', `${withoutOpts.inside} мс + лэйаут ${withoutOpts.layout} мс`);
add('innerHTML при скрытом графе', `${graphHiddenProbe.inside} мс + лэйаут ${graphHiddenProbe.layout} мс`);
add('autosize', `${auto.inside} мс, полей ${root.querySelectorAll('textarea[data-autosize]').length}`);
add('querySelectorAll обходы', `${qsa.inside} мс на ${sels.length} селекторов, найдено ${hits}`);

__sfOut = { summary: { total: out.length, passed: out.length, failed: 0 }, failed: [], jsErrors: [], checks: out };