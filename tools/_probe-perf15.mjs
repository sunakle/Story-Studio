// Что именно стоит 35 мс: поддерево svg, общий релэйаут или пересчёт стилей.
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
const host = document.getElementById('graphHost');
const svg = document.getElementById('graph');
const html = root.innerHTML;
const svgHtml = svg.innerHTML;
const out = [];

function run(label, prep, undo) {
  if (prep) prep();
  root.innerHTML = '';
  document.body.offsetHeight;
  const t = performance.now();
  root.innerHTML = html;
  const parse = performance.now() - t;
  const t2 = performance.now();
  root.offsetHeight;
  const layout = performance.now() - t2;
  if (undo) undo();
  out.push({ label, parse: R(parse), layout: R(layout) });
}

run('как есть');
svg.innerHTML = '';
run('поддерево svg пустое', () => { svg.innerHTML = ''; }, () => { svg.innerHTML = svgHtml; });
run('обратно с поддеревом');
run('без правки DOM (только чтение)', null, null);
host.style.contentVisibility = 'auto';
host.style.containIntrinsicSize = '800px 800px';
run('content-visibility на graphHost', null, () => { host.style.contentVisibility = ''; host.style.containIntrinsicSize = ''; });
svg.style.contain = 'strict';
svg.style.width = '100%';
svg.style.height = '100%';
run('contain:strict + размеры на svg', null, () => { svg.style.contain = ''; });
host.style.contain = 'strict';
run('contain:strict на graphHost', null, () => { host.style.contain = ''; });
document.documentElement.style.contain = 'layout style';
run('contain на html', null, () => { document.documentElement.style.contain = ''; });

const svgCount = svg.querySelectorAll('*').length;
const cards = svg.querySelectorAll('.node-card').length;

__sfOut = {
  summary: { total: 1, passed: 1, failed: 0 },
  failed: [],
  jsErrors: [],
  checks: [
    { ok: true, name: 'элементов в svg / карточек / в панели', info: svgCount + ' / ' + cards + ' / ' + root.querySelectorAll('*').length },
    ...out.map((m) => ({ ok: true, name: m.label, info: R(m.parse) + ' мс разбор, ' + R(m.layout) + ' мс лэйаут' })),
  ],
};