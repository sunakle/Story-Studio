// Сколько стоит ОДНО нажатие клавиши в поле текста и кто виноват в лэйауте:
// сам инспектор, SVG-граф или textarea с field-sizing.
const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (v) => Math.round(v * 10) / 10;

const { makeStressFixture } = await import(new URL('../tools/test-fixtures.mjs', document.baseURI).href);
store.setProject(makeStressFixture(), { filePath: null, dirty: false });
await wait(300);
store.setSelection({ kind: 'node', id: store.project.startNodeId });
await wait(200);

const out = [];
const add = (name, info) => out.push({ ok: true, name, info });
const area = document.querySelector('#inspectorBody textarea[data-focus="text"]');
const graphHost = document.getElementById('graphHost');
const svg = document.getElementById('graph');
add('панель', `${document.getElementById('inspectorBody').querySelectorAll('*').length} элементов, option ${document.getElementById('inspectorBody').querySelectorAll('option').length}`);
add('граф', `${svg.querySelectorAll('*').length} элементов в svg`);

async function keys(n) {
  const samples = [];
  const marks = [];
  for (let i = 0; i < n; i += 1) {
    area.focus();
    const t0 = performance.now();
    area.value += 'а';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    const afterEvent = performance.now();
    void document.getElementById('inspectorBody').offsetHeight;
    const afterLayout = performance.now();
    await wait(80);
    const afterFrame = performance.now();
    samples.push(afterEvent - t0);
    marks.push(afterLayout - afterEvent);
    await wait(0);
    void afterFrame;
  }
  const avg = (list) => R(list.reduce((a, b) => a + b, 0) / list.length);
  return { handler: avg(samples), layout: avg(marks) };
}

const base = await keys(6);
add('нажатие: как есть', `обработчик ${base.handler} мс, лэйаут панели ${base.layout} мс`);

graphHost.style.display = 'none';
await wait(120);
const hidden = await keys(6);
add('нажатие: граф скрыт', `обработчик ${hidden.handler} мс, лэйаут панели ${hidden.layout} мс`);
graphHost.style.display = '';

graphHost.style.contentVisibility = 'auto';
graphHost.style.containIntrinsicSize = '800px 800px';
await wait(120);
const cv = await keys(6);
add('нажатие: content-visibility графа', `обработчик ${cv.handler} мс, лэйаут панели ${cv.layout} мс`);
graphHost.style.contentVisibility = '';
graphHost.style.containIntrinsicSize = '';

// без field-sizing у textarea
document.getElementById('inspectorBody').querySelectorAll('textarea[data-autosize]').forEach((t) => {
  t.removeAttribute('data-autosize');
  t.style.fieldSizing = 'fixed';
});
await wait(120);
const noFs = await keys(6);
add('нажатие: textarea без field-sizing', `обработчик ${noFs.handler} мс, лэйаут панели ${noFs.layout} мс`);

__sfOut = { summary: { total: out.length, passed: out.length, failed: 0 }, failed: [], jsErrors: [], checks: out };