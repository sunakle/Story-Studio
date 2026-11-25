// Разбор render() по фазам на большом проекте + внутренности фаз.
const ui = window.__sfTest.ui;
const store = window.__sfTest.store;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const res = await window.sf.file.openPath('demo/stress-overview.sfproj');
store.setProject(JSON.parse(res.content), { filePath: null, dirty: false });
await wait(250);
store.setSelection({ kind: 'node', id: store.project.startNodeId });
await wait(60);

window.__sfProf = {};
for (let i = 0; i < 6; i += 1) {
  ui.inspector.render();
  await wait(10);
}
const p = window.__sfProf;
const calls = p.calls || 1;
const per = (v) => Math.round(((v || 0) / calls) * 10) / 10;

__sfOut = {
  summary: { total: 1, passed: 1, failed: 0 },
  failed: [],
  jsErrors: [],
  checks: [
    { ok: true, name: 'render() вызовов', info: String(calls) },
    { ok: true, name: 'captureFocus', info: per(p.capture) + ' мс' },
    { ok: true, name: 'сборка html', info: per(p.build) + ' мс' },
    { ok: true, name: '  · optionsForNodes', info: per(p.options) + ' мс, вызовов ' + (p.optionCalls || 0) / calls },
    { ok: true, name: '  · esc', info: per(p.escTime) + ' мс, вызовов ' + (p.escCalls || 0) / calls },
    { ok: true, name: '  · nodeHeader', info: per(p.header) + ' мс' },
    { ok: true, name: 'присвоение innerHTML', info: per(p.assign) + ' мс' },
    { ok: true, name: 'bind + wire', info: per(p.wire) + ' мс' },
    { ok: true, name: '  · bindNode', info: per(p.bindNode) + ' мс' },
    { ok: true, name: '  · wireNodeActions', info: per(p.wireNodeActions) + ' мс' },
    { ok: true, name: 'restoreFocus', info: per(p.restore) + ' мс' },
  ],
};