import { addRpgMap, createGame, createMap, deleteRpgMap, gameSettings, getMapBounds, getMapTile, hudPositions, isMapBlocked, setMapCell, validateGame, validMapCoordinate, walkTiming } from './rpg-model.js';
import { rpgAtlas, rpgDefaults, tileGroups } from './rpg-assets.js';
import { t } from './i18n.js';

const str = description => ({type:'string',description});
const int = description => ({type:'integer',description});
const object = (properties, required = []) => ({type:'object',properties,required,additionalProperties:false});
const id = str('Stable identifier. Use a short letter-led name with underscores.');
const coord = int('Signed world tile coordinate on the open canvas.');
const tile = int('Tile ID from the included atlas.');
const action = object({
  action:{type:'string',enum:['addMap','renameMap','deleteMap','paint','erase','start','event','deleteEvent','setMovement','panel','deletePanel']},
  stepMs:{type:'integer',minimum:walkTiming.min,maximum:walkTiming.max,description:'Milliseconds per tile for the player on every map. Lower is faster. Default 180.'},
  panelId:id,title:str('In-game HUD heading'),text:str('HUD text. Use {variableName} to show a live event variable.'),
  position:{type:'string',enum:hudPositions},
  mapId:id,eventId:id,name:str('Display name'),width:int('Paint rectangle or initial filled patch width'),height:int('Paint rectangle or initial filled patch height'),
  x:coord,y:coord,tile,blocked:{type:'boolean'},sprite:tile,trigger:{enum:['action','touch'],type:'string'},
  code:str('Complete event source. One command per line: say "Hi"; set key = true; if key == true / else / end; goto map_id 1 2.')
},['action']);
const inRange = (v,max) => Number.isInteger(v) && v >= 0 && v < max;
function findMap(game, mapId) {
  const map = game.maps.find(m => m.id === mapId);
  if (!map) throw Error('Unknown map: ' + mapId);
  return map;
}
function placeFloor(map, point) {
  if (validMapCoordinate(point.x) && validMapCoordinate(point.y) && getMapTile(map,point.x,point.y) === null)
    setMapCell(map,point.x,point.y,{tile:rpgDefaults.ground});
}
function rectangle(a, maxSide = 128) {
  const {x=0,y=0,width=1,height=1} = a;
  if (!validMapCoordinate(x) || !validMapCoordinate(y) ||
      !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > maxSide || height > maxSide || !validMapCoordinate(x+width-1) || !validMapCoordinate(y+height-1)) throw Error('Invalid world coordinates or rectangle size.');
  return {x,y,width,height};
}
function paged(list, offset, limit) {
  if (!Number.isInteger(offset) || offset < 0) throw Error('Invalid offset');
  return {items:list.slice(offset,offset+limit),total:list.length,nextOffset:offset+limit<list.length?offset+limit:null};
}
function readSettings(game, offset = 0) {
  const settings = gameSettings(game);
  if (!Number.isInteger(offset) || offset < 0) throw Error('Invalid panel offset.');
  if (offset === 0 && JSON.stringify(settings).length <= 5500) return settings;
  const {stepMs,panels} = settings;
  const page = [];
  let size = 0;
  for (const panel of panels.slice(offset)) {
    const length = JSON.stringify(panel).length + 1;
    if (page.length && size + length > 5000) break;
    page.push(panel);
    size += length;
  }
  const next = offset + page.length;
  return {stepMs,panels:page,total:panels.length,nextOffset:next < panels.length ? next : null};
}
export function registerRpgTools({tool,project,active,stage,ui}) {
  tool('get_rpg_game', () => 'Read maps, player spawn, events, event code, tile rectangles, settings or palette. settings returns player stepMs and in-game HUD panels. Use the palette for tile and sprite IDs. Tapping a direction moves one tile; holding it walks at constant speed. Compatible sprite sheets supply directional walk frames. Coordinates may be negative; null tiles are empty. Map bounds describe existing content. Event code offsets are characters.',
    () => object({view:{type:'string',enum:['maps','events','code','tiles','palette','settings']},mapId:id,eventId:id,offset:int('Pagination offset'),x:coord,y:coord,width:int('Up to 16'),height:int('Up to 16')}), a => {
      active().plan.observe('rpgGame');
      if (a.view === 'palette') return {count:rpgAtlas.visibleCount,defaults:rpgDefaults,groups:tileGroups.map(g => ({name:g.en,tiles:g.tiles}))};
      const game = project().rpgGame;
      if (a.view === 'settings') return readSettings(game,a.offset);
      if (!game) return {initialized:false,initialMapId:'map_1',defaults:rpgDefaults};
      const offset = a.offset ?? 0;
      if (!a.view || a.view === 'maps') {
        const page = paged(game.maps,offset,15);
        const items = page.items.map(m => {
          const bounds = getMapBounds(m);
          return {id:m.id,name:m.name,bounds,width:bounds.maxX-bounds.minX+1,height:bounds.maxY-bounds.minY+1,events:m.events.length};
        });
        return {start:game.start,...page,items};
      }
      const map = findMap(game,a.mapId);
      if (a.view === 'events') return paged(map.events.map(({code,...e})=>e),offset,15);
      if (a.view === 'code') {
        const event = map.events.find(e => e.id === a.eventId);
        if (!event) throw Error('Unknown event');
        if (!Number.isInteger(offset) || offset < 0) throw Error('Invalid offset');
        const {code,...fields} = event;
        return {...fields,code:code.slice(offset,offset+2000),length:code.length,nextOffset:offset+2000<code.length?offset+2000:null};
      }
      if (a.view !== 'tiles') throw Error('Unknown read mode');
      const rect = rectangle(a,16), rows = [], blocked = [];
      for (let y=rect.y; y<rect.y+rect.height; y++) {
        const row = [];
        for (let x=rect.x; x<rect.x+rect.width; x++) {
          row.push(getMapTile(map,x,y));
          if (isMapBlocked(map,x,y)) blocked.push([x,y]);
        }
        rows.push(row);
      }
      return {...rect,rows,blocked};
    });
  tool('edit_rpg_game', () => 'Edit the prototype in one transaction. Global actions omit mapId: setMovement sets stepMs, panel creates or patches a panelId (new: title and text, position defaults top-left), deletePanel removes it. All other actions require mapId. Uninitialized project starts with map_1. addMap needs a new mapId and name and sets the spawn when it is the first map. deleteMap cleans incoming goto commands, moves the spawn if necessary and may leave zero maps. Paint or erase signed x/y. Rectangles default to one tile. Paint a continuous floor; blank tiles are not walkable. event creates or patches an eventId with block code. start sets the player. Paint walkable ground under all events and transfers.',
    () => object({actions:{type:'array',minItems:1,maxItems:128,items:action}},['actions']), async ({actions}) => {
      if (!Array.isArray(actions) || !actions.length || actions.length > 128) throw Error('Provide 1–128 game edits.');
      const turn = active();
      turn.plan.observe('rpgGame');
      const game = structuredClone(project().rpgGame ?? createGame());
      let destroys = false;
      const deletedMaps = [];
      for (const a of actions) {
        if (a?.action === 'setMovement') {
          if (!Number.isInteger(a.stepMs)) throw Error('Provide integer stepMs (60–1000).');
          game.walkStepMs = a.stepMs;
          continue;
        }
        if (a?.action === 'panel' || a?.action === 'deletePanel') {
          if (typeof a.panelId !== 'string') throw Error('Provide panelId.');
          const panels = game.panels ??= [];
          const index = panels.findIndex(p => p.id === a.panelId);
          if (a.action === 'deletePanel') {
            if (index < 0) throw Error('Unknown panel: ' + a.panelId);
            panels.splice(index,1);
            destroys = true;
          } else {
            const panel = panels[index] ?? {id:a.panelId,position:'top-left'};
            for (const key of ['title','text','position']) if (a[key] !== undefined) panel[key] = a[key];
            if (index < 0) panels.push(panel);
          }
          continue;
        }
        if (!a || typeof a.mapId !== 'string') throw Error('Provide mapId.');
        if (a.action === 'addMap') {
          if (game.maps.some(m => m.id === a.mapId)) throw Error('Map ID already exists.');
          if (game.maps.length >= 128) throw Error('Map limit reached');
          addRpgMap(game,createMap(a.mapId,a.name,a.width,a.height,a.tile)); continue;
        }
        const map = findMap(game,a.mapId);
        switch (a.action) {
          case 'renameMap': map.name = a.name; break;
          case 'deleteMap': {
            const changes = deleteRpgMap(game,map.id);
            deletedMaps.push({mapId:map.id,...changes});
            destroys = true;
            break;
          }
          case 'start':
            game.start = {mapId:map.id,x:a.x,y:a.y,sprite:a.sprite ?? game.start.sprite};
            placeFloor(map,game.start);
            break;
          case 'paint':
          case 'erase': {
            const erase = a.action === 'erase';
            if (!Number.isInteger(a.x) || !Number.isInteger(a.y) ||
                (!erase && a.tile === undefined && a.blocked === undefined) ||
                (a.tile !== undefined && !inRange(a.tile,rpgAtlas.count)) ||
                (a.blocked !== undefined && typeof a.blocked !== 'boolean')) throw Error('Specify a valid tile or blocked flag and cell.');
            const r = rectangle(a);
            for (let y=r.y; y<r.y+r.height; y++) for (let x=r.x; x<r.x+r.width; x++) {
              setMapCell(map,x,y,erase ? {tile:null,blocked:false} : {tile:a.tile,blocked:a.blocked});
            }
            break;
          }
          case 'event': {
            let event = map.events.find(e => e.id === a.eventId);
            if (!event) { event = {id:a.eventId,trigger:'action',sprite:rpgDefaults.npc,code:''}; map.events.push(event); }
            for (const key of ['name','x','y','trigger','sprite','code']) if (a[key] !== undefined) event[key] = a[key];
            placeFloor(map,event);
            break;
          }
          case 'deleteEvent': {
            const i = map.events.findIndex(e => e.id === a.eventId);
            if (i < 0) throw Error('Unknown event');
            map.events.splice(i,1); destroys = true; break;
          }
          default: throw Error('Unknown game edit.');
        }
      }
      validateGame(game);
      if (destroys && !turn.settings.allowDelete) {
        const detail = deletedMaps.length ? [
          t('Локации','Maps')+' · '+deletedMaps.map(item=>item.mapId).join(', '),
          t('Удаляемые команды перехода','Removed transfer commands')+' · '+deletedMaps.reduce((n,item)=>n+item.removedTransfers,0),
          t('Старт героя','Player spawn')+' · '+(game.start?.mapId ?? '—'),
        ].join('\n') : '';
        if (!await ui.confirm(t('Удалить выбранные элементы игры?', 'Delete the selected game items?'),{danger:true,detail}))
          throw Error(t('Удаление отменено.','Deletion cancelled.'));
      }
      if (turn !== active()) throw Error('Game edit interrupted.');
      const result = stage([{op:'setRpgGame',game}]);
      if (!result.ok) throw Error(result.error);
      return {ok:true,count:actions.length,maps:game.maps.length,...(deletedMaps.length && {deletedMaps})};
    });
}
