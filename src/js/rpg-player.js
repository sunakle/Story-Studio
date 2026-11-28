import { t } from './i18n.js';
import { advance, firstWalkableCell, getMapTile, interact, move, startGame } from './rpg-model.js';
import { drawRpgActor, drawRpgTile, rpgAtlas, rpgDefaults } from './rpg-assets.js';

export function openRpgPlayer(game, {mapId} = {}) {
  function initialState() {
    const state = startGame(game);
    const selected = game.maps.find(m => m.id === mapId && m.id !== state.mapId);
    if (selected) {
      const spawn = firstWalkableCell(selected, true) ?? firstWalkableCell(selected);
      if (!spawn) throw Error(t('Чтобы запустить эту локацию, нарисуйте хотя бы одну проходимую клетку.', 'Paint at least one walkable tile to play this map.'));
      Object.assign(state, {mapId:selected.id,...spawn});
    }
    return state;
  }
  let state = initialState();
  let stepFrame = 1, nextStep = 0, idleTimer;
  function stopStep() {
    clearTimeout(idleTimer);
    stepFrame = 1;
  }
  const d = document.createElement('dialog');
  d.className = 'rpg-player';
  d.setAttribute('aria-labelledby', 'rpg-player-location');
  const el = (tag, parent, name, text) => {
    const child = document.createElement(tag);
    if (name) child.className = name;
    if (text) child.textContent = text;
    parent.append(child);
    return child;
  };
  const button = (parent, label, fn, cmd) => {
    const b = el('button',parent,'',label);
    b.type = 'button'; b.dataset.player = cmd; b.onclick = fn;
    return b;
  };
  const header = el('header',d);
  const title = el('h2',header); title.id = 'rpg-player-location';
  button(header,t('Заново','Restart'),() => { stopStep(); state = initialState(); paint(); canvas.focus(); },'restart');
  button(header,t('Закрыть','Close'),() => d.close(),'close');
  const area = el('div',d,'rpg-play-area');
  const canvas = el('canvas',area); canvas.tabIndex = 0;
  const message = el('div',area,'rpg-play-dialogue');
  const line = el('p',message); line.setAttribute('aria-live','polite');
  button(message,t('Дальше','Continue'),() => act('action'),'continue');
  const footer = el('footer',d);
  el('span',footer,'rpg-play-hint',t('Стрелки / WASD — ходить · Пробел — говорить','Arrows / WASD to move · Space to interact'));
  const arrows = {left:[-1,0],up:[0,-1],down:[0,1],right:[1,0]};
  const labels = {left:t('Влево','Left'),right:t('Вправо','Right'),up:t('Вверх','Up'),down:t('Вниз','Down')};
  for (const [key,symbol] of Object.entries({left:'←',up:'↑',down:'↓',right:'→'})) {
    const b = button(footer,symbol,() => act(key),key);
    b.setAttribute('aria-label',labels[key]);
  }
  button(footer,t('Действие','Interact'),() => act('action'),'action');

  function act(key) {
    const before = {x:state.x,y:state.y,mapId:state.mapId};
    stopStep();
    if (key === 'action') state.dialogue !== null ? advance(game,state) : interact(game,state);
    else move(game,state,...arrows[key]);
    if (key !== 'action' && before.mapId === state.mapId && (before.x !== state.x || before.y !== state.y)) {
      stepFrame = nextStep;
      nextStep = 2 - nextStep;
      idleTimer = setTimeout(() => { stepFrame = 1; paint(); },125);
    }
    paint();
  }
  const keys = {ArrowLeft:'left',KeyA:'left',ArrowUp:'up',KeyW:'up',ArrowDown:'down',KeyS:'down',ArrowRight:'right',KeyD:'right',Space:'action',Enter:'action',KeyE:'action'};
  d.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); d.close(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Enter' && e.target.tagName === 'BUTTON') return;
    const key = keys[e.code];
    if (key) { e.preventDefault(); if (!(e.repeat && key === 'action')) act(key); }
  });
  const image = new Image();
  const size = rpgAtlas.tileSize;
  function paint() {
    const map = game.maps.find(m => m.id === state.mapId);
    title.textContent = map.name;
    canvas.setAttribute('aria-label',map.name + ' · ' + state.x + ', ' + state.y);
    canvas.dataset.map = map.id; canvas.dataset.x = state.x; canvas.dataset.y = state.y;
    message.hidden = state.dialogue === null; line.textContent = state.dialogue || '';
    if (!image.complete || !image.naturalWidth) return;
    const w = 20, h = 14;
    const ox = state.x - Math.floor(w / 2), oy = state.y - Math.floor(h / 2);
    if (canvas.width !== w*size || canvas.height !== h*size) { canvas.width = w*size; canvas.height = h*size; }
    const ctx = canvas.getContext('2d'); ctx.clearRect(0,0,canvas.width,canvas.height); ctx.imageSmoothingEnabled = false;
    const draw = (id,x,y) => drawRpgTile(ctx,image,id,(x-ox)*size,(y-oy)*size,size);
    for (let y=oy; y<oy+h; y++) for (let x=ox; x<ox+w; x++) {
      const id = getMapTile(map,x,y);
      if (id === null) continue;
      if (id !== rpgDefaults.ground) draw(rpgDefaults.ground,x,y);
      draw(id,x,y);
    }
    for (const e of map.events) if (e.x>=ox && e.x<ox+w && e.y>=oy && e.y<oy+h) draw(e.sprite,e.x,e.y);
    drawRpgActor(ctx,image,state.sprite,state.facing,stepFrame,(state.x-ox)*size,(state.y-oy)*size,size);
  }
  image.onload = paint;
  image.onerror = () => { line.textContent = t('Не удалось открыть атлас графики.','Could not open the tile atlas.'); message.hidden = false; };
  image.src = rpgAtlas.url;
  d.addEventListener('close', () => { stopStep(); image.onload = image.onerror = null; d.remove(); },{once:true});
  document.body.append(d); d.showModal(); canvas.focus(); paint();
  return d;
}
