// Вклад отдельных частей документа в стоимость лэйаута.
const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (v) => Math.round(v * 100) / 100;

const res = await window.sf.file.openPath('demo/stress-overview.sfproj');
store.setProject(JSON.parse(res.content), { filePath: null, dirty: false });
await wait(250);
store.setSelection({ kind: 'node', id: store.project.startNodeId });
await wait(80);
ui.inspector.render();
await wait(50);

const root = document.getElementById('inspectorBody');
const html = root.innerHTML;
const graph = document.getElementById('graph');
const panels = document.getElementById('leftPanel');

function measure(label) {
  root.innerHTML = '';
  document.body.offsetHeight;
  const t = performance.now();
  root.innerHTML = html;
  const first = performance.now() - t;
  const t2 = performance.now();
  root.offsetHeight;
  const layout = performance.now() - t2;
  return { label, parse: R(first), layout: R(layout) };
}

const full = measure('всё как есть');

graph.style.visibility = 'hidden';
const hiddenGraph = measure('граф скрыт (visibility)');
graph.style.visibility = '';

graph.style.display = 'none';
const noneGraph = measure('граф убран (display:none)');
graph.style.display = '';

root.style.contain = 'layout paint style';
const contained = measure('contain на панели');
root.style.contain = '';

root.style.contentVisibility = 'auto';
const cv = measure('content-visibility на панели');
root.style.contentVisibility = '';

const cards = graph.querySelectorAll('.node-card').length;
const svgNodes = graph.querySelectorAll('*').length;

__sfOut = {
  summary: { total: 1, passed: 1, failed: 0 },
  failed: [],
  jsErrors: [],
  checks: [
    { ok: true, name: 'карточек в графе / элементов в svg', info: cards + ' / ' + svgNodes },
    ...full && [full, hiddenGraph, noneGraph, contained, cv].map((m) => ({
      ok: true,
      name: m.label,
      info: 'продолжение ' + m.parse + ' мс, лэйаут ' + m.layout + ' мс',
    })),
  ],
};