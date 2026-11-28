import { createGame, createMap, getMapBounds, getMapTile, isMapBlocked, setMapCell, validateGame, validMapCoordinate } from './rpg-model.js';
import { rpgAtlas, rpgDefaults, tileGroups } from './rpg-assets.js';
import { t } from './i18n.js';

const str = description => ({type:'string',description});
const int = description => ({type:'integer',description});
const object = (properties, required = []) => ({type:'object',properties,required,additionalProperties:false});
const id = str('Stable identifier. Use a short letter-led name with underscores.');
const coord = int('Signed world tile coordinate on the open canvas.');
const tile = int('Tile ID from the included atlas.');
const action = object({
  action:{type:'string',enum:['addMap','renameMap','deleteMap','paint','erase','start','event','deleteEvent']},
  mapId:id,eventId:id,name:str('Display name'),width:int('Paint rectangle or initial filled patch width'),height:int('Paint rectangle or initial filled patch height'),
  x:coord,y:coord,tile,blocked:{type:'boolean'},sprite:tile,trigger:{enum:['action','touch'],type:'string'},
  code:str('Complete event source. One command per line: say "Hi"; set key = true; if key == true / else / end; goto map_id 1 2.')
},['action','mapId']);
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
export function registerRpgTools({tool,project,active,stage,ui}) {
  tool('get_rpg_game', () => 'Read maps, player spawn, events, event code, tile rectangles or palette. Use the palette for tile and sprite IDs. The player moves one tile per step. Compatible sprite sheets supply automatic directional walk frames. Projects have no controls for movement speed, acceleration or animation timing. Explain these limits directly. Coordinates may be negative; null tiles are empty. Map bounds describe existing content. Event code offsets are characters.',
    () => object({view:{type:'string',enum:['maps','events','code','tiles','palette']},mapId:id,eventId:id,offset:int('Pagination offset'),x:coord,y:coord,width:int('Up to 16'),height:int('Up to 16')}), a => {
      active().plan.observe('rpgGame');
      if (a.view === 'palette') return {count:rpgAtlas.visibleCount,defaults:rpgDefaults,groups:tileGroups.map(g => ({name:g.en,tiles:g.tiles}))};
      const game = project().rpgGame;
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
  tool('edit_rpg_game', () => 'Edit the free game canvas in one transaction. Uninitialized project starts with map_1. addMap needs a new mapId and name. Paint or erase at signed x/y anywhere, including beyond existing content. Rectangles default to one tile. Paint a continuous floor for paths; blank tiles are not walkable. event creates or patches an eventId with shared block code. start sets the player. Draw walkable ground under all event and transfer destinations.',
    () => object({actions:{type:'array',minItems:1,maxItems:128,items:action}},['actions']), async ({actions}) => {
      if (!Array.isArray(actions) || !actions.length || actions.length > 128) throw Error('Provide 1–128 game edits.');
      const turn = active();
      turn.plan.observe('rpgGame');
      const game = structuredClone(project().rpgGame ?? createGame());
      let destroys = false;
      for (const a of actions) {
        if (!a || typeof a.mapId !== 'string') throw Error('Provide mapId.');
        if (a.action === 'addMap') {
          if (game.maps.some(m => m.id === a.mapId)) throw Error('Map ID already exists.');
          if (game.maps.length >= 128) throw Error('Map limit reached');
          game.maps.push(createMap(a.mapId,a.name,a.width,a.height,a.tile)); continue;
        }
        const map = findMap(game,a.mapId);
        switch (a.action) {
          case 'renameMap': map.name = a.name; break;
          case 'deleteMap': game.maps.splice(game.maps.indexOf(map),1); destroys = true; break;
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
      if (destroys && !turn.settings.allowDelete && !await ui.confirm(t('Удалить выбранные локации или события?', 'Delete the chosen maps or events?'),{danger:true})) throw Error(t('Удаление отменено.','Deletion cancelled.'));
      if (turn !== active()) throw Error('Game edit interrupted.');
      const result = stage([{op:'setRpgGame',game}]);
      if (!result.ok) throw Error(result.error);
      return {ok:true,count:actions.length,maps:game.maps.length};
    });
}
