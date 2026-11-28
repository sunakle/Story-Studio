import { advance, createGame, firstWalkableCell, gameSettings, getMapTile, hudText, interact, isMapBlocked, move, startGame } from './rpg-model.js';

const directions = Object.freeze({up:[0,-1],down:[0,1],left:[-1,0],right:[1,0]});
const actionNames = [...Object.keys(directions),'interact','advance','reachEvent'];
const schema = (properties, required = []) => ({type:'object',properties,required,additionalProperties:false});

function panelParts(panels) {
  return panels.flatMap(panel => {
    if (JSON.stringify(panel).length < 4400) return [panel];
    // A repeated placeholder can expand one HUD text beyond a whole tool reply.
    // Even control characters escaped as six JSON characters fit in these chunks.
    const parts = [];
    for (let offset=0; offset<panel.text.length;) {
      let end = Math.min(offset+600,panel.text.length);
      const last = panel.text.charCodeAt(end-1);
      if (end < panel.text.length && last >= 0xD800 && last <= 0xDBFF) end--;
      parts.push({...panel,text:panel.text.slice(offset,end),textOffset:offset,textLength:panel.text.length});
      offset = end;
    }
    return parts;
  });
}

// Breadth-first search on painted terrain. Other events are never traversal cells:
// a touch trigger can transfer the player or run a script before reaching the target.
function routeToEvent(map, state, id, remainingSteps, searchBudget) {
  if (state.dialogue !== null) throw Error('Finish the open dialogue with advance before reachEvent.');
  const target = map.events.find(event => event.id === id);
  if (!target) throw Error('Unknown event "' + id + '" on map "' + map.id + '".');
  const position = (x,y) => x + ',' + y;
  const occupied = new Set(map.events.map(event => position(event.x,event.y)));
  const walls = new Set(map.blocked);
  const start = {x:state.x,y:state.y,depth:0,via:null,parent:null};
  const visited = new Set([position(start.x,start.y)]);
  const queue = [start];
  function route(cell, finalDirection) {
    const path = finalDirection ? [finalDirection] : [];
    for (; cell.parent; cell = cell.parent) path.push(cell.via);
    return path.reverse();
  }
  let best = null;
  for (let cursor=0; cursor<queue.length; cursor++) {
    const cell = queue[cursor];
    if (best && cell.depth >= best.length) break;
    if (--searchBudget.remaining < 0) throw Error('Route search limit reached. Start the test closer to "' + id + '".');
    for (const [direction,[dx,dy]] of Object.entries(directions)) {
      const x = cell.x + dx, y = cell.y + dy;
      if (x === target.x && y === target.y) {
        if (target.trigger === 'touch' && isMapBlocked(map,x,y,walls)) continue;
        const facingTarget = cell.parent ? cell.via === direction : state.facing.dx === dx && state.facing.dy === dy;
        const needsInput = target.trigger === 'touch' || !facingTarget;
        const cost = cell.depth + Number(needsInput);
        if (cost <= remainingSteps && (!best || cost < best.length)) best = route(cell,needsInput ? direction : null);
        continue;
      }
      if (cell.depth >= remainingSteps || best) continue;
      const key = position(x,y);
      if (visited.has(key) || occupied.has(key) || getMapTile(map,x,y) === null || isMapBlocked(map,x,y,walls)) continue;
      visited.add(key);
      queue.push({x,y,depth:cell.depth+1,via:direction,parent:cell});
    }
  }
  if (!best) throw Error('No safe route from (' + state.x + ',' + state.y + ') to "' + id + '" on "' + map.id + '" within ' + remainingSteps + ' remaining actions.');
  return best;
}

