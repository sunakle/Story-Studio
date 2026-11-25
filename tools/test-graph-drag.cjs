// Native regression for a long character-node drag with the large bundled story.
// Run with node tools/test-graph-drag.cjs on a desktop that can run Electron.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const electron = process.env.STORYFORGE_ELECTRON_PATH || require('electron');
  const temp = process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'LocalLow') : os.tmpdir();
  const output = fs.mkdtempSync(path.join(temp, 'StoryForge-GraphDrag-'));
  const idle = path.join(output, 'idle.mjs');
  fs.writeFileSync(idle, 'await new Promise(() => {});');
  const env = { ...process.env, SF_USERDATA: path.join(output, 'profile'), SF_TEST_OUTPUT: output };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electron, ['--no-sandbox', '--user-data-dir=' + env.SF_USERDATA,
    __filename, '--selftest', '--selftest-file=' + idle],
  { cwd: root, env, timeout: 65000, encoding: 'utf8', windowsHide: true });
  if (run.error) throw run.error;
  const report = path.join(output, 'graph-drag.json');
  if (!fs.existsSync(report)) throw Error('No result: ' + run.stderr);
  const data = JSON.parse(fs.readFileSync(report));
  console.log(JSON.stringify(data, null, 2));
  assert.equal(run.status, 0, data.error || run.stderr);
} else {
  const { app } = require('electron');
  const output = process.env.SF_TEST_OUTPUT;
  app.once('browser-window-created', (_event, win) => {
    const js = code => win.webContents.executeJavaScript(code, true);
    const inPage = fn => js('(' + fn.toString() + ')()');
    const frames = count => js(`new Promise(resolve => {
      let left = ${count};
      function next() {
        if (--left === 0) resolve();
        else requestAnimationFrame(next);
      }
      requestAnimationFrame(next);
    })`);
    const ready = condition => js(`new Promise((resolve, reject) => {
      const deadline = performance.now() + 15000;
      function poll() {
        if (${condition}) resolve();
        else if (performance.now() >= deadline) reject(Error('Timed out: ' + ${JSON.stringify(condition)}));
        else requestAnimationFrame(poll);
      }
      poll();
    })`);
    const mouse = (type, x, y) => win.webContents.sendInputEvent({
      type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1
    });
    const result = {};
    async function run() {
      win.setContentSize(1440, 900);
      await ready('!!window.__sfTest');
      await inPage(async () => {
        const { ui, store } = window.__sfTest;
        const response = await window.sf.file.openPath('demo/stress-overview.sfproj');
        if (!response.ok) throw Error(response.error);
        store.setProject(response.project);
        for (const [id, toggle] of [['leftPanel', 'btnToggleLeft'], ['rightPanel', 'btnToggleRight']]) {
          if (document.getElementById(id).classList.contains('collapsed')) document.getElementById(toggle).click();
        }
        ui.workbench.openOverview();
      });
      await ready('window.__sfTest.ui.visualizer.state.nodes.length > 200 && !window.__sfTest.ui.visualizer.state.raf');
      // Start with a settled real layout and a fixed camera matching the reported viewport.
      const setup = await inPage(() => {
        const { store, ui } = window.__sfTest;
        const view = ui.visualizer.state;
        const canvas = document.querySelector('#vizRoot canvas');
        const box = canvas.getBoundingClientRect();
        const hub = view.byId.get('c_oleg');
        const neighbors = view.links
          .filter(link => link.source === hub.key || link.target === hub.key)
          .map(link => view.byId.get(link.source === hub.key ? link.target : link.source));
        view.autoFrame = false;
        view.zoom = .15;
        view.tx = (box.width * .28 - view.w / 2) / view.zoom - hub.x;
        view.ty = (box.height * .72 - view.h / 2) / view.zoom - hub.y;
        canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 0, cancelable: true }));
        const before = JSON.stringify(store.project);
        const sample = () => {
          const scale = view.zoom / neighbors.length;
          return {
            timeMs: performance.now(),
            mean: scale * neighbors.reduce((sum, node) => sum + Math.hypot(hub.x - node.x, hub.y - node.y), 0),
            cx: scale * neighbors.reduce((sum, node) => sum + node.x, 0),
            cy: scale * neighbors.reduce((sum, node) => sum + node.y, 0),
            x: box.left + view.w / 2 + (hub.x + view.tx) * view.zoom,
            y: box.top + view.h / 2 + (hub.y + view.ty) * view.zoom,
            fixed: hub.fixed, idle: !view.raf, dragging: view.dragging?.node.key || null
          };
        };
        window.dragCheck = { sample, unchanged: () => JSON.stringify(store.project) === before };
        return {
          initial: sample(), target: { x: box.left + box.width * .88, y: box.top + box.height * .075 },
          width: box.width, height: box.height, zoom: view.zoom, degree: neighbors.length
        };
      });
      Object.assign(result, setup);
      const { initial: start, target } = setup;
      const sample = () => js('window.dragCheck.sample()');
      result.travel = Math.hypot(target.x - start.x, target.y - start.y);
      mouse('mouseMove', start.x, start.y);
      mouse('mouseDown', start.x, start.y);
      await ready("window.__sfTest.ui.visualizer.state.dragging?.node.key === 'c_oleg'");
      for (let i = 1; i <= 6; i++) {
        mouse('mouseMove', start.x + (target.x - start.x) * i / 6, start.y + (target.y - start.y) * i / 6);
        await frames(1);
      }
      result.stretched = await sample();
      await frames(120);
      result.held = await sample();
      mouse('mouseUp', target.x, target.y);
      await frames(60);
      result.after60Frames = await sample();
      await ready('!window.__sfTest.ui.visualizer.state.raf');
      result.settled = await sample();
      result.releaseMsTo60Frames = Math.round(result.after60Frames.timeMs - result.held.timeMs);
      result.releaseMsToSleep = Math.round(result.settled.timeMs - result.held.timeMs);
      assert.ok(result.travel > 600 && setup.degree >= 30, 'large hub was dragged across the viewport');
      assert.ok(result.held.fixed && Math.hypot(result.held.x - target.x, result.held.y - target.y) < 2, 'hold keeps node under pointer');
      const neighborTravel = Math.hypot(result.held.cx - result.stretched.cx, result.held.cy - result.stretched.cy);
      assert.ok(neighborTravel > 10 && result.held.mean < result.stretched.mean * .75,
        'the linked neighborhood follows while the pointer is held still');
      assert.ok(!result.settled.fixed && !result.settled.dragging, 'release removes the pin');
      assert.ok(result.settled.mean < start.mean * 1.6, 'springs settled with long tethers');
      assert.ok(result.after60Frames.mean < Math.max(start.mean * 2.5, result.held.mean * .32), 'released hub remained visibly detached after 60 frames');
      assert.ok(await js("window.dragCheck.unchanged() && window.__sfTest.ui.workbench.current()==='overview'"), 'drag leaves project and view intact');
    }
    win.webContents.once('did-finish-load', async () => {
      try { await run(); }
      catch (error) { result.error = String(error.stack || error); }
      fs.writeFileSync(path.join(output, 'graph-drag.json'), JSON.stringify(result, null, 2));
      app.exit(result.error ? 1 : 0);
    });
  });
  require(path.join(root, 'main.js'));
}
