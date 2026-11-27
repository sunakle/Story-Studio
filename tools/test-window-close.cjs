// Native Electron regression: window.close() traverses the same path as the title-bar X.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
if (!process.versions.electron) {
  const electron = process.env.STORYFORGE_ELECTRON_PATH || require('electron');
  const base = process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'LocalLow') : os.tmpdir();
  const output = fs.mkdtempSync(path.join(base, 'StoryForge-Close-'));
  const idleTest = path.join(output, 'idle.mjs');
  fs.writeFileSync(idleTest, 'await new Promise(() => {});');
  for (const scenario of ['save', 'discard', 'clean']) {
    const profile = path.join(output, scenario);
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
      resumeLastProject: false, language: scenario === 'discard' ? 'en' : 'ru',
      theme: scenario === 'discard' ? 'light' : 'dark',
    }));
    const env = { ...process.env, SF_USERDATA: profile, SF_TEST_OUTPUT: profile, SF_CLOSE_SCENARIO: scenario };
    delete env.ELECTRON_RUN_AS_NODE;
    const run = spawnSync(electron, ['--no-sandbox', '--user-data-dir=' + profile, __filename, '--selftest', '--selftest-file=' + idleTest],
      { cwd: root, env, timeout: 45000, encoding: 'utf8', windowsHide: true });
    if (run.error) throw run.error;
    assert.equal(run.status, 0, run.stderr || scenario);
    assert.ok(fs.existsSync(path.join(profile, 'verified')), scenario + ': window never closed');
  }
  console.log('Passed save, discard, cancel, Escape, duplicate close, canceled Save As, disk error, Russian/English and clean close.');
  console.log('Screenshot: ' + path.join(output, 'save', 'close.png'));
} else {
  const { app, dialog } = require('electron');
  const profile = process.env.SF_TEST_OUTPUT;
  const scenario = process.env.SF_CLOSE_SCENARIO;
  const saved = path.join(profile, 'saved.sfproj');
  let savePath = null;
  dialog.showSaveDialog = async () => savePath ? { canceled: false, filePath: savePath } : { canceled: true };
  app.once('browser-window-created', (_e, win) => {
    let closing = false;
    const js = code => win.webContents.executeJavaScript(code, true);
    async function waitFor(code) {
      for (let i = 0; i < 150; i++) { if (await js(code)) return; await pause(25); }
      throw Error('Timed out: ' + code);
    }
    async function prompt() {
      win.close();
      await waitFor("!!document.querySelector('.close-prompt[open]')");
    }
    async function choose(choice) {
      await js("document.querySelector('.close-prompt-actions [data-choice=" + choice + "]').click()");
    }
    win.once('closed', () => {
      try {
        assert.ok(closing, 'Window closed without a confirmed decision');
        if (scenario === 'save') assert.equal(JSON.parse(fs.readFileSync(saved, 'utf8')).meta.title, 'Close test');
        if (scenario === 'discard') assert.ok(!fs.existsSync(saved));
        fs.writeFileSync(path.join(profile, 'verified'), scenario);
      } catch (error) { console.error(error); app.exit(1); }
    });
    async function run() {
      await waitFor('!!window.__sfTest');
      win.setSize(1120, 780);
      await js(`(async () => {
        const { makeStoryFixture } = await import(new URL('../tools/test-fixtures.mjs', document.baseURI).href);
        const { store, ui } = window.__sfTest;
        store.setProject(makeStoryFixture());
        ui.workbench.openNode('qa_shared');
      })()`);
      await pause(150);
      if (scenario === 'clean') {
        closing = true;
        win.close();
        return;
      }
      // Native close before the 400 ms title debounce must still see the current edit.
      await js(`const input = document.querySelector('#projectTitle');
        input.value = 'Close test'; input.dispatchEvent(new Event('input', {bubbles:true}));`);
      await prompt();
      assert.equal(await js('document.activeElement.dataset.choice'), 'cancel');
      win.close();
      await pause(50);
      assert.equal(await js("document.querySelectorAll('.close-prompt').length"), 1);
      assert.equal(await js("document.querySelector('#closePromptProject').innerText.includes('Close test')"), true);
      if (scenario === 'discard') {
        assert.equal(await js("document.querySelector('#closePromptTitle').innerText"), 'Save changes?');
        assert.equal(await js("document.documentElement.dataset.theme"), 'light');
        assert.equal(await js("getComputedStyle(document.querySelector('.close-prompt')).backgroundColor"), 'rgb(23, 23, 23)');
        await js("document.querySelector('.close-prompt-x').click()");
        await waitFor("!document.querySelector('.close-prompt') && window.__sfTest.store.dirty");
        await prompt();
        closing = true;
        await choose('discard');
        return;
      }
      await choose('cancel');
      await waitFor("!document.querySelector('.close-prompt') && window.__sfTest.store.dirty");
      await js(`window.__sfTest.store.apply([{op:'setMeta',patch:{title:'Проверка редактора'}}]);`);
      await prompt();
      await pause(200);
      fs.writeFileSync(path.join(profile, 'close.png'), (await win.webContents.capturePage()).toPNG());
      win.webContents.sendInputEvent({type:'keyDown', keyCode:'Escape'});
      win.webContents.sendInputEvent({type:'keyUp', keyCode:'Escape'});
      await waitFor("!document.querySelector('.close-prompt') && window.__sfTest.store.dirty");
      await js(`window.__sfTest.store.apply([{op:'setMeta',patch:{title:'Close test'}}]);`);
      await prompt();
      await choose('save'); // Cancel native Save As.
      await waitFor("!document.querySelector('.close-prompt') && window.__sfTest.store.dirty");
      await pause(70);
      savePath = profile; // Writing a file over an existing directory must fail.
      await prompt();
      await choose('save');
      await waitFor("document.querySelector('.toast.bad') || document.querySelector('.toast-bad')");
      assert.ok(await js('window.__sfTest.store.dirty'));
      savePath = saved;
      await prompt();
      closing = true;
      await choose('save');
    }
    win.webContents.once('did-finish-load', () => run().catch(error => {
      if (closing && win.isDestroyed()) return;
      console.error(error); app.exit(1);
    }));
  });
  require(path.join(root, 'main.js'));
}

