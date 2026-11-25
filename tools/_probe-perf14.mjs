// Меняется ли геометрия графа при перерисовке инспектора?
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
const right = root.closest('.panel-right') || root.parentElement;
const main = host.parentElement;

const html = root.innerHTML;
const geom = () => ({
  host: host.offsetWidth + '×' + host.offsetHeight,
  svg: svg.getAttribute('width') + '×' + svg.getAttribute('height'),
  right: right.offsetWidth + '×' + right.offsetHeight,
  main: main.offsetWidth + '×' + main.offsetHeight,
  doc: document.documentElement.clientWidth + '×' + document.documentElement.scrollHeight,
  root: root.offsetWidth + '×' + root.offsetHeight,
});

root.innerHTML = '';
document.body.offsetHeight;
const before = geom();

const t = performance.now();
root.innerHTML = html;
const parse = performance.now() - t;
const t2 = performance.now();
root.offsetHeight;
const layout = performance.now() - t2;
const after = geom();

// повторное присвоение того же html при неизменной высоте
const t3 = performance.now();
root.innerHTML = html;
const parse2 = performance.now() - t3;
const t4 = performance.now();
root.offsetHeight;
const layout2 = performance.now() - t4;

// а теперь при фиксированной высоте панели
right.style.minHeight = '0';
right.style.overflow = 'hidden';
right.style.height = right.offsetHeight + 'px';
root.innerHTML = '';
document.body.offsetHeight;
const t5 = performance.now();
root.innerHTML = html;
const parse3 = performance.now() - t5;
const t6 = performance.now();
root.offsetHeight;
const layout3 = performance.now() - t6;
right.style.height = '';
right.style.overflow = '';
right.style.minHeight = '';

__sfOut = {
  summary: { total: 1, passed: 1, failed: 0 },
  failed: [],
  jsErrors: [],
  checks: [
    { ok: true, name: 'до правки', info: JSON.stringify(before) },
    { ok: true, name: 'после правки', info: JSON.stringify(after) },
    { ok: true, name: 'лэйаут (первое присвоение)', info: R(parse) + ' мс разбор, ' + R(layout) + ' мс лэйаут' },
    { ok: true, name: 'лэйаут (тот же html, та же высота)', info: R(parse2) + ' мс разбор, ' + R(layout2) + ' мс лэйаут' },
    { ok: true, name: 'лэйаут при фиксированной высоте панели', info: R(parse3) + ' мс разбор, ' + R(layout3) + ' мс лэйаут' },
  ],
};