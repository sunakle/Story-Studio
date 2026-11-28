import { getLanguage, t } from './i18n.js';
import { icon } from './icons.js';
import { createMap, createGame, parseEvent, formatEvent, getMapTile, isMapBlocked, setMapCell, validMapCoordinate, getMapBounds, firstWalkableCell, forEachMapCell } from './rpg-model.js';
import { drawRpgTile, rpgAtlas, rpgDefaults, rpgTileStyle, tileGroups } from './rpg-assets.js';
import { createRpgExample } from './rpg-example.js';
import { openRpgPlayer } from './rpg-player.js';
import { changeBlock, eventBlocks, firstDestination } from './rpg-editor-blocks.js';

const tools = [
  ['pan','hand','Панорама','Pan'], ['paint','edit','Тайлы','Tiles'], ['erase','eraser','Ластик','Erase'], ['block','layout','Стены','Collision'],
  ['event','branch','События','Events'], ['start','user','Старт','Spawn'],
];
const tilePx = 16;
const zoomSteps = [.25,.5,.75,1,1.5,2,3,4,6,8];
const newId = prefix => prefix + '_' + crypto.randomUUID().slice(0,8);

export function createRpgEditor(store, ui) {
  const root = document.createElement('section');
  root.className = 'rpg-editor';
  const esc = ui.escapeHTML;
  const atlas = new Image();
  let host, empty, mapId, eventId, generation, knownGame, language;
  let mode = 'paint', group = 'terrain', tile = rpgDefaults.ground, sprite = rpgDefaults.npc;
  let grid = true, codeTab = false, mapForm = '', status = '', writing = false;
  const cameras = new Map();
  let viewStorageKey='', viewSaveTimer, viewChanged=false;
  let panDrag = null, spaceDown = false, hover = null, drawFrame = 0;
  const viewportObserver = new ResizeObserver(() => scheduleDraw());
  let stroke, draft, fieldDraft, template = 'npc';
  const game = () => store.project.rpgGame || empty;
  const activeMap = (g = game()) => g.maps.find(m=>m.id === mapId) || g.maps[0];
  const activeEvent = (m = activeMap()) => m.events.find(e=>e.id === eventId);

  function storageKey() {
    const location = store.filePath?.replaceAll('\\','/').toLowerCase() || store.documentKey;
    return 'storyforge/rpg-view/1/' + JSON.stringify([location,store.project.meta.createdAt]);
  }
  function persistView() {
    clearTimeout(viewSaveTimer);
    if (!viewStorageKey || !mapId) return;
    // Save As keeps the same generation. A project switch must finish writing
    // the old view under its own key before the next project's view is read.
    const key = generation === store.generation ? storageKey() : viewStorageKey;
    if (!viewChanged && key===viewStorageKey) return;
    viewStorageKey=key;
    try {
      localStorage.setItem(key,JSON.stringify({mapId,views:[...cameras].slice(-128)}));
      viewChanged=false;
    } catch { /* Camera navigation still works when storage is unavailable. */ }
  }
  function saveViewSoon() {
    viewChanged=true;clearTimeout(viewSaveTimer);viewSaveTimer=setTimeout(persistView,220);
  }
  function restoreView() {
    cameras.clear();viewStorageKey=storageKey();viewChanged=false;
    try {
      const saved=JSON.parse(localStorage.getItem(viewStorageKey) || 'null');
      if(!saved || !Array.isArray(saved.views))return;
      const ids=new Set(game().maps.map(m=>m.id));
      for(const [id,c] of saved.views.slice(0,128)){
        if(ids.has(id) && c && Number.isFinite(c.x) && Math.abs(c.x)<=1e9+1 && Number.isFinite(c.y) && Math.abs(c.y)<=1e9+1 &&
           Number.isFinite(c.zoom) && c.zoom>=1e-12 && c.zoom<=8) cameras.set(id,{x:c.x,y:c.y,zoom:c.zoom});
      }
      if(ids.has(saved.mapId))mapId=saved.mapId;
    }catch{ /* A missing or old view starts at the player's position. */ }
  }
  window.addEventListener('pagehide',persistView);

  function homePoint(m) {
    const start = game().start;
    return (start.mapId === m.id ? start : firstWalkableCell(m,true) || m.events[0]) || {x:0,y:0};
  }
  function camera() {
    const m = activeMap();
    if (!cameras.has(m.id)) {
      const p = homePoint(m);
      cameras.set(m.id,{x:p.x+.5, y:p.y+.5, zoom:2});
    }
    return cameras.get(m.id);
  }
  function ensureFloor(m,x,y) {
    if (validMapCoordinate(x) && validMapCoordinate(y) && getMapTile(m,x,y) === null) setMapCell(m,x,y,{tile:rpgDefaults.ground});
  }

  function message(text) {
    status = text;
    const el = root.querySelector('.rpg-status');
    if (el) { el.textContent = text; el.hidden = !text; }
  }
  function commit(next, label, repaint = true) {
    writing = true;
    let result;
    try { result = store.apply({op:'setRpgGame', game:next}, {label}); }
    finally { writing = false; }
    if (!result.ok) { message(result.error); return false; }
    knownGame = store.project.rpgGame;
    message('');
    if (repaint) render();
    return true;
  }
  function update(label, action, repaint = true) {
    try {
      const next = structuredClone(game());
      const map = activeMap(next);
      action(next, map, activeEvent(map));
      return commit(next,label,repaint);
    } catch (err) { message(err.message); return false; }
  }
  function flush() {
    if(generation!==store.generation){draft=null;fieldDraft=null;return true;}
    if(!flushField())return false;
    if (!draft) return true;
    const ev = activeEvent();
    if (!ev || mapId!==draft.mapId || ev.id !== draft.eventId || ev.code !== draft.base) {
      message(t('Событие изменилось. Скопируйте черновик или сбросьте его.','The event changed. Copy or discard your draft.'));
      return false;
    }
    const text = draft.text;
    if (!update(t('Код события','Event code'), (_,m,e)=>{ parseEvent(text); e.code = text; }, false)) return false;
    draft = null;
    return true;
  }
  const button = (cmd, label, name = '', cls = '') =>
    '<button type="button" data-cmd="'+cmd+'" class="'+cls+'">'+(name ? icon(name,14) : '')+label+'</button>';
  function palette() {
    const g = tileGroups.find(g=>g.id===group);
    const ids = g?.tiles || Array.from({length:rpgAtlas.visibleCount},(_,i)=>i);
    const current = mode==='event' ? (activeEvent()?.sprite ?? sprite) : mode==='start' ? game().start.sprite : tile;
    const heading = mode==='event' || mode==='start' ? t('Спрайты','Sprites') : t('Палитра','Tileset');
    return '<section class="rpg-palette"><div class="rpg-section-title">'+heading+'</div>'+
      '<select data-group aria-label="'+t('Категория тайлов','Tile category')+'"><option value="">'+t('Весь набор','All tiles')+'</option>'+
      tileGroups.map(g=>'<option value="'+esc(g.id)+'" '+(group===g.id?'selected':'')+'>'+esc(t(g.ru,g.en))+'</option>').join('')+'</select>'+
      '<div class="rpg-swatches">'+ids.map(id=>'<button type="button" data-tile="'+id+'" aria-label="'+t('Тайл ','Tile ')+id+
        '" title="'+t('Тайл ','Tile ')+id+'" aria-pressed="'+(id===current)+'"><i style="'+rpgTileStyle(id,24)+'"></i></button>').join('')+
      '</div></section>';
  }
  function mapsPanel(g,m) {
    return '<aside class="rpg-side"><div class="rpg-side-head"><strong>'+t('Локации','Maps')+'</strong>'+
      '<button type="button" data-cmd="add-map" title="'+t('Новая локация','New map')+'" aria-label="'+t('Новая локация','New map')+'">+</button></div>'+
      '<div class="rpg-maps">'+g.maps.map(a=>'<button type="button" data-map-id="'+esc(a.id)+'" aria-current="'+(a.id===m.id)+'">'+
        icon('layers',14)+'<span>'+esc(a.name)+'</span></button>').join('')+'</div>'+palette()+
      '<div class="rpg-credit" data-rpg-credit></div></aside>';
  }
  function mapDialog(m) {
    if (!mapForm) return '';
    const creating = mapForm === 'create';
    const title = creating ? t('Новая локация','New map') : t('Настройки локации','Map settings');
    return '<form class="rpg-map-form" data-map-form><strong>'+title+'</strong>'+
      '<label>'+t('Название','Name')+'<input data-map-name maxlength="100" required value="'+esc(creating?t('Локация ','Map ')+(game().maps.length+1):m.name)+'"></label>'+
      '<div class="rpg-form-actions"><button type="submit" class="rpg-primary">'+(creating?t('Создать','Create'):t('Сохранить','Save'))+'</button>'+
      button('cancel-map',t('Отмена','Cancel'))+(!creating && game().maps.length>1 ? button('delete-map',t('Удалить','Delete'),'','rpg-danger'):'')+'</div></form>';
  }
  function eventPanel(m,e) {
    if((draft || fieldDraft) && !e) return '<section class="rpg-event"><div class="rpg-event-head">'+
      t('Исходное событие удалено. Скопируйте текст черновика.','This event was removed. Copy your draft to keep it.')+'</div>'+
      '<textarea readonly>'+esc(draft?.text ?? fieldDraft.control.value)+'</textarea><div class="rpg-source-actions">'+button('discard-code',t('Сбросить черновик','Discard draft'))+'</div></section>';
    if (!e || mode!=='event') return '';
    const code = draft && e.id===draft.eventId ? draft.text : e.code;
    return '<section class="rpg-event"><div class="rpg-event-head"><span class="rpg-event-icon">'+icon('edit',14)+'</span>'+
      '<input data-event-name aria-label="'+t('Название события','Event name')+'" value="'+esc(e.name)+'" maxlength="100">'+
      '<select data-trigger aria-label="'+t('Запуск события','Event trigger')+'">'+
      '<option value="action" '+(e.trigger==='action'?'selected':'')+'>'+t('По действию · E','Interact · E')+'</option>'+
      '<option value="touch" '+(e.trigger==='touch'?'selected':'')+'>'+t('При входе на клетку','On step')+'</option></select>'+
      button('delete-event',icon('trash',14),'','rpg-icon')+button('close-event','×','','rpg-icon')+'</div>'+
      '<div class="rpg-event-bar"><div class="rpg-switch">'+button('blocks',t('Кирпичики','Blocks'),'',codeTab?'':'current')+button('code',t('Код','Code'),'',codeTab?'current':'')+'</div>'+
      '<span class="rpg-coords">'+['x','y'].map(axis=>'<label>'+axis.toUpperCase()+' <input type="number" data-event-pos="'+axis+'" step="1" value="'+e[axis]+'"></label>').join('')+'</span></div>'+
      (codeTab ? '<textarea data-event-code spellcheck="false" aria-label="'+t('Код события','Event source')+'">'+esc(code)+'</textarea>'+
        '<div class="rpg-source-actions">'+button('apply-code',t('Применить код','Apply code'),'','rpg-primary')+button('discard-code',t('Сбросить черновик','Discard draft'))+'</div>' :
        '<div class="rpg-blocks">'+eventBlocks(parseEvent(e.code),game().maps,esc)+'</div>')+'</section>';
  }
  function render() {
    if (!host || !empty) return;
    viewportObserver.disconnect();
    panDrag = null; hover = null;
    const scrollTop = root.querySelector('.rpg-swatches')?.scrollTop || 0;
    const blockScroll = root.querySelector('.rpg-blocks')?.scrollTop || 0;
    const g = game(), m = activeMap(g);
    mapId = m.id;
    const e = activeEvent(m);
    if (!e) eventId=null;
    const modeLabels = {
      pan:t('Потяните холст','Drag the canvas'),
      erase:t('Стирайте тайлы кистью','Brush to erase terrain'),
      paint:t('Нарисуйте тайлы на карте','Paint tiles on the map'),
      block:t('Нажмите на клетку, чтобы добавить или снять стену','Click a cell to add or remove a wall'),
      event:t('Нажмите на клетку, чтобы открыть или создать событие','Click a cell to open or create an event'),
      start:t('Выберите стартовую клетку игрока','Choose the player’s starting cell'),
    };
    root.innerHTML = '<header class="rpg-header"><div class="rpg-map-title">'+icon('layers',17)+'<strong>'+esc(m.name)+'</strong>'+
      '</div>'+button('map-settings',icon('settings',15),'','rpg-icon')+
      '<span class="rpg-spacer"></span>'+(!store.project.rpgGame ? button('example',t('Пример с дверью','Door example')):'')+
      button('ai',t('Ассистент','Assistant'),'wand')+
      button('play',t('Играть','Play'),'play','rpg-primary')+'</header>'+
      '<div class="rpg-workspace">'+mapsPanel(g,m)+'<main class="rpg-main"><div class="rpg-tools">'+
      tools.map(([id,ic,ru,en])=>'<button type="button" data-mode="'+id+'" title="'+t(ru,en)+'" aria-pressed="'+(mode===id)+'">'+icon(ic,14)+'<span>'+t(ru,en)+'</span></button>').join('')+
      (mode==='event' ? '<select data-template title="'+t('Новое событие','New event')+'" aria-label="'+t('Тип нового события','New event type')+'">'+
        '<option value="npc" '+(template==='npc'?'selected':'')+'>'+t('Персонаж','Character')+'</option>'+
        '<option value="door" '+(template==='door'?'selected':'')+'>'+t('Дверь','Door')+'</option></select>':'')+
      '<span class="rpg-spacer"></span><button data-cmd="grid" aria-label="'+t('Сетка','Grid')+'" title="'+t('Сетка','Grid')+'" aria-pressed="'+grid+'">'+icon('table',14)+'</button>'+
      '<button type="button" data-cmd="home" title="'+t('К старту','Go to start')+'" aria-label="'+t('К старту','Go to start')+'">'+icon('pin',14)+'</button>'+
      '<button type="button" data-cmd="fit" title="'+t('Показать всю локацию','Fit entire map')+'" aria-label="'+t('Показать всю локацию','Fit entire map')+'">'+icon('fit',14)+'</button>'+
      '<select data-zoom aria-label="'+t('Масштаб','Zoom')+'">'+zoomSteps.map(z=>'<option value="'+z+'">'+Math.round(100*z)+'%</option>').join('')+'</select></div>'+
      '<div class="rpg-scroll" data-map="'+esc(m.id)+'"><canvas tabindex="0" data-rpg-canvas aria-label="'+t('Карта локации','Map canvas')+'"></canvas><i class="rpg-brush" aria-hidden="true" hidden></i></div>'+
      eventPanel(m,e)+'<footer><span>'+modeLabels[mode]+'</span><span class="rpg-navigation-hint">'+t('Пробел + перетаскивание · Колесо — масштаб','Space + drag to pan · Wheel to zoom')+'</span><output data-cursor>—</output></footer></main></div>'+mapDialog(m)+
      '<div role="status" class="rpg-status" '+(!status?'hidden':'')+'>'+esc(status)+'</div>';
    const gear=root.querySelector('[data-cmd="map-settings"]');gear.title=gear.ariaLabel=t('Настройки локации','Map settings');
    const del=root.querySelector('[data-cmd="delete-event"]'),close=root.querySelector('[data-cmd="close-event"]');
    if(del)del.title=del.ariaLabel=t('Удалить событие','Delete event');
    if(close)close.title=close.ariaLabel=t('Закрыть событие','Close event');
    const credit = root.querySelector('[data-rpg-credit]');
    credit.textContent=rpgAtlas.credit; credit.title=rpgAtlas.contributors;
    viewportObserver.observe(root.querySelector('.rpg-scroll'));
    root.querySelector('.rpg-swatches').scrollTop=scrollTop;
    const blocks=root.querySelector('.rpg-blocks'); if(blocks) blocks.scrollTop=blockScroll;
    if(fieldDraft && fieldDraft.mapId===mapId && fieldDraft.eventId===e?.id){
      const replacement=root.querySelector(fieldDraft.selector);
      if(replacement){replacement.value=fieldDraft.control.value;fieldDraft.control=replacement;}
    }
    redraw();
  }
  function scheduleDraw() {
    if (host && !drawFrame) drawFrame = requestAnimationFrame(() => { drawFrame=0; redraw(); });
  }
  function view(canvas) {
    const rect = canvas.getBoundingClientRect(), c = camera(), size = tilePx*c.zoom;
    return {rect,c,size,left:c.x-rect.width/(2*size),top:c.y-rect.height/(2*size)};
  }
  function worldAt(v, clientX, clientY) {
    return {x:v.left+(clientX-v.rect.left)/v.size, y:v.top+(clientY-v.rect.top)/v.size};
  }
  function updateZoomMenu(zoom) {
    const menu = root.querySelector('[data-zoom]');
    if (menu.value === String(zoom)) return;
    menu.querySelector('[data-fit-scale]')?.remove();
    if (!zoomSteps.includes(zoom)) {
      const option = document.createElement('option');
      option.dataset.fitScale = '';
      option.value = String(zoom);
      option.textContent = zoom >= .01 ? Math.round(zoom*100)+'%' : '<1%';
      menu.append(option);
    }
    menu.value = String(zoom);
  }
  function redraw() {
    const canvas = root.querySelector('[data-rpg-canvas]');
    if (!canvas || !host) return;
    const {rect,c,size,left,top} = view(canvas);
    const w = rect.width, h = rect.height;
    if (w < 1 || h < 1) return;
    const ratio = window.devicePixelRatio || 1;
    const pw = Math.max(1,Math.round(w*ratio)), ph = Math.max(1,Math.round(h*ratio));
    if (canvas.width !== pw || canvas.height !== ph) {canvas.width=pw; canvas.height=ph;}
    canvas.dataset.worldLeft=left; canvas.dataset.worldTop=top; canvas.dataset.cellSize=size;
    canvas.dataset.tool = panDrag ? 'dragging' : spaceDown ? 'pan' : mode;
    updateZoomMenu(c.zoom);
    const ctx=canvas.getContext('2d');
    ctx.setTransform(pw/w,0,0,ph/h,0,0);
    ctx.clearRect(0,0,w,h);
    ctx.imageSmoothingEnabled=false;
    const g=stroke?.game || game(), m=activeMap(g);
    const onScreen = (x,y) => x+1>left && x<left+w/size && y+1>top && y<top+h/size;
    const loaded = atlas.complete && atlas.naturalWidth;
    const sx=x=>(x-left)*size, sy=y=>(y-top)*size;
    const draw = (id,x,y) => { if (loaded) drawRpgTile(ctx,atlas,id,sx(x),sy(y),size); };
    function terrain(x,y,id,blocked) {
      if (id !== null) {
        if (size<3) {
          ctx.fillStyle='#779659';ctx.fillRect(sx(x),sy(y),Math.max(1,size),Math.max(1,size));
        } else {
          if(id!==rpgDefaults.ground)draw(rpgDefaults.ground,x,y);
          draw(id,x,y);
        }
      }
      if(mode==='block' && blocked) {
        ctx.fillStyle='rgba(220,74,88,.55)';ctx.fillRect(sx(x),sy(y),Math.max(1,size),Math.max(1,size));
      }
    }
    if (size < 8) {
      forEachMapCell(m,(x,y,id,blocked)=>{ if(onScreen(x,y))terrain(x,y,id,blocked); });
    } else {
      const walls = mode === 'block' ? new Set(m.blocked) : null;
      const right=Math.ceil(left+w/size), bottom=Math.ceil(top+h/size);
      for(let y=Math.floor(top);y<bottom;y++)for(let x=Math.floor(left);x<right;x++){
        terrain(x,y,getMapTile(m,x,y),walls && isMapBlocked(m,x,y,walls));
      }
    }
    if(grid && size>=4) {
      const light = document.documentElement.dataset.theme === 'light';
      for(const spacing of size>=12 ? [1,8] : [8]) {
        const step=spacing*size;
        ctx.strokeStyle=light ? (spacing===1?'#38405229':'#38405249') : (spacing===1?'#9994a621':'#9994a643');
        ctx.lineWidth=1/ratio; ctx.beginPath();
        for(let x=sx(Math.ceil(left/spacing)*spacing);x<w;x+=step){const p=(Math.round(x*ratio)+.5)/ratio;ctx.moveTo(p,0);ctx.lineTo(p,h);}
        for(let y=sy(Math.ceil(top/spacing)*spacing);y<h;y+=step){const p=(Math.round(y*ratio)+.5)/ratio;ctx.moveTo(0,p);ctx.lineTo(w,p);}
        ctx.stroke();
      }
    }
    function marker(id,x,y,color) {
      if(!onScreen(x,y)) return;
      if (size>=4) draw(id,x,y);
      ctx.strokeStyle=color;ctx.lineWidth=1;
      ctx.strokeRect(sx(x)+.5,sy(y)+.5,Math.max(2,size-1),Math.max(2,size-1));
    }
    for(const e of m.events)marker(e.sprite,e.x,e.y,e.id===eventId?'#ffe279':'#bf9bff');
    if(g.start.mapId===m.id)marker(g.start.sprite,g.start.x,g.start.y,'#72dfac');
    drawBrush({left,top,size});
  }
  // The brush follows the pointer independently of the map raster.
  function drawBrush(v) {
    const brush=root.querySelector('.rpg-brush');
    if (!brush) return;
    brush.hidden=!hover || !!panDrag || spaceDown || mode==='pan' || v.size<4;
    if (brush.hidden) return;
    const preview=mode==='paint' && !stroke;
    const signature=[v.size,preview?tile:'-',mode].join('/');
    if (brush.dataset.style!==signature) {
      brush.dataset.style=signature;
      brush.style.cssText=preview ? rpgTileStyle(tile,v.size) : '';
      brush.style.width=v.size+'px';brush.style.height=v.size+'px';
      brush.classList.toggle('erase',mode==='erase');
    }
    brush.style.transform='translate('+((hover.x-v.left)*v.size)+'px,'+((hover.y-v.top)*v.size)+'px)';
  }
  atlas.onload=scheduleDraw;
  atlas.onerror=()=>message(t('Не удалось загрузить набор тайлов.','Could not load tileset.'));
  atlas.src=rpgAtlas.url;
  function locate(event) {
    const canvas=root.querySelector('[data-rpg-canvas]');
    if (!canvas) return null;
    const v=view(canvas), r=v.rect;
    if (event.clientX<r.left || event.clientY<r.top || event.clientX>=r.right || event.clientY>=r.bottom) return null;
    const p=worldAt(v,event.clientX,event.clientY);
    const x=Math.floor(p.x),y=Math.floor(p.y);
    return validMapCoordinate(x) && validMapCoordinate(y) ? {x,y} : null;
  }
  function paintCell(cell) {
    const m=activeMap(stroke.game), last=stroke.last || cell;
    const steps=Math.max(1,Math.abs(cell.x-last.x),Math.abs(cell.y-last.y));
    for(let j=1;j<=steps;j++){
      const x=Math.round(last.x+(cell.x-last.x)*j/steps), y=Math.round(last.y+(cell.y-last.y)*j/steps);
      const patch = mode === 'paint' ? {tile} : mode === 'erase' ? {tile:null,blocked:false} : {blocked:stroke.wall};
      if (mode==='block' && stroke.wall && getMapTile(m,x,y)===null) patch.tile=rpgDefaults.ground;
      if (setMapCell(m,x,y,patch)) stroke.changed=true;
    }
    stroke.last=cell;scheduleDraw();
  }
  function zoomAt(zoom, clientX, clientY) {
    const canvas=root.querySelector('[data-rpg-canvas]');
    if(!canvas || stroke || panDrag) return;
    const v=view(canvas), c=v.c;
    if (clientX!==undefined) {
      const point=worldAt(v,clientX,clientY);
      c.x=clampCenter(point.x-(clientX-v.rect.left-v.rect.width/2)/(tilePx*zoom));
      c.y=clampCenter(point.y-(clientY-v.rect.top-v.rect.height/2)/(tilePx*zoom));
    }
    c.zoom=zoom;saveViewSoon();redraw();
  }
  root.addEventListener('wheel',event=>{
    if (!event.target.matches('[data-rpg-canvas]')) return;
    event.preventDefault();
    if (!event.deltaY || stroke || panDrag) return;
    const c=camera();
    const zoom=event.deltaY<0 ? zoomSteps.find(z=>z>c.zoom) : zoomSteps.findLast(z=>z<c.zoom);
    if(zoom) zoomAt(zoom,event.clientX,event.clientY);
  },{passive:false});
  root.addEventListener('pointerdown',event=>{
    const canvas=event.target;
    if(!canvas.matches('[data-rpg-canvas]') || stroke || panDrag)return;
    if(event.button===1 || (event.button===0 && (spaceDown || event.altKey || mode==='pan'))){
      event.preventDefault();canvas.focus({preventScroll:true});
      const c=camera();
      panDrag={ptr:event.pointerId,x:event.clientX,y:event.clientY,cx:c.x,cy:c.y};
      canvas.setPointerCapture(event.pointerId);redraw();return;
    }
    if(event.button!==0 || !flush())return;
    const at=locate(event); if(!at)return;
    if (camera().zoom<zoomSteps[0]) { Object.assign(camera(),{x:at.x+.5,y:at.y+.5,zoom:2}); saveViewSoon();redraw();return; }
    const m=activeMap();
    if(mode==='paint' || mode==='erase' || mode==='block'){
      stroke={game:structuredClone(game()),base:store.project.rpgGame,mapId,ptr:event.pointerId,wall:!isMapBlocked(m,at.x,at.y)};
      canvas.setPointerCapture(event.pointerId);paintCell(at);
    }else if(mode==='start'){
      update(t('Старт игрока','Player spawn'),(g,m)=>{ensureFloor(m,at.x,at.y);Object.assign(g.start,{mapId,...at});});
    }else{
      const found=m.events.find(e=>e.x===at.x && e.y===at.y);
      if(found){eventId=found.id;draft=null;message('');render();return;}
      const id=newId('ev');
      if(update(t('Создать событие','Create event'),(g,m)=>{
        ensureFloor(m,at.x,at.y);
        const door=template==='door';
        const ev={id,...at,name:(door?t('Дверь ','Door '):t('Персонаж ','Character '))+(m.events.length+1),sprite,trigger:door?'touch':'action',code:''};
        m.events.push(ev);
        const destination=g.maps.find(other=>other.id!==m.id) || m;
        ev.code=formatEvent(door?[{op:'goto',...firstDestination(destination)}]:[{op:'say',text:t('Привет!','Hello!')}]);
      },false)){eventId=id;codeTab=false;render();}
    }
  });
  root.addEventListener('pointermove',event=>{
    if(!event.target.matches('[data-rpg-canvas]'))return;
    if(panDrag?.ptr===event.pointerId){
      const c=camera(), size=tilePx*c.zoom;
      c.x=clampCenter(panDrag.cx-(event.clientX-panDrag.x)/size);
      c.y=clampCenter(panDrag.cy-(event.clientY-panDrag.y)/size);
      saveViewSoon();
    }
    const at=locate(event);
    root.querySelector('[data-cursor]').value=at ? at.x+', '+at.y : '—';
    hover=at;
    if(stroke?.ptr===event.pointerId){
      if(!at) stroke.last=null;
      else if(!stroke.last || at.x!==stroke.last.x || at.y!==stroke.last.y)paintCell(at);
    }
    if (panDrag) scheduleDraw();
    else drawBrush(view(event.target));
  });
  function clampCenter(value) { return Math.max(-1e9,Math.min(1e9,value)); }
  root.addEventListener('pointerout',event=>{
    if(event.target.matches('[data-rpg-canvas]')){hover=null;drawBrush(view(event.target));}
  });
  window.addEventListener('keydown',event=>{
    if(!host || event.code!=='Space' || event.ctrlKey || event.altKey || event.metaKey ||
       event.target.closest?.('input,select,textarea,[contenteditable="true"],dialog') ||
       !root.querySelector('[data-rpg-canvas]:is(:focus,:hover)'))return;
    event.preventDefault();spaceDown=true;scheduleDraw();
  });
  window.addEventListener('keyup',event=>{if(event.code==='Space' && spaceDown){spaceDown=false;scheduleDraw();}});
  window.addEventListener('blur',()=>{spaceDown=false;panDrag=null;stroke=null;hover=null;scheduleDraw();});
  function endStroke(event) {
    if(panDrag?.ptr===event.pointerId){panDrag=null;hover=null;persistView();scheduleDraw();return;}
    if(stroke?.ptr!==event.pointerId)return;
    const s=stroke;stroke=null;
    if(event.type==='pointerup' && s.changed && s.base===store.project.rpgGame && mapId===s.mapId){
      const label=mode==='erase'?t('Стереть тайлы','Erase tiles'):mode==='block'?t('Изменить стены','Paint collision'):t('Нарисовать тайлы','Paint tiles');
      commit(s.game,label,false);
      if(!s.base)render(); else redraw();
    }else redraw();
  }
  for(const type of ['pointerup','pointercancel','lostpointercapture'])root.addEventListener(type,endStroke);
  function handleBlock(control) {
    const field=control.hasAttribute('data-field');
    const ok=update(t('Изменить кирпичики','Edit event blocks'),(g,m,e)=>{
      const list=parseEvent(e.code);changeBlock(list,control,m,g.maps);e.code=formatEvent(list);
    },!field || control.dataset.field==='mapId');
    if(!ok)render();
  }
  function fieldKey(c) {
    if(c.hasAttribute('data-field'))return 'code';
    if(c.hasAttribute('data-event-pos'))return c.dataset.eventPos;
    return 'name';
  }
  function flushField() {
    if(!fieldDraft)return true;
    const f=fieldDraft, c=f.control, e=activeEvent();
    if(mapId!==f.mapId || e?.id!==f.eventId || e[f.key]!==f.base){
      message(t('Событие изменилось. Скопируйте значение и нажмите Esc, чтобы сбросить правку.','The event changed. Copy the value and press Esc to discard this edit.'));
      return false;
    }
    const ok=update(t('Изменить событие','Edit event'),(g,m,e)=>{
      if(c.hasAttribute('data-field')){
        const list=parseEvent(e.code);changeBlock(list,c,m,g.maps);e.code=formatEvent(list);
      }else if(f.key==='name')e.name=c.value.trim();
      else { e[f.key]=c.valueAsNumber; ensureFloor(m,e.x,e.y); }
    },false);
    if(ok){fieldDraft=null;redraw();}
    return ok;
  }
  root.addEventListener('input',event=>{
    const c=event.target;
    if(c.matches('input[data-field],input[data-event-pos],[data-event-name]')){
      const e=activeEvent();if(!e)return;
      if(!fieldDraft || fieldDraft.control!==c){
        const key=fieldKey(c);
        const selector=key==='code'?'input[data-path="'+c.dataset.path+'"][data-field="'+c.dataset.field+'"]':
          key==='name'?'[data-event-name]':'[data-event-pos="'+key+'"]';
        fieldDraft={control:c,selector,key,mapId,eventId:e.id,base:e[key]};
      }
      return;
    }
    if(!c.matches('[data-event-code]'))return;
    const e=activeEvent(); if(!e)return;
    draft={mapId,eventId:e.id,base:draft?.base ?? e.code,text:c.value};
    message('');
  });
  root.addEventListener('keydown',event=>{
    if(event.key!=='Escape')return;
    if(fieldDraft){fieldDraft=null;message('');render();event.stopPropagation();}
    else if(mapForm){mapForm='';render();event.stopPropagation();}
  });
  root.addEventListener('change',event=>{
    const c=event.target;
    if(c.matches('input[data-field],input[data-event-pos],[data-event-name]')){
      if(!flushField()){fieldDraft=null;render();}
      return;
    }
    if(c.matches('[data-add],[data-field]')){handleBlock(c);return;}
    if(c.matches('[data-group]')) { group=c.value; render();root.querySelector('.rpg-swatches').scrollTop=0; }
    if(c.matches('[data-template]') && flush()) {
      template=c.value; eventId=null; sprite=template==='door'?rpgDefaults.door:rpgDefaults.npc;
      group=template==='door'?'buildings':'actors';render();
    }
    if(c.matches('[data-zoom]')) zoomAt(Number(c.value));
    if(c.matches('[data-trigger]')) {
      const ok=update(t('Свойства события','Event properties'),(_,m,e)=>{ e.trigger=c.value; },false);
      if(ok)redraw();else render();
    }
  });
  root.addEventListener('submit',event=>{
    event.preventDefault();
    if(!event.target.matches('[data-map-form]'))return;
    const name=root.querySelector('[data-map-name]').value.trim();
    const creating=mapForm==='create';
    const id=creating?newId('map'):mapId;
    if(update(t('Настроить локацию','Edit map'),(g,m)=>{
      if(creating)g.maps.push(createMap(id,name));
      else m.name=name;
    },false)){mapId=id;eventId=null;mapForm='';render();saveViewSoon();}
  });
  async function act(action) {
    if(action==='discard-code'){ draft=null;fieldDraft=null;message(''); render();return; }
    if(action==='apply-code'){if(flush()){message(t('Код применён','Code applied'));render();}return;}
    if(!flush())return;
    const original=game(), currentMap=activeMap(), currentEvent=activeEvent();
    switch(action){
      case 'ai': ui.setRightTab('ai');return;
      case 'play': openRpgPlayer(original,{mapId});return;
      case 'example': if(!store.project.rpgGame){const ex=createRpgExample();mapId=ex.start.mapId;eventId=null;mode='paint';commit(ex,t('Пример с дверью','Door example'));saveViewSoon();}return;
      case 'grid':grid=!grid;break;
      case 'home':{
        const p=homePoint(currentMap);
        Object.assign(camera(),{x:p.x+.5,y:p.y+.5,zoom:2});saveViewSoon();redraw();return;
      }
      case 'fit':{
        const b=getMapBounds(currentMap);
        const r=root.querySelector('[data-rpg-canvas]').getBoundingClientRect();
        const width=b.maxX-b.minX+1,height=b.maxY-b.minY+1;
        const maxZoom=Math.min(Math.max(1,r.width-56)/(width*tilePx), Math.max(1,r.height-56)/(height*tilePx));
        const zoom=zoomSteps.findLast(z=>z<=Math.min(4,maxZoom)) || maxZoom;
        Object.assign(camera(),{x:b.minX+width/2,y:b.minY+height/2,zoom});saveViewSoon();redraw();return;
      }
      case 'code':codeTab=true;break;
      case 'blocks':codeTab=false;break;
      case 'close-event':eventId=null;break;
      case 'add-map':mapForm='create';break;
      case 'map-settings':mapForm='edit';break;
      case 'cancel-map':mapForm='';break;
      case 'delete-map':
      case 'delete-event':{
        const removeMap=action==='delete-map';
        const label=removeMap?t('Удалить локацию?','Delete map?'):t('Удалить событие?','Delete event?');
        if(!await ui.confirm(label,{detail:removeMap?currentMap.name:currentEvent.name,danger:true}) || game()!==original)return;
        if(update(label,(g,m)=>{
          if(removeMap){
            if(g.start.mapId===m.id)throw Error(t('Сначала перенесите старт в другую локацию.','Move the player spawn to another map first.'));
            g.maps=g.maps.filter(n=>n.id!==m.id);
          } else m.events=m.events.filter(n=>n.id!==currentEvent.id);
        },false)){mapForm='';eventId=null;render();saveViewSoon();}
        return;
      }
      default:return;
    }
    message('');render();
  }
  root.addEventListener('click',event=>{
    const c=event.target.closest('button'); if(!c)return;
    if(c.hasAttribute('data-cmd')){void act(c.dataset.cmd).catch(err=>message(err.message));return;}
    if(c.hasAttribute('data-block')){handleBlock(c);return;}
    if(!flush())return;
    if(c.hasAttribute('data-mode')){
      const before=mode==='event'||mode==='start';
      mode=c.dataset.mode;
      const after=mode==='event'||mode==='start';
      if(before!==after)group=after?'actors':'terrain';
      message('');render();return;
    }
    if(c.hasAttribute('data-map-id')){mapId=c.dataset.mapId;eventId=null;mapForm='';message('');render();saveViewSoon();return;}
    if(c.hasAttribute('data-tile')){
      const id=Number(c.dataset.tile);
      if(mode==='start')update(t('Спрайт игрока','Player sprite'),g=>{g.start.sprite=id;});
      else if(mode==='event'){
        sprite=id;
        if(activeEvent())update(t('Спрайт события','Event sprite'),(_,m,e)=>{e.sprite=id;});
        else render();
      }else{mode='paint';tile=id;render();}
    }
  });
  function refresh() {
    if(writing || !host)return;
    if(generation!==store.generation || !empty){
      persistView();
      empty=createGame();generation=store.generation;mapId=game().start.mapId;eventId=null;
      restoreView();
      stroke=null;draft=null;fieldDraft=null;mapForm='';mode='paint';codeTab=false;status='';
    } else if(knownGame===store.project.rpgGame && language===getLanguage()) return;
    knownGame=store.project.rpgGame;language=getLanguage();stroke=null;render();
  }
  return {
    show(target){
      if(host!==target || root.parentElement!==target){host=target;host.replaceChildren(root);language=null;}
      refresh();
    },
    hide(){
      persistView();
      host=null;stroke=null;panDrag=null;hover=null;spaceDown=false;
      cancelAnimationFrame(drawFrame);drawFrame=0;viewportObserver.disconnect();root.remove();
    },
    refresh,flush,persistView,
    context(){
      const c=host ? camera() : null;
      return {mapId:mapId || null,eventId:eventId || null,center:c ? {x:Math.floor(c.x),y:Math.floor(c.y)} : null};
    },
  };
}
