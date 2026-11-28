import { getLanguage, t } from './i18n.js';
import { icon } from './icons.js';
import { createMap, createGame, parseEvent, formatEvent } from './rpg-model.js';
import { drawRpgTile, rpgAtlas, rpgDefaults, rpgTileStyle, tileGroups } from './rpg-assets.js';
import { createRpgExample } from './rpg-example.js';
import { openRpgPlayer } from './rpg-player.js';
import { changeBlock, eventBlocks, firstDestination } from './rpg-editor-blocks.js';

const tools = [
  ['paint','edit','Тайлы','Tiles'], ['block','layout','Стены','Collision'],
  ['event','branch','События','Events'], ['start','user','Старт','Spawn'],
];
const tilePx = 16;
const newId = prefix => prefix + '_' + crypto.randomUUID().slice(0,8);

export function createRpgEditor(store, ui) {
  const root = document.createElement('section');
  root.className = 'rpg-editor';
  const esc = ui.escapeHTML;
  const atlas = new Image();
  let host, empty, mapId, eventId, generation, knownGame, language;
  let mode = 'paint', group = 'terrain', tile = rpgDefaults.ground, sprite = rpgDefaults.npc;
  let zoom = 2, grid = true, codeTab = false, mapForm = '', status = '', writing = false;
  let stroke, draft, fieldDraft, template = 'npc';
  const game = () => store.project.rpgGame || empty;
  const activeMap = (g = game()) => g.maps.find(m=>m.id === mapId) || g.maps[0];
  const activeEvent = (m = activeMap()) => m.events.find(e=>e.id === eventId);

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
    const ids = g?.tiles || Array.from({length:rpgAtlas.count},(_,i)=>i);
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
      (creating ? '<label>'+t('Ширина','Width')+'<input data-map-width type="number" value="16" min="1" max="128" required></label>'+
        '<label>'+t('Высота','Height')+'<input data-map-height type="number" value="12" min="1" max="128" required></label>' : '')+
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
      '<span class="rpg-coords">'+['x','y'].map(axis=>'<label>'+axis.toUpperCase()+' <input type="number" data-event-pos="'+axis+'" min="0" max="'+((axis==='x'?m.width:m.height)-1)+'" value="'+e[axis]+'"></label>').join('')+'</span></div>'+
      (codeTab ? '<textarea data-event-code spellcheck="false" aria-label="'+t('Код события','Event source')+'">'+esc(code)+'</textarea>'+
        '<div class="rpg-source-actions">'+button('apply-code',t('Применить код','Apply code'),'','rpg-primary')+button('discard-code',t('Сбросить черновик','Discard draft'))+'</div>' :
        '<div class="rpg-blocks">'+eventBlocks(parseEvent(e.code),game().maps,esc)+'</div>')+'</section>';
  }
  function render() {
    if (!host || !empty) return;
    const old = root.querySelector('.rpg-scroll');
    const pan = old && old.dataset.map === mapId ? [old.scrollLeft, old.scrollTop] : [0,0];
    const scrollTop = root.querySelector('.rpg-swatches')?.scrollTop || 0;
    const blockScroll = root.querySelector('.rpg-blocks')?.scrollTop || 0;
    const g = game(), m = activeMap(g);
    mapId = m.id;
    const e = activeEvent(m);
    if (!e) eventId=null;
    const modeLabels = {
      paint:t('Нарисуйте тайлы на карте','Paint tiles on the map'),
      block:t('Нажмите на клетку, чтобы добавить или снять стену','Click a cell to add or remove a wall'),
      event:t('Нажмите на клетку, чтобы открыть или создать событие','Click a cell to open or create an event'),
      start:t('Выберите стартовую клетку игрока','Choose the player’s starting cell'),
    };
    root.innerHTML = '<header class="rpg-header"><div class="rpg-map-title">'+icon('layers',17)+'<strong>'+esc(m.name)+'</strong>'+
      '<small>'+m.width+' × '+m.height+'</small></div>'+button('map-settings',icon('settings',15),'','rpg-icon')+
      '<span class="rpg-spacer"></span>'+(!store.project.rpgGame ? button('example',t('Пример с дверью','Door example')):'')+
      button('ai',t('Ассистент','Assistant'),'wand')+
      button('play',t('Играть','Play'),'play','rpg-primary')+'</header>'+
      '<div class="rpg-workspace">'+mapsPanel(g,m)+'<main class="rpg-main"><div class="rpg-tools">'+
      tools.map(([id,ic,ru,en])=>'<button type="button" data-mode="'+id+'" title="'+t(ru,en)+'" aria-pressed="'+(mode===id)+'">'+icon(ic,14)+'<span>'+t(ru,en)+'</span></button>').join('')+
      (mode==='event' ? '<select data-template title="'+t('Новое событие','New event')+'" aria-label="'+t('Тип нового события','New event type')+'">'+
        '<option value="npc" '+(template==='npc'?'selected':'')+'>'+t('Персонаж','Character')+'</option>'+
        '<option value="door" '+(template==='door'?'selected':'')+'>'+t('Дверь','Door')+'</option></select>':'')+
      '<span class="rpg-spacer"></span><button data-cmd="grid" aria-label="'+t('Сетка','Grid')+'" title="'+t('Сетка','Grid')+'" aria-pressed="'+grid+'">'+icon('table',14)+'</button>'+
      '<select data-zoom aria-label="'+t('Масштаб','Zoom')+'">'+[1,1.5,2,3].map(z=>'<option value="'+z+'" '+(z===zoom?'selected':'')+'>'+Math.round(100*z)+'%</option>').join('')+'</select></div>'+
      '<div class="rpg-scroll" data-map="'+esc(m.id)+'"><div class="rpg-board"><canvas tabindex="0" data-rpg-canvas aria-label="'+t('Карта локации','Map canvas')+'" width="'+m.width*tilePx+'" height="'+m.height*tilePx+
      '" style="width:'+m.width*tilePx*zoom+'px;height:'+m.height*tilePx*zoom+'px"></canvas></div></div>'+
      eventPanel(m,e)+'<footer><span>'+modeLabels[mode]+'</span><output data-cursor>—</output></footer></main></div>'+mapDialog(m)+
      '<div role="status" class="rpg-status" '+(!status?'hidden':'')+'>'+esc(status)+'</div>';
    const gear=root.querySelector('[data-cmd="map-settings"]');gear.title=gear.ariaLabel=t('Настройки локации','Map settings');
    const del=root.querySelector('[data-cmd="delete-event"]'),close=root.querySelector('[data-cmd="close-event"]');
    if(del)del.title=del.ariaLabel=t('Удалить событие','Delete event');
    if(close)close.title=close.ariaLabel=t('Закрыть событие','Close event');
    root.querySelector('[data-rpg-credit]').textContent=atlasCredit();
    root.querySelector('.rpg-scroll').scrollTo(...pan);
    root.querySelector('.rpg-swatches').scrollTop=scrollTop;
    const blocks=root.querySelector('.rpg-blocks'); if(blocks) blocks.scrollTop=blockScroll;
    if(fieldDraft && fieldDraft.mapId===mapId && fieldDraft.eventId===e?.id){
      const replacement=root.querySelector(fieldDraft.selector);
      if(replacement){replacement.value=fieldDraft.control.value;fieldDraft.control=replacement;}
    }
    redraw();
  }
  function atlasCredit() { return 'Kenney · CC0'; }
  function redraw() {
    const canvas = root.querySelector('canvas[data-rpg-canvas]');
    if(!canvas || !host) return;
    const ctx=canvas.getContext('2d'); ctx.imageSmoothingEnabled=false;
    const g=stroke?.game || game(), m=activeMap(g);
    ctx.fillStyle='#353739'; ctx.fillRect(0,0,canvas.width,canvas.height);
    const loaded = atlas.complete && atlas.naturalWidth;
    const draw = (id,x,y) => { if(loaded)drawRpgTile(ctx,atlas,id,x*tilePx,y*tilePx,tilePx); };
    if(loaded) m.tiles.forEach((id,i)=>{
      const x=i%m.width, y=Math.floor(i/m.width);
      if(id!==rpgDefaults.ground)draw(rpgDefaults.ground,x,y);
      draw(id,x,y);
    });
    if(mode==='block') {
      ctx.fillStyle='rgba(220,74,88,.55)';
      for(const i of m.blocked)ctx.fillRect(i%m.width*tilePx,Math.floor(i/m.width)*tilePx,tilePx,tilePx);
    }
    if(grid){
      ctx.strokeStyle='rgba(12,16,22,.2)'; ctx.lineWidth=0.5; ctx.beginPath();
      for(let x=tilePx;x<canvas.width;x+=tilePx){ctx.moveTo(x,0);ctx.lineTo(x,canvas.height);}
      for(let y=tilePx;y<canvas.height;y+=tilePx){ctx.moveTo(0,y);ctx.lineTo(canvas.width,y);}
      ctx.stroke();
    }
    const marker=(id,x,y,color)=>{
      draw(id,x,y);ctx.strokeStyle=color;ctx.lineWidth=1;
      ctx.strokeRect(x*tilePx+.5,y*tilePx+.5,tilePx-1,tilePx-1);
    };
    for(const e of m.events)marker(e.sprite,e.x,e.y,e.id===eventId?'#ffe279':'#bf9bff');
    if(g.start.mapId===m.id)marker(g.start.sprite,g.start.x,g.start.y,'#72dfac');
  }
  atlas.onload=()=>redraw();
  atlas.onerror=()=>message(t('Не удалось загрузить набор тайлов.','Could not load tileset.'));
  atlas.src=rpgAtlas.url;
  function locate(event) {
    const canvas=root.querySelector('[data-rpg-canvas]');
    if(!canvas)return null;
    const rect=canvas.getBoundingClientRect(), m=activeMap();
    const x=Math.floor((event.clientX-rect.left)*m.width/rect.width), y=Math.floor((event.clientY-rect.top)*m.height/rect.height);
    return x>=0 && y>=0 && x<m.width && y<m.height ? {x,y}:null;
  }
  function paintCell(cell) {
    const m=activeMap(stroke.game), last=stroke.last || cell;
    const steps=Math.max(1,Math.abs(cell.x-last.x),Math.abs(cell.y-last.y));
    for(let j=1;j<=steps;j++){
      const x=Math.round(last.x+(cell.x-last.x)*j/steps),y=Math.round(last.y+(cell.y-last.y)*j/steps),i=y*m.width+x;
      if(mode==='paint'){if(m.tiles[i]!==tile){m.tiles[i]=tile;stroke.changed=true;}}
      else if(stroke.wall!==stroke.walls.has(i)){if(stroke.wall)stroke.walls.add(i);else stroke.walls.delete(i);stroke.changed=true;}
    }
    if(mode==='block')m.blocked=[...stroke.walls];
    stroke.last=cell;redraw();
  }
  root.addEventListener('pointerdown',event=>{
    if(!event.target.matches('[data-rpg-canvas]') || event.button!==0 || !flush())return;
    const at=locate(event); if(!at)return;
    const m=activeMap();
    if(mode==='paint' || mode==='block'){
      stroke={game:structuredClone(game()),base:store.project.rpgGame,mapId,ptr:event.pointerId,walls:new Set(m.blocked),wall:!m.blocked.includes(at.y*m.width+at.x)};
      event.target.setPointerCapture(event.pointerId);paintCell(at);
    }else if(mode==='start'){
      update(t('Старт игрока','Player spawn'),g=>{Object.assign(g.start,{mapId,...at});});
    }else{
      const found=m.events.find(e=>e.x===at.x && e.y===at.y);
      if(found){eventId=found.id;draft=null;message('');render();return;}
      const id=newId('ev');
      if(update(t('Создать событие','Create event'),(g,m)=>{
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
    const at=locate(event); if(!at)return;
    root.querySelector('[data-cursor]').value=at.x+', '+at.y;
    if(stroke?.ptr===event.pointerId && (!stroke.last || at.x!==stroke.last.x || at.y!==stroke.last.y))paintCell(at);
  });
  function endStroke(event) {
    if(stroke?.ptr!==event.pointerId)return;
    const s=stroke;stroke=null;
    if(event.type==='pointerup' && s.changed && s.base===store.project.rpgGame && mapId===s.mapId){
      commit(s.game,mode==='block'?t('Изменить стены','Paint collision'):t('Нарисовать тайлы','Paint tiles'),false);
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
      else e[f.key]=c.valueAsNumber;
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
    if(c.matches('[data-zoom]')) { zoom=Number(c.value);render(); }
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
      if(creating)g.maps.push(createMap(id,name,root.querySelector('[data-map-width]').valueAsNumber,root.querySelector('[data-map-height]').valueAsNumber,rpgDefaults.ground));
      else m.name=name;
    },false)){mapId=id;eventId=null;mapForm='';render();}
  });
  async function act(action) {
    if(action==='discard-code'){ draft=null;fieldDraft=null;message(''); render();return; }
    if(action==='apply-code'){if(flush()){message(t('Код применён','Code applied'));render();}return;}
    if(!flush())return;
    const original=game(), currentMap=activeMap(), currentEvent=activeEvent();
    switch(action){
      case 'ai': ui.setRightTab('ai');return;
      case 'play': openRpgPlayer(original,{mapId});return;
      case 'example': if(!store.project.rpgGame){const ex=createRpgExample();mapId=ex.start.mapId;eventId=null;mode='paint';commit(ex,t('Пример с дверью','Door example'));}return;
      case 'grid':grid=!grid;break;
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
        },false)){mapForm='';eventId=null;render();}
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
    if(c.hasAttribute('data-map-id')){mapId=c.dataset.mapId;eventId=null;mapForm='';message('');render();return;}
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
      empty=createGame();generation=store.generation;mapId=game().start.mapId;eventId=null;
      stroke=null;draft=null;fieldDraft=null;mapForm='';mode='paint';codeTab=false;status='';
    } else if(knownGame===store.project.rpgGame && language===getLanguage()) return;
    knownGame=store.project.rpgGame;language=getLanguage();stroke=null;render();
  }
  return {
    show(target){
      if(host!==target || root.parentElement!==target){host=target;host.replaceChildren(root);language=null;}
      refresh();
    },
    hide(){host=null;stroke=null;root.remove();},
    refresh,flush,
    context(){return {mapId:mapId || null,eventId:eventId || null};},
  };
}
