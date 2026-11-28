'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

const modules = Object.freeze({
  model:['js/rpg-model.js','Map cells, passability, event grammar, validation and state transitions'],
  player:['js/rpg-player.js','Keyboard and pointer input, walking clock, animation, dialogue and HUD rendering'],
  editor:['js/rpg-editor.js','World coordinates, selection, editing, map tools and viewport'],
  blocks:['js/rpg-editor-blocks.js','Transform between event code and visual blocks'],
  settings:['js/rpg-game-settings.js','Authoring controls for walking speed and HUD panels'],
  assets:['js/rpg-assets.js','Tile atlas and character frames'],
  example:['js/rpg-example.js','Example game with key, branching dialogue and two-way doors'],
  tools:['js/ai-rpg-tools.js','Project read/write schemas, edits and validation'],
  inspection:['js/ai-rpg-inspection.js','Read-only simulation, actions and trace'],
  guide:['js/rpg-assistant-guide.js','Assistant operating instructions and context'],
  'player-style':['rpg-player.css','Play window, HUD, controls and dialogue appearance'],
  'editor-style':['rpg-editor.css','Map workspace, canvas and authoring controls'],
});
async function readRpgSource({module, offset = 0, query} = {}) {
  if (!Number.isInteger(offset) || offset < 0) throw Error('offset must be a nonnegative line offset');
  if (query !== undefined && (typeof query !== 'string' || !query.trim() || query.length > 120)) throw Error('Use 1–120 characters for a literal source search.');
  if (!module && !query) return {modules:Object.entries(modules).map(([id,[file,description]])=>({id,file,description}))};
  if (!module) {
    const matches = [];
    let index = 0, size = 0;
    for (const [id,[file]] of Object.entries(modules)) {
      const lines = (await fs.readFile(path.join(__dirname,'..',file),'utf8')).split(/\r?\n/);
      for (let n=0; n<lines.length; n++) {
        const col = lines[n].toLowerCase().indexOf(query.toLowerCase());
        if (col<0 || index++<offset) continue;
        const match = {module:id,line:n+1,text:lines[n].slice(Math.max(0,col-70),col+query.length+90)};
        const length = JSON.stringify(match).length+1;
        if (matches.length && (size+length>4700 || matches.length>=20)) return {matches,nextOffset:index-1};
        matches.push(match);
        size+=length;
      }
    }
    return {matches,nextOffset:null};
  }
  if (typeof module !== 'string' || !Object.hasOwn(modules,module)) throw Error('Choose a module ID from the catalog.');
  const [file] = modules[module];
  const source = await fs.readFile(path.join(__dirname,'..',file),'utf8');
  const lines = source.split(/\r?\n/);
  const result = [];
  let i = offset, size = 0;
  for (; i < lines.length; i++) {
    if (query && !lines[i].toLowerCase().includes(query.toLowerCase())) continue;
    const entry = {line:i+1,text:lines[i]};
    const length = JSON.stringify(entry).length + 1;
    if (result.length && (result.length >= 40 || size + length > 4800)) break;
    result.push(entry);
    size += length;
  }
  return {module,file,totalLines:lines.length,lines:result,nextOffset:i<lines.length?i:null};
}
module.exports = {readRpgSource};
