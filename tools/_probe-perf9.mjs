const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { makeStressFixture } = await import(new URL('../tools/test-fixtures.mjs', document.baseURI).href);
store.setProject(makeStressFixture(), { filePath: null, dirty: false });
await wait(250);
store.setSelection({ kind: 'node', id: store.project.startNodeId });
await wait(80);

window.__sfProf = {};
for (let i = 0; i < 6; i += 1) {
  ui.inspector.render();
  await wait(10);
}
const p = window.__sfProf;
const calls = p.calls || 1;
const per = (v) => Math.round(((v || 0) / calls) * 10) / 10;
const keys = ['w.head', 'w.effects', 'w.choices', 'w.ceffects', 'w.branches', 'w.tail'];

__sfOut = {
  summary: { total: 1, passed: 1, failed: 0 },
  failed: [],
  jsErrors: [],
  checks: [
    { ok: true, name: 'wireNodeActions всего', info: per(p.wireNodeActions) + ' мс' },
    ...keys.map((k) => ({ ok: true, name: '  · ' + k, info: per(p[k]) + ' мс' })),
    { ok: true, name: 'сборка html', info: per(p.build) + ' мс' },
    { ok: true, name: 'присвоение', info: per(p.assign) + ' мс' },
  ],
};