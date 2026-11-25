// Проверка гипотезы: узкое место — принудительный лэйаут после innerHTML.
const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { makeStressFixture } = await import(new URL('../tools/test-fixtures.mjs', document.baseURI).href);
store.setProject(makeStressFixture(), { filePath: null, dirty: false });
await wait(250);
store.setSelection({ kind: 'node', id: store.project.startNodeId });
await wait(80);
ui.inspector.render();
await wait(50);

const root = document.getElementById('inspectorBody');
const html = root.innerHTML;

// 1. присвоение html без принудительного лэйаута
let t = performance.now();
root.innerHTML = html;
const assignOnly = performance.now() - t;

// 2. первый принудительный лэйаут после присвоения
t = performance.now();
const h1 = root.offsetHeight;
const layoutAfterAssign = performance.now() - t;

// 3. последующие чтения лэйаута (кэш)
t = performance.now();
for (let i = 0; i < 20; i += 1) root.offsetHeight;
const layoutCached = (performance.now() - t) / 20;

// 4. чтение scrollHeight у textarea
const ta = root.querySelector('textarea[data-autosize]');
t = performance.now();
let sh = 0;
if (ta) sh = ta.scrollHeight;
const scrollRead = performance.now() - t;

// 5. полный документ: лэйаут после изменения
t = performance.now();
document.body.offsetHeight;
const bodyLayout = performance.now() - t;

// 6. сколько всего узлов в документе
const all = document.querySelectorAll('*').length;

__sfOut = {
  summary: { total: 1, passed: 1, failed: 0 },
  failed: [],
  jsErrors: [],
  checks: [
    { ok: true, name: 'присвоение html', info: round(assignOnly) + ' мс' },
    { ok: true, name: 'первый лэйаут после присвоения (root.offsetHeight)', info: round(layoutAfterAssign) + ' мс, высота ' + h1 },
    { ok: true, name: 'повторное чтение лэйаута', info: round(layoutCached) + ' мс' },
    { ok: true, name: 'textarea.scrollHeight', info: round(scrollRead) + ' мс, высота ' + sh },
    { ok: true, name: 'лэйаут документа', info: round(bodyLayout) + ' мс' },
    { ok: true, name: 'элементов в документе', info: String(all) },
  ],
};

function round(v) {
  return Math.round(v * 100) / 100;
}