// Где именно теряется время в инспекторе на 200 узлах.
const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const res = await window.sf.file.openPath('demo/stress-overview.sfproj');
store.setProject(JSON.parse(res.content), { filePath: null, dirty: false });
await wait(250);
const nodeId = store.project.startNodeId;
store.setSelection({ kind: 'node', id: nodeId });
ui.inspector.render();
await wait(80);

const root = document.getElementById('inspectorBody');
const html = root.innerHTML;
const sizeKb = Math.round((html.length / 1024) * 10) / 10;
const optionCount = root.querySelectorAll('option').length;

function median(fn, rounds = 8) {
  const times = [];
  for (let i = 0; i < rounds; i += 1) {
    const t0 = performance.now();
    fn(i);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return Math.round(times[Math.floor(times.length / 2)] * 10) / 10;
}

const tRender = median(() => ui.inspector.render());
const tAssign = median(() => {
  root.innerHTML = '';
  root.innerHTML = html;
});
const tAssignNoReset = median(() => {
  root.innerHTML = html;
});
const tClone = median(() => { html.slice(0); });

// граф и панели на этом же проекте
ui.graph.fit();
const tGraphRender = median(() => ui.graph.refresh(), 4);

// повторный рендер без смены выделения (как после каждой правки)
const tSecond = median(() => ui.inspector.render(), 6);

// правка только поля text: полный путь клика
const ta = root.querySelector('textarea[data-bind="text"]');
const t1 = performance.now();
if (ta) {
  ta.value = 'Проба';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}
const tInputDispatch = Math.round((performance.now() - t1) * 10) / 10;
await wait(300);

__sfOut = {
  summary: { total: 1, passed: 1, failed: 0 },
  failed: [],
  jsErrors: [],
  checks: [
    { ok: true, name: 'ui.inspector.render()', info: tRender + ' мс' },
    { ok: true, name: 'перезапись того же innerHTML', info: tAssign + ' мс' },
    { ok: true, name: 'innerHTML без сброса', info: tAssignNoReset + ' мс' },
    { ok: true, name: 'второй рендер подряд', info: tSecond + ' мс' },
    { ok: true, name: 'ui.graph.refresh()', info: tGraphRender + ' мс' },
    { ok: true, name: 'размер html панели', info: sizeKb + ' КБ' },
    { ok: true, name: 'option-ов в панели', info: String(optionCount) },
    { ok: true, name: 'dispatch input текста', info: tInputDispatch + ' мс' },
    { ok: true, name: 'снимок html', info: String(tClone) },
  ],
};