export function playtestGame(game, {mapId,x,y,facing,steps=[],detail,offset=0} = {}) {
  const state = startGame(game);
  const map = game.maps.find(m => m.id === (mapId ?? state.mapId));
  if (!map) throw Error('Unknown start map.');
  if ((x === undefined) !== (y === undefined)) throw Error('Supply both x and y.');
  if (x === undefined && map.id !== state.mapId) {
    const cell = firstWalkableCell(map,true) ?? firstWalkableCell(map);
    if (!cell) throw Error('No free starting cell on this map.');
    ({x,y} = cell);
  }
  if (x !== undefined) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || getMapTile(map,x,y) === null || isMapBlocked(map,x,y) ||
        map.events.some(e=>e.x===x && e.y===y && e.trigger==='action')) throw Error('Start must be a free floor cell.');
    Object.assign(state,{mapId:map.id,x,y});
  }
  if (facing !== undefined) {
    if (!Object.hasOwn(directions,facing)) throw Error('Unknown facing direction.');
    const [dx,dy] = directions[facing];
    state.facing = {dx,dy};
  }
  if (!Array.isArray(steps) || steps.length > 64) throw Error('Supply up to 64 actions.');
  const {stepMs,panels} = gameSettings(game);
  const visiblePanels = () => panels.map(p => ({id:p.id,title:p.title,position:p.position,text:hudText(p.text,state.vars)}));
  const initialPanels = visiblePanels();
  const snapshot = () => ({mapId:state.mapId,x:state.x,y:state.y,facing:Object.keys(directions).find(k=>directions[k][0]===state.facing.dx && directions[k][1]===state.facing.dy),dialogue:state.dialogue?.slice(0,500) ?? null});
  const start = snapshot(), trace = [];
  const searchBudget = {remaining:16384};
  function runInput(action) {
      const before = snapshot();
      let blockedBy, eventId;
      const currentMap = game.maps.find(m=>m.id===state.mapId);
      if (action === 'interact') {
        if (state.dialogue===null) {
          eventId=currentMap.events.find(e=>e.trigger==='action' && e.x===state.x+state.facing.dx && e.y===state.y+state.facing.dy)?.id;
        }
        interact(game,state);
      }
      else if (action === 'advance') advance(game,state);
      else {
        const [dx,dy] = directions[action], tx=state.x+dx, ty=state.y+dy;
        const event = currentMap.events.find(e=>e.x===tx && e.y===ty);
        if (state.dialogue!==null) blockedBy='dialogue';
        else if (event?.trigger==='action') { blockedBy='actor'; eventId=event.id; }
        else if (getMapTile(currentMap,tx,ty)===null) blockedBy='empty';
        else if (isMapBlocked(currentMap,tx,ty)) blockedBy='wall';
        else if (event) eventId=event.id;
        move(game,state,dx,dy);
      }
      const current = snapshot();
      trace.push({action,mapId:current.mapId,x:current.x,y:current.y,...(blockedBy && {blockedBy}),...(eventId && {eventId}),
        ...(current.dialogue!==before.dialogue?{dialogue:current.dialogue}: {})});
  }
  for (const step of steps) {
    const count = step?.count ?? 1, action = step?.action;
    if (!actionNames.includes(action) || !Number.isInteger(count) || count < 1)
      throw Error('Use known actions and positive integer counts.');
    if (action === 'reachEvent') {
      if (count !== 1 || typeof step.eventId !== 'string' || !step.eventId) throw Error('reachEvent needs one eventId and count 1.');
      const currentMap = game.maps.find(m => m.id === state.mapId);
      const path = routeToEvent(currentMap,state,step.eventId,64-trace.length,searchBudget);
      for (const direction of path) runInput(direction);
    } else {
      if (trace.length+count > 64) throw Error('Use at most 64 total actions.');
      for (let i=0; i<count; i++) runInput(action);
    }
  }
  const summary = {mode:'isolated model simulation',start,end:snapshot(),stepMs};
  const output = {...summary,trace,variables:{...state.vars},initialPanels,panels:visiblePanels()};
  if (!detail && JSON.stringify(output).length <= 5500) return output;
  const sections = {trace,variables:Object.entries(state.vars),initialPanels,panels:output.panels};
  if (!detail) return {...summary,counts:{trace:trace.length,variables:sections.variables.length,initialPanels:panels.length,panels:panels.length},
    readMore:'Repeat the same test with detail set to trace, variables, initialPanels, or panels and follow nextOffset. Reassemble long HUD text by panel ID and textOffset.'};
  if (!Object.hasOwn(sections,detail) || !Number.isInteger(offset) || offset<0) throw Error('Invalid result section or offset.');
  const entries = detail === 'panels' || detail === 'initialPanels' ? panelParts(sections[detail]) : sections[detail];
  const items = [];
  let i=offset, size=0;
  for (; i<entries.length; i++) {
    const length = JSON.stringify(entries[i]).length+1;
    if (items.length && size+length>4700) break;
    items.push(entries[i]);
    size+=length;
  }
  return {detail,items,total:entries.length,nextOffset:i<entries.length?i:null};
}

export function registerRpgInspection({tool,project,active}) {
  tool('get_engine_reference', () => 'Read the installed RPG engine source. Empty arguments list all modules. A literal query without a module searches the whole engine and returns module IDs and line numbers. For full text or a file search use module, optional query, and zero-based line offset. Returned line numbers are one-based. Use nextOffset for more.',
    () => schema({module:{type:'string'},query:{type:'string',maxLength:120},offset:{type:'integer',minimum:0}}),
    args=>window.sf.rpg.source(args));
  tool('playtest_rpg_game', () => 'Run a fresh isolated playthrough on the staged game. Use reachEvent with eventId to walk a safe route on the current map. Follow with interact for an action NPC/door; a touch event fires on entry. Use advance for dialogue. Chain the whole quest in one call, up to 64 real inputs. The trace records actual directions, collisions, dialogue and transfers. initialPanels and panels show HUD before and after. stepMs measures configured time per tile; rendering and keyboard latency require the Play window.',
    () => schema({mapId:{type:'string'},x:{type:'integer'},y:{type:'integer'},facing:{type:'string',enum:Object.keys(directions)},steps:{type:'array',maxItems:64,items:schema({action:{type:'string',enum:actionNames},eventId:{type:'string',description:'Target on the current map for reachEvent.'},count:{type:'integer',minimum:1,maximum:64}},['action'])},detail:{type:'string',enum:['trace','variables','initialPanels','panels']},offset:{type:'integer',minimum:0}}),
    args=>{active().plan.observe('rpgGame');return playtestGame(project().rpgGame ?? createGame(),args);});
}
