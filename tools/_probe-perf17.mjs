// Что именно форсирует лэйаут: autosize (чтение scrollHeight) или focus().
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
const ta = root.querySelector('textarea[data-autosize]');

root.innerHTML = '';
document.body.offsetHeight;

const t0 = performance.now();
root.innerHTML = html;
const assign = performance.now() - t0;

const t1 = performance.now();
const sh = ta.scrollHeight;
const readScroll = performance.now() - t1;

const t2 = performance.now();
ta.style.height = 'auto';
ta.style.height = sh + 2 + 'px';
const autosize = performance.now() - t2;

const t3 = performance.now();
root.offsetHeight;
const layoutCached = performance.now() - t3;

// второй проход: тот же html, но autosize через rAF (после лэйаута)
root.innerHTML = '';
document.body.offsetHeight;
root.innerHTML = html;
const ta2 = root.querySelector('textarea[data-autosize]');
const t4 = performance.now();
let a4 = 0;
requestAnimationFrame(() => {});
await new Promise((r) => requestAnimationFrame(() => r()));
a4 = performance.now() - t4;
__sfOut = {
  summary: { total: 1, passed: 1, failed: 0 },
  failed: [],
  jsErrors: [],
  checks: [
    { ok: true, name: 'присвоение html', info: R(assign) + ' мс' },
    { ok: true, name: 'textarea.scrollHeight (первое чтение)', info: R(readScroll) + ' мс, высота ' + sh },
    { ok: true, name: 'установка высоты после чтения', info: R(autosize) + ' мс' },
    { ok: true, name: 'последующий лэйаут', info: R(layoutCached) + ' мс' },
    { ok: true, name: 'rAF-кадр после присвоения', info: R(a4) + ' мс' },
    { ok: true, name: 'scrollHeight у второго textarea', info: String(ta2 ? ta2.scrollHeight : 'нет') },
  ],
};