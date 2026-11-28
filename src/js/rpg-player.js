import { t } from './i18n.js';
import { advance, firstWalkableCell, getMapTile, interact, move, startGame } from './rpg-model.js';
import { drawRpgActor, drawRpgTile, rpgAtlas, rpgDefaults } from './rpg-assets.js';

const STEP_MS = 180;

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
  const held = new Map();
  let step = null, bufferedTurn = null, interactAfterTurn = false;
  let animation = 0, nextFoot = 0;
  function clearInput() {
    held.clear();
    bufferedTurn = null;
    interactAfterTurn = false;
  }
  function stopWalking() {
    clearInput();
    cancelAnimationFrame(animation);
    animation = 0;
    step = null;
    nextFoot = 0;
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
  button(header,t('Заново','Restart'),() => { stopWalking(); state = initialState(); paint(); canvas.focus(); },'restart');
  button(header,t('Закрыть','Close'),() => d.close(),'close');
  const area = el('div',d,'rpg-play-area');
  const canvas = el('canvas',area); canvas.tabIndex = 0;
  const message = el('div',area,'rpg-play-dialogue');
  const line = el('p',message); line.setAttribute('aria-live','polite');
  button(message,t('Дальше','Continue'),action,'continue');
  const footer = el('footer',d);
  el('span',footer,'rpg-play-hint',t('Стрелки / WASD — ходить · Пробел — говорить','Arrows / WASD to move · Space to interact'));
  const arrows = {left:[-1,0],up:[0,-1],down:[0,1],right:[1,0]};
  const labels = {left:t('Влево','Left'),right:t('Вправо','Right'),up:t('Вверх','Up'),down:t('Вниз','Down')};
  for (const [key,symbol] of Object.entries({left:'←',up:'↑',down:'↓',right:'→'})) {
    const b = button(footer,symbol,event => { if (!event.detail) requestStep(key); },key);
    b.setAttribute('aria-label',labels[key]);
    b.onpointerdown = event => {
      if (event.button !== 0) return;
      b.setPointerCapture(event.pointerId);
      pressDirection(event.pointerId,key);
    };
    b.onlostpointercapture = event => releaseDirection(event.pointerId);
  }
  button(footer,t('Действие','Interact'),action,'action');

  function action() {
    if (step && bufferedTurn && state.dialogue === null) {
      // A quick turn followed by Space interacts in the intended direction.
      interactAfterTurn = true;
      return;
    }
    const {x,y,mapId,dialogue} = state;
    if (dialogue !== null) advance(game,state);
    else interact(game,state);
    if (dialogue !== null || state.dialogue !== null || x !== state.x || y !== state.y || mapId !== state.mapId) stopWalking();
    paint();
  }
  function requestStep(direction) {
    if (state.dialogue !== null) return;
    if (step) bufferedTurn = direction;
    else startStep(direction, performance.now());
  }
  function pressDirection(input, direction) {
    if (held.has(input) || state.dialogue !== null) return;
    held.set(input,direction);
    requestStep(direction);
  }
  function releaseDirection(input) {
    if (!held.delete(input)) return;
    const fallback = [...held.values()].at(-1);
    if (!step && fallback) requestStep(fallback);
  }
  function startStep(direction, start) {
    const {x,y,mapId} = state;
    const [dx,dy] = arrows[direction];
    move(game,state,dx,dy);
    const arrived = state.mapId === mapId && state.x === x + dx && state.y === y + dy;
    const transferred = !arrived && (state.mapId !== mapId || state.x !== x || state.y !== y);
    if (arrived) {
      step = {dx,dy,start,foot:nextFoot};
      nextFoot = 2 - nextFoot;
      if (state.dialogue !== null) clearInput();
      animation = requestAnimationFrame(tick);
    } else if (transferred || state.dialogue !== null) {
      stopWalking();
    }
    paint();
    return !transferred && state.dialogue === null;
  }
  function tick(now) {
    animation = 0;
    const end = step.start + STEP_MS;
    if (now < end) {
      draw(now);
      animation = requestAnimationFrame(tick);
      return;
    }
    step = null;
    const direction = bufferedTurn ?? [...held.values()].at(-1);
    const shouldInteract = interactAfterTurn;
    bufferedTurn = null;
    interactAfterTurn = false;
    if (direction && state.dialogue === null) {
      // Keep cadence across normal frames, but never race to catch up after a stall.
      const canInteract = startStep(direction, now - end >= STEP_MS ? now : end);
      if (shouldInteract && canInteract) action();
    } else draw(now);
  }
  const keys = {ArrowLeft:'left',KeyA:'left',ArrowUp:'up',KeyW:'up',ArrowDown:'down',KeyS:'down',ArrowRight:'right',KeyD:'right',Space:'action',Enter:'action',KeyE:'action'};
  d.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); d.close(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Enter' && e.target.tagName === 'BUTTON') {
      if (e.repeat) e.preventDefault();
      return;
    }
    const key = keys[e.code];
    if (!key) return;
    e.preventDefault();
    if (e.repeat) return;
    if (key === 'action') action();
    else pressDirection(e.code,key);
  });
  d.addEventListener('keyup', e => {
    if (held.has(e.code)) {
      e.stopPropagation();
      releaseDirection(e.code);
    }
  });
  const image = new Image();
  const size = rpgAtlas.tileSize;
  function paint() {
    const map = game.maps.find(m => m.id === state.mapId);
    title.textContent = map.name;
    canvas.setAttribute('aria-label',map.name + ' · ' + state.x + ', ' + state.y);
    canvas.dataset.map = map.id; canvas.dataset.x = state.x; canvas.dataset.y = state.y;
    message.hidden = state.dialogue === null; line.textContent = state.dialogue || '';
    draw(performance.now());
  }
  function draw(now) {
    if (!image.complete || !image.naturalWidth) return;
    const map = game.maps.find(m => m.id === state.mapId);
    const w = 20, h = 14;
    if (canvas.width !== w*size || canvas.height !== h*size) { canvas.width = w*size; canvas.height = h*size; }
    const ctx = canvas.getContext('2d'); ctx.clearRect(0,0,canvas.width,canvas.height); ctx.imageSmoothingEnabled = false;
    const progress = step ? Math.max(0,Math.min(1,(now-step.start)/STEP_MS)) : 1;
    const remaining = Math.round((1-progress)*size);
    const cx = Math.floor(w/2)*size, cy = Math.floor(h/2)*size;
    const left = state.x*size - cx - (step?.dx ?? 0)*remaining;
    const top = state.y*size - cy - (step?.dy ?? 0)*remaining;
    const xMin = Math.floor(left/size), xEnd = Math.ceil((left+canvas.width)/size);
    const yMin = Math.floor(top/size), yEnd = Math.ceil((top+canvas.height)/size);
    const tile = (id,x,y) => drawRpgTile(ctx,image,id,x*size-left,y*size-top,size);
    for (let y=yMin; y<yEnd; y++) for (let x=xMin; x<xEnd; x++) {
      const id = getMapTile(map,x,y);
      if (id === null) continue;
      if (id !== rpgDefaults.ground) tile(rpgDefaults.ground,x,y);
      tile(id,x,y);
    }
    for (const e of map.events) if (e.x>=xMin && e.x<xEnd && e.y>=yMin && e.y<yEnd) tile(e.sprite,e.x,e.y);
    drawRpgActor(ctx,image,state.sprite,state.facing,step && progress<.6 ? step.foot : 1,cx,cy,size);
  }
  image.onload = paint;
  image.onerror = () => { line.textContent = t('Не удалось открыть атлас графики.','Could not open the tile atlas.'); message.hidden = false; };
  image.src = rpgAtlas.url;
  const loseFocus = () => { stopWalking(); paint(); };
  const visibilityChanged = () => { if (document.hidden) loseFocus(); };
  window.addEventListener('blur',loseFocus);
  document.addEventListener('visibilitychange',visibilityChanged);
  d.addEventListener('close', () => {
    stopWalking();
    window.removeEventListener('blur',loseFocus);
    document.removeEventListener('visibilitychange',visibilityChanged);
    image.onload = image.onerror = null;
    d.remove();
  },{once:true});
  document.body.append(d); d.showModal(); canvas.focus(); paint();
  return d;
}
