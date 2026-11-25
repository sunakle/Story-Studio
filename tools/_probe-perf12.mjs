// Изоляция графа от общего лэйаута.
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
const graphSvg = document.querySelector('.graph svg') || document.getElementById('graph');
const graphWrap = graphSvg.parentElement;
const stage = graphSvg.closest('.stage') || graphWrap;

function measure(label) {
  root.innerHTML = '';
  document.body.offsetHeight;
  const t = performance.now();
  root.innerHTML = html;
  const parse = performance.now() - t;
  const t2 = performance.now();
  root.offsetHeight;
  const layout = performance.now() - t2;
  return { label, parse: R(parse), layout: R(layout) };
}

const out = [];
const reset = () => {
  graphSvg.style.contain = '';
  graphWrap.style.contain = '';
  stage.style.contain = '';
  graphSvg.style.contentVisibility = '';
};

out.push(measure('как есть'));
reset();

graphSvg.style.contain = 'layout paint';
out.push(measure('contain: layout paint на svg'));
reset();

graphSvg.style.contain = 'strict';
out.push(measure('contain: strict на svg'));
reset();

graphWrap.style.contain = 'layout paint';
out.push(measure('contain: layout paint на обёртке'));
reset();

stage.style.contain = 'layout paint';
out.push(measure('contain: layout paint на stage'));
reset();

stage.style.contain = 'strict';
out.push(measure('contain: strict на stage'));
reset();

// Второй замер каждого варианта — чтобы исключить прогрев
out.push(measure('как есть (повтор)'));
reset();
graphSvg.style.contain = 'layout paint';
out.push(measure('contain layout paint на svg (повтор)'));

reset();
const wrapTag = graphWrap.tagName + '.' + (graphWrap.className || '');
const stageTag = stage.tagName + '.' + (stage.className || '');

__sfOut = {
  summary: { total: 1, passed: 1, failed: 0 },
  failed: [],
  jsErrors: [],
  checks: [
    { ok: true, name: 'обёртка svg / stage', info: wrapTag + ' | ' + stageTag },
    ...out.map((m) => ({ ok: true, name: m.label, info: 'продолжение ' + m.parse + ' мс, лэйаут ' + m.layout + ' мс' })),
  ],
};