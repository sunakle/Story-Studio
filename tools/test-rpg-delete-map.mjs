// Exercise deletion through the normal map sidebar in an isolated Electron project.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {createEmptyProject} from '../src/js/model.js';
import {createRpgExample} from '../src/js/rpg-example.js';
import {createMap,validateGame} from '../src/js/rpg-model.js';

const require=createRequire(import.meta.url);
const { _electron:electron }=require(process.env.STORYFORGE_PLAYWRIGHT || 'playwright-core');
const root=fileURLToPath(new URL('../',import.meta.url));
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'StoryForge-DeleteRoom-'));
let file=path.join(profile,'qa.sfproj');
const name='Проверка удаления локаций';
const original=createRpgExample();
original.maps.push(createMap('loft','Чердак',3,3));
original.walkStepMs=220;
original.panels=[{id:'quest',position:'top-right',title:'Задача',text:'Найди ключ'}];
const errors=[];
let app,page,editor;

async function openEditor() {
  const env={...process.env,SF_USERDATA:profile};
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath=process.env.STORYFORGE_EXE || require('electron');
  app=await electron.launch({executablePath,cwd:root,env,args:[...(process.env.STORYFORGE_EXE ? [] : ['.']),'--user-data-dir='+profile]});
  page=await app.firstWindow();
  page.setDefaultTimeout(8000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(n=>document.querySelector('#projectTitle')?.value===n,name);
  await page.locator('#newWorkspaceTab').click();
  await page.locator('[data-start="rpg"]').click();
  editor=page.locator('.rpg-editor');
  await editor.waitFor();
}
async function closeEditor() {
  if (!app) return;
  const instance=app;
  app=null;
  const closed=instance.waitForEvent('close',{timeout:8000}).catch(()=>{ if(instance.process().exitCode===null) instance.process().kill(); });
  await instance.evaluate(({app})=>{ setImmediate(()=>app.exit(0)); }).catch(()=>{});
  await closed;
}
const map=id=>editor.locator('.rpg-maps [data-map-id="'+id+'"]');
const cmd=id=>editor.locator('[data-cmd="'+id+'"]');
async function removeMap(id,confirm=true,usingSettings=false) {
  await map(id).click();
  let button=editor.locator('.rpg-side-head [data-cmd="delete-map"]');
  if (usingSettings) {
    await cmd('map-settings').click();
    button=editor.locator('form [data-cmd="delete-map"]');
  }
  await button.click();
  const dialog=page.locator('.modal-card').last();
  await dialog.getByRole('button',{name:confirm?'Удалить':'Отмена',exact:true}).click();
  await dialog.waitFor({state:'detached'});
  if (!confirm) return;
  try {
    await map(id).waitFor({state:'detached',timeout:3500});
  } catch (error) {
    throw new Error('Map '+id+' remains after clicking Delete. Editor status: '+await editor.locator('.rpg-status').textContent(),{cause:error});
  }
}
async function saveAndRead(check) {
  await page.keyboard.press('Control+s');
  const end=Date.now()+6500;
  do {
    const project=JSON.parse(await fs.readFile(file,'utf8'));
    assert.equal(project.screenplay,'Сохрани сценарий.');
    if(check(project.rpgGame)) {
      if (project.rpgGame) validateGame(project.rpgGame);
      return project.rpgGame;
    }
    await delay(80);
  } while(Date.now()<end);
  throw Error('The expected map state was not saved.');
}

try {
  await fs.writeFile(file,JSON.stringify(createEmptyProject({meta:{title:name},screenplay:'Сохрани сценарий.',rpgGame:original})));
  await fs.writeFile(path.join(profile,'settings.json'),JSON.stringify({lastPath:file,resumeLastProject:true,language:'ru',autosave:true}));
  await openEditor();
  await removeMap('workshop',true,true);
  const after=await saveAndRead(g=>g.maps.length===2);
  assert.deepEqual(after.maps.map(m=>m.id),['garden','loft']);
  assert.deepEqual(after.start,original.start);
  const beforeDoor=original.maps[0].events.find(e=>e.id==='locked_door');
  const afterDoor=after.maps[0].events.find(e=>e.id==='locked_door');
  assert.equal(afterDoor.code,beforeDoor.code.split('\n').filter(line=>!line.trimStart().startsWith('goto workshop ')).join('\n'));
  assert.deepEqual(after.maps[0].events.find(e=>e.id==='keeper'),original.maps[0].events.find(e=>e.id==='keeper'));
  console.log('PASS: map settings remove the referenced room and just the incoming transfer from the branching door');
  await page.keyboard.press('Control+z');
  assert.deepEqual(await saveAndRead(g=>g.maps.length===3),original);
  await page.keyboard.press('Control+y');
  assert.deepEqual(await saveAndRead(g=>g.maps.length===2),after);

  await removeMap('loft',false);
  assert.deepEqual(await saveAndRead(g=>g.maps.length===2),after);
  await removeMap('loft');
  const one=await saveAndRead(g=>g.maps.length===1);
  assert.equal(one.start.mapId,'garden');
  await page.keyboard.press('Control+z');
  assert.deepEqual(await saveAndRead(g=>g.maps.length===2),after);
  await removeMap('garden');
  const moved=await saveAndRead(g=>g.maps.length===1 && g.start?.mapId==='loft');
  assert.deepEqual(moved.maps[0],original.maps[2]);
  assert.equal(moved.start.sprite,original.start.sprite);
  await cmd('play').click();
  await page.locator('dialog.rpg-player canvas[data-map="loft"]').waitFor();
  await page.keyboard.press('Escape');
  console.log('PASS: cancel, unlinked room removal, undo, redo, spawn relocation and launch');

  await removeMap('loft');
  const blank=await saveAndRead(g=>!g.maps.length);
  assert.equal(blank.start,null);
  assert.equal(blank.walkStepMs,220);
  assert.deepEqual(blank.panels,original.panels);
  await page.keyboard.press('Control+z');
  assert.deepEqual(await saveAndRead(g=>g.maps.length===1),moved);
  await page.keyboard.press('Control+y');
  assert.deepEqual(await saveAndRead(g=>!g.maps.length),blank);
  await closeEditor();
  await openEditor();
  await cmd('add-map').first().waitFor();
  assert.equal(await editor.locator('.rpg-maps [data-map-id]').count(),0);
  assert.equal(await editor.locator('[data-rpg-canvas]').count(),0);
  await cmd('add-map').first().click();
  const input=editor.locator('[data-map-name]');
  await input.fill('Новая площадь');
  await editor.getByRole('button',{name:'Создать',exact:true}).click();
  const created=await saveAndRead(g=>g.maps[0]?.name==='Новая площадь');
  assert.equal(created.start.mapId,created.maps[0].id);
  assert.equal(created.start.sprite,original.start.sprite);
  assert.deepEqual(created.panels,original.panels);
  await cmd('play').click();
  await page.locator('dialog.rpg-player canvas[data-map="'+created.start.mapId+'"]').waitFor();
  console.log('PASS: last room removal, reversible empty game, persisted restart and playable replacement room');

  await closeEditor();
  file=path.join(profile,'previous-format.sfproj');
  const olderProject=createEmptyProject({meta:{title:name},screenplay:'Сохрани сценарий.'});
  delete olderProject.rpgGame;
  await fs.writeFile(file,JSON.stringify(olderProject));
  await fs.writeFile(path.join(profile,'settings.json'),JSON.stringify({lastPath:file,resumeLastProject:true,language:'ru'}));
  await openEditor();
  await removeMap('map_1');
  await saveAndRead(g=>g?.maps.length===0);
  await page.keyboard.press('Control+z');
  await map('map_1').waitFor();
  await saveAndRead(g=>g==null);
  console.log('PASS: default first location can be deleted and restored in a project with no stored game');
  assert.deepEqual(errors,[]);
} finally {
  await closeEditor();
  const verified=await fs.realpath(profile);
  assert.equal(path.dirname(verified),await fs.realpath(os.tmpdir()));
  assert.ok(path.basename(verified).startsWith('StoryForge-DeleteRoom-'));
  await fs.rm(verified,{recursive:true,force:true,maxRetries:4,retryDelay:150});
}
