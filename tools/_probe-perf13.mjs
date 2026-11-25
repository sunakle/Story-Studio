// Гипотеза: появление/исчезновение скроллбара меняет ширину → полный релэйаут документа.
const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (v) => Math.round(v * 100) / 100;

const { makeStressFixture } = await import(new URL('../tools/test-fixtures.mjs', document.baseURI).href);
store.setProject(makeStressFixture(), { filePath: null, dirty: false });
await wait(250);
store.setSelection({ kind: 'node', id: store.project.startNodeId });
await wait(80);
ui.inspector.render();
await wait(50);

const root = document.getElementById('inspectorBody');
const html = root.innerHTML;
const panel = root.parentElement;

function measure(label) {
  root.innerHTML = '';
  document.body.offsetHeight;
  const t = performance.now();
  root.innerHTML = html;
  const parse = performance.now() - t;
  const t2 = performance.now();
  root.offsetHeight;
  const layout = performance.now() - t2;
  const scrollW = root.offsetWidth - root.clientWidth;
  const docW = document.documentElement.clientWidth;
  return { label, parse: R(parse), layout: R(layout), scrollW, docW, panelW: panel.offsetWidth };
}

const out = [];
out.push(measure('как есть'));
out.push(measure('как есть (повтор)'));

root.style.scrollbarGutter = 'stable';
out.push(measure('scrollbar-gutter: stable'));
out.push(measure('scrollbar-gutter: stable (повтор)'));

root.style.overflowY = 'scroll';
out.push(measure('overflow-y: scroll'));

root.style.scrollbarGutter = '';
root.style.overflowY = '';
out.push(measure('возврат к исходному'));

__sfOut = {
  summary: { total: 1, passed: 1, failed: 0 },
  failed: [],
  jsErrors: [],
  checks: out.map((m) => ({
    ok: true,
    name: m.label,
    info: 'продолжение ' + m.parse + ' мс, лэйаут ' + m.layout + ' мс, скроллбар ' + m.scrollW + 'px, док ' + m.docW + 'px, панель ' + m.panelW + 'px',
  })),
};