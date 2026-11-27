import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { newDocument, newNode } from '../src/gigma/artwork-model.js';
import { createEmptyProject } from '../src/js/model.js';

const require = createRequire(import.meta.url);
const { _electron: electron } = require(process.env.STORYFORGE_PLAYWRIGHT || 'playwright-core');
const root = fileURLToPath(new URL('../', import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'StoryForge-PhotoDrag-'));
const projectFile = path.join(profile, 'photo.sfproj');
const title = 'Photo drag';
const design = newDocument(title);
const sheet = design.pages[0];
sheet.view = { x:115, y:90, zoom:0.3 };
const photo = newNode('image', 84, 110, 270, 180);
photo.name = 'Orange print';
photo.image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8lq/FwMDAxAAGABOqAZN4qLblAAAAAElFTkSuQmCC';
photo.animation = { type:'bounce', durationMs:900, loop:true };
sheet.nodes.push(photo);
let app, page, frame, image, outline;

async function launch() {
  const env = { ...process.env, SF_USERDATA:profile };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath:process.env.STORYFORGE_EXE || require('electron'),
    args:[...(process.env.STORYFORGE_EXE ? [] : ['.']), '--user-data-dir=' + profile], cwd:root, env });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]; win.unmaximize(); win.setContentSize(1440,900);
  });
  await page.waitForFunction(name => document.querySelector('#projectTitle')?.value === name, title, {polling:100});
  await page.locator('#newWorkspaceTab').click();
  await page.locator('[data-start="assistant"]').click();
  frame = page.frameLocator('.gigma-panel:not([hidden]) iframe');
  await frame.getByRole('button', { name:'Выбрать слой ' + photo.name, exact:true }).click();
  image = frame.locator('[data-object] image');
  outline = frame.locator('.selection > rect').first();
}

async function closeFixture() {
  if (!app) return;
  const instance = app;
  app = null;
  const child = instance.process();
  const closed = instance.waitForEvent('close', {timeout:7000}).catch(() => {
    if (child.exitCode === null) child.kill();
  });
  await instance.evaluate(({app}) => { setImmediate(() => app.exit(0)); }).catch(() => {});
  await closed;
}

function near(actual, expected, description) {
  assert.ok(Math.abs(actual - expected) < 1.1, description + ': expected ' + expected + ', got ' + actual);
}

async function orangeAt(x, y) {
  const pixel = await app.evaluate(async ({BrowserWindow}, point) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    const shot = await wc.capturePage({ ...point, width:1, height:1 });
    const [b,g,r] = shot.toBitmap();
    return [r,g,b];
  }, {x:Math.round(x),y:Math.round(y)});
  assert.ok(pixel[0] > 225 && pixel[1] > 86 && pixel[1] < 137 && pixel[2] < 66,
    'Expected the orange photo under the pointer, sampled RGB ' + pixel);
}

async function drag(dx, dy, animated) {
  const initial = await outline.boundingBox();
  const center = { x:Math.round(initial.x + initial.width / 2), y:Math.round(initial.y + initial.height / 2) };
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  const grabbed = await image.boundingBox();
  for (const fraction of [0.5, 1]) {
    const x = Math.round(dx * fraction), y = Math.round(dy * fraction);
    await page.mouse.move(center.x + x, center.y + y, {steps:4});
    const selection = await outline.boundingBox();
    const rendered = await image.boundingBox();
    near(selection.x - initial.x, x, 'Selection follows pointer horizontally');
    near(selection.y - initial.y, y, 'Selection follows pointer vertically');
    near(rendered.x - grabbed.x, x, 'Rendered photo follows pointer horizontally during drag');
    near(rendered.y - grabbed.y, y, 'Rendered photo follows pointer vertically during drag');
    await orangeAt(center.x + x, center.y + y);
  }
  await page.mouse.up();
  const dropped = await outline.boundingBox();
  near(dropped.x - initial.x, dx, 'Drop position X');
  near(dropped.y - initial.y, dy, 'Drop position Y');
  near((await image.boundingBox()).x, dropped.x, 'Image at dropped position');
  await orangeAt(center.x + dx, center.y + dy);
  if (animated) {
    const motion = await image.evaluate(el => el.ownerDocument.getAnimations().find(a => a.animationName === 'gigma-bounce')?.playState);
    assert.equal(motion, 'running', 'Bounce resumes at the dropped position');
  }
  return dropped;
}

try {
  const project = createEmptyProject({meta:{title}, gigmaWorkspaces:[{id:'gg_assistant', name:title, document:design}]});
  await fs.writeFile(projectFile, JSON.stringify(project));
  await fs.writeFile(path.join(profile,'settings.json'), JSON.stringify({resumeLastProject:true,lastPath:projectFile,language:'ru'}));
  await launch();
  near((await image.boundingBox()).width, photo.width * sheet.view.zoom, '30% zoom');
  await frame.getByTitle('Воспроизвести анимацию на холсте', {exact:true}).click();
  await frame.getByTitle('Остановить анимацию', {exact:true}).waitFor();
  const first = await drag(102,60,true);
  await frame.getByTitle('Остановить анимацию', {exact:true}).click();
  const last = await drag(-42,36,false);
  await page.keyboard.press('Control+z');
  near((await image.boundingBox()).x, first.x, 'Undo one drag');
  await page.keyboard.press('Control+Shift+z');
  near((await image.boundingBox()).x, last.x, 'Redo one drag');
  await page.keyboard.press('Control+s');
  const expected = {x:photo.x + (102 - 42) / sheet.view.zoom, y:photo.y + (60 + 36) / sheet.view.zoom};
  let saved;
  for (let i = 0; i < 120; i++) {
    saved = JSON.parse(await fs.readFile(projectFile, 'utf8')).gigmaWorkspaces[0].document.pages[0].nodes[0];
    if (Math.abs(saved.x - expected.x) < .01 && Math.abs(saved.y - expected.y) < .01) break;
    await new Promise(resolve => setTimeout(resolve,50));
  }
  near(saved.x, expected.x, 'Saved document coordinate X');
  near(saved.y, expected.y, 'Saved document coordinate Y');
  assert.deepEqual(saved.animation,photo.animation);
  await closeFixture();
  await launch();
  const reopened = await image.boundingBox();
  near(reopened.x, last.x, 'Reopened image X');
  near(reopened.y, last.y, 'Reopened image Y');
  await orangeAt(reopened.x + reopened.width / 2, reopened.y + reopened.height / 2);
  console.log('PASS: bouncing and static photos follow the pointer and selection at 30% zoom, including drop, undo/redo and reopening');
} finally {
  await closeFixture();
  const actual = await fs.realpath(profile);
  assert.equal(path.dirname(actual), await fs.realpath(os.tmpdir()));
  assert.match(path.basename(actual), /^StoryForge-PhotoDrag-/);
  await fs.rm(actual, {recursive:true,force:true,maxRetries:3,retryDelay:100});
}
