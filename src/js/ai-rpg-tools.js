import { createGame, createMap, validateGame } from './rpg-model.js';
import { rpgAtlas, rpgDefaults, tileGroups } from './rpg-assets.js';
import { t } from './i18n.js';

const str = description => ({type:'string',description});
const int = description => ({type:'integer',description});
const object = (properties, required = []) => ({type:'object',properties,required,additionalProperties:false});
const id = str('Stable identifier. Use a short letter-led name with underscores.');
const coord = int('Zero-based tile coordinate.');
const tile = int('Tile ID from the included atlas.');
const action = object({
  action:{type:'string',enum:['addMap','renameMap','deleteMap','paint','start','event','deleteEvent']},
  mapId:id,eventId:id,name:str('Display name'),width:int('Map or rectangle width in tiles'),height:int('Map or rectangle height in tiles'),
  x:coord,y:coord,tile,blocked:{type:'boolean'},sprite:tile,trigger:{enum:['action','touch'],type:'string'},
  code:str('Complete event source. One command per line: say "Hi"; set key = true; if key == true / else / end; goto map_id 1 2.')
},['action','mapId']);
const inRange = (v,max) => Number.isInteger(v) && v >= 0 && v < max;
function findMap(game, mapId) {
  const map = game.maps.find(m => m.id === mapId);
  if (!map) throw Error('Unknown map: ' + mapId);
  return map;
}
function rectangle(map, a, maxSide = 128) {
  const {x=0,y=0,width=1,height=1} = a;
  if (!inRange(x,map.width) || !inRange(y,map.height) ||
      !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > maxSide || height > maxSide || x + width > map.width || y + height > map.height) throw Error('Rectangle outside the map or too large.');
  return {x,y,width,height};
}
function paged(list, offset, limit) {
  if (!Number.isInteger(offset) || offset < 0) throw Error('Invalid offset');
  return {items:list.slice(offset,offset+limit),total:list.length,nextOffset:offset+limit<list.length?offset+limit:null};
}
export function registerRpgTools({tool,project,active,stage,ui}) {
  tool('get_rpg_game', () => 'Read top-down game maps/start, events, event source, tile rectangles or tile palette. Read before editing. Event source offsets are characters.',
    () => object({view:{type:'string',enum:['maps','events','code','tiles','palette']},mapId:id,eventId:id,offset:int('Pagination offset'),x:coord,y:coord,width:int('Up to 16'),height:int('Up to 16')}), a => {
      active().plan.observe('rpgGame');
      if (a.view === 'palette') return {count:rpgAtlas.count,defaults:rpgDefaults,groups:tileGroups.map(g => ({name:g.en,tiles:g.tiles}))};
      const game = project().rpgGame;
      if (!game) return {initialized:false,initialMapId:'map_1',defaults:rpgDefaults};
      const offset = a.offset ?? 0;
      if (!a.view || a.view === 'maps') return {start:game.start, ...paged(game.maps.map(m => ({id:m.id,name:m.name,width:m.width,height:m.height,events:m.events.length})),offset,15)};
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
      const rect = rectangle(map,a,16), rows = [], blocked = [];
      const walls = new Set(map.blocked);
      for (let y=rect.y; y<rect.y+rect.height; y++) {
        const i=y*map.width+rect.x;
        rows.push(map.tiles.slice(i,i+rect.width));
        for (let x=rect.x; x<rect.x+rect.width; x++) if (walls.has(y*map.width+x)) blocked.push([x,y]);
      }
      return {...rect,rows,blocked};
    });
  tool('edit_rpg_game', () => 'Edit the game engine in one transaction. Uninitialized project starts with map_1. addMap needs a new mapId and name. paint needs x/y and tile and/or blocked; width/height default 1. event creates or patches by eventId, accepts event code in the shared block language. start sets the player. All goto positions and the player start must be walkable after the batch.',
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
            break;
          case 'paint': {
            if (!Number.isInteger(a.x) || !Number.isInteger(a.y) ||
                (a.tile === undefined && a.blocked === undefined) ||
                (a.tile !== undefined && !inRange(a.tile,rpgAtlas.count)) ||
                (a.blocked !== undefined && typeof a.blocked !== 'boolean')) throw Error('Specify a valid tile or blocked flag and cell.');
            const r = rectangle(map,a), walls = new Set(map.blocked);
            for (let y=r.y; y<r.y+r.height; y++) for (let x=r.x; x<r.x+r.width; x++) {
              const i = y*map.width+x;
              if (a.tile !== undefined) map.tiles[i] = a.tile;
              if (a.blocked === true) walls.add(i);
              if (a.blocked === false) walls.delete(i);
            }
            if (a.blocked !== undefined) map.blocked = [...walls];
            break;
          }
          case 'event': {
            let event = map.events.find(e => e.id === a.eventId);
            if (!event) { event = {id:a.eventId,trigger:'action',sprite:rpgDefaults.npc,code:''}; map.events.push(event); }
            for (const key of ['name','x','y','trigger','sprite','code']) if (a[key] !== undefined) event[key] = a[key];
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
