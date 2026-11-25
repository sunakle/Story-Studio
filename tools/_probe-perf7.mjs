// Разбор renderNode на большом проекте.
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
    { ok: true, name: 'сборка html', info: per(p.build) + ' мс' },
    { ok: true, name: '  · emotions', info: per(p.emotions) + ' мс' },
    { ok: true, name: '  · connectionsBlock', info: per(p.connectionsBlock) + ' мс' },
    { ok: true, name: '  · mediaBlock', info: per(p.mediaBlock) + ' мс' },
    { ok: true, name: '  · effectsBlock', info: per(p.effectsBlock) + ' мс' },
    { ok: true, name: '  · metaBlock', info: per(p.metaBlock) + ' мс' },
    { ok: true, name: '  · остальное', info: per((p.build || 0) - (p.emotions || 0) - (p.connectionsBlock || 0) - (p.mediaBlock || 0) - (p.effectsBlock || 0) - (p.metaBlock || 0)) + ' мс' },
    { ok: true, name: '  · options', info: per(p.options) + ' мс / ' + (p.optionCalls || 0) / calls + ' вызовов' },
    { ok: true, name: 'bind + wire', info: per(p.wire) + ' мс' },
    { ok: true, name: '  · wireNodeActions', info: per(p.wireNodeActions) + ' мс' },
    { ok: true, name: 'всего render', info: per((p.build || 0) + (p.wire || 0) + (p.assign || 0)) + ' мс' },
  ],
};