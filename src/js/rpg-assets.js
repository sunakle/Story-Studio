// IDs follow the rows of the bundled atlas and are part of the saved project format.
export const rpgAtlas = Object.freeze({
  url: new URL('../assets/rpg/kenney-tiny-rpg.png', import.meta.url).href,
  tileSize: 16,
  columns: 12,
  rows: 23,
  margin: 0,
  spacing: 0,
  count: 276
});

export const rpgDefaults = Object.freeze({
  ground: 0, path: 25, wall: 126, door: 85, hero: 230, npc: 216, water: 264
});

function range(first, last) {
  return Array.from({length: last - first + 1}, (_, offset) => first + offset);
}

export const tileGroups = [
  {id:'terrain', ru:'Трава и тропы', en:'Grass and paths',
    tiles:[0, 1, 2, ...range(12, 14), ...range(24, 26), ...range(36, 43)]},
  {id:'water', ru:'Вода и берега', en:'Water and shores', tiles:range(264, 275)},
  {id:'plants', ru:'Деревья и кусты', en:'Trees and shrubs',
    tiles:[...range(3, 11), ...range(15, 23), ...range(27, 35)]},
  {id:'garden', ru:'Ограды и указатели', en:'Fences and signs',
    tiles:[...range(44, 47), ...range(56, 59), ...range(68, 71), ...range(80, 83), 95]},
  {id:'buildings', ru:'Дома и крыши', en:'Houses and roofs',
    tiles:[...range(48, 55), ...range(60, 67), ...range(72, 79), ...range(84, 92),
      ...range(96, 102), ...range(108, 114), ...range(120, 126)]},
  {id:'dungeon', ru:'Подземелья и полы', en:'Dungeons and floors', tiles:range(132, 191)},
  {id:'props', ru:'Мебель и предметы', en:'Furniture and props',
    tiles:[93, 94, ...range(103, 107), 130, 131, ...range(192, 215), ...range(221, 227)]},
  {id:'actors', ru:'Персонажи и существа', en:'Characters and creatures',
    tiles:[...range(216, 220), ...range(228, 232), ...range(240, 244), ...range(252, 256)]},
  {id:'items', ru:'Инструменты и снаряжение', en:'Tools and gear',
    tiles:[...range(115, 119), ...range(127, 129), ...range(233, 239), ...range(245, 251), ...range(257, 263)]}
];

function validTile(id) {
  return Number.isInteger(id) && id >= 0 && id < rpgAtlas.count;
}

export function drawRpgTile(ctx, image, id, x, y, size = rpgAtlas.tileSize) {
  if (!validTile(id) || !image || !Number.isFinite(size) || size <= 0) return;
  const {columns, tileSize} = rpgAtlas;
  const sx = (id % columns) * tileSize;
  const sy = Math.floor(id / columns) * tileSize;
  ctx.drawImage(image, sx, sy, tileSize, tileSize, x, y, size, size);
}

export function rpgTileStyle(id, size = 24) {
  if (!validTile(id) || !Number.isFinite(size) || size <= 0) return '';
  const {url, columns, rows} = rpgAtlas;
  const x = -(id % columns) * size;
  const y = -Math.floor(id / columns) * size;
  const safeUrl = url.replace(/'/g, '%27').replace(/&/g, '%26');
  return `display:inline-block;width:${size}px;height:${size}px;image-rendering:pixelated;` +
    `background-image:url('${safeUrl}');background-repeat:no-repeat;` +
    `background-position:${x}px ${y}px;background-size:${columns * size}px ${rows * size}px;`;
}

