// Ищем способ разорвать связь «правка в панели → перекладывание SVG-графа».
// Меряет цену принудительного лэйаута после ввода одного символа в поле текста
// в нескольких вариантах изоляции графа.
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
const stage = host.parentElement;
const body = document.getElementById('inspectorBody');
add('граф', `${svg.querySelectorAll('*').length} элементов`);

function reset() {
  for (const el of [host, svg, stage, body]) el.removeAttribute('style');
}

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

reset();
add('как есть', `${await cost()} мс`);

host.style.display = 'none';
add('граф display:none (контроль)', `${await cost()} мс`);
reset();

svg.style.contentVisibility = 'hidden';
add('svg content-visibility:hidden (контроль)', `${await cost()} мс`);
reset();

host.style.position = 'absolute';
host.style.inset = '0';
stage.style.position = 'relative';
add('граф вне flex-потока (absolute)', `${await cost()} мс`);
reset();

host.style.position = 'absolute';
host.style.inset = '0';
stage.style.position = 'relative';
stage.style.contain = 'layout paint size';
add('+ contain:layout paint size на стейдже', `${await cost()} мс`);
reset();

host.style.position = 'absolute';
host.style.inset = '0';
stage.style.position = 'relative';
stage.style.contentVisibility = 'auto';
stage.style.containIntrinsicSize = '800px 800px';
add('+ content-visibility:auto на стейджe', `${await cost()} мс`);
reset();

body.style.contain = 'layout paint style';
add('contain: layout paint style на панели', `${await cost()} мс`);
reset();

svg.style.willChange = 'transform';
add('svg will-change:transform', `${await cost()} мс`);
reset();

reset();
__sfOut = { summary: { total: out.length, passed: out.length, failed: 0 }, failed: [], jsErrors: [], checks: out };