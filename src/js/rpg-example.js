import { createMap, formatEvent, validateGame } from './rpg-model.js';
import { rpgDefaults as art } from './rpg-assets.js';
import { t } from './i18n.js';

export function createRpgExample() {
  const yard = createMap('garden', t('Сад у мастерской', 'Workshop garden'), 16, 12, art.ground);
  const room = createMap('workshop', t('Мастерская', 'Workshop'), 12, 9, 180);
  function row(map, x, y, tiles, solid = false) {
    tiles.forEach((id, dx) => {
      const i = y * map.width + x + dx;
      map.tiles[i] = id;
      if (solid) map.blocked.push(i);
    });
  }

  // A fenced orchard with the footpath leading east to the workshop.
  row(yard, 0, 0, [5, 4, 44, 45, 45, 46, 3, 4, 44, 45, 45, 45, 46, 5, 4, 5], true);
  row(yard, 0, 11, [5, 4, 5, 44, 45, 45, 46, 3, 5, 44, 45, 45, 46, 4, 5, 4], true);
  for (let y = 1; y <= 10; y++) {
    row(yard, 0, y, [y % 4 === 1 ? 4 : 56], true);
    row(yard, 15, y, [y % 3 === 0 ? 5 : 56], true);
  }
  row(yard, 1, 2, [265, 266, 266, 267], true);
  row(yard, 1, 3, [268, 275, 264, 269], true);
  row(yard, 1, 4, [270, 271, 271, 272], true);

  row(yard, 8, 2, [52, 53, 53, 55, 54], true);
  row(yard, 8, 3, [64, 65, 65, 67, 66], true);
  row(yard, 8, 4, [72, 73, 73, 73, 75], true);
  row(yard, 8, 5, [84, 73, art.door, 73, 84], true);
  row(yard, 3, 6, [12, 13, 13, 13, 13, 13, 13, 25, 13, 14]);
  row(yard, 3, 7, [36, 37, 37, 37, 37, 37, 37, 37, 37, 38]);
  row(yard, 5, 1, [2, 1]);
  row(yard, 6, 3, [5], true);
  row(yard, 13, 2, [106], true);
  row(yard, 7, 5, [83], true);
  row(yard, 13, 5, [104], true);
  row(yard, 1, 7, [29]);
  row(yard, 1, 8, [4, 5], true);
  row(yard, 2, 9, [4], true);
  row(yard, 4, 9, [2, 1, 2]);
  row(yard, 7, 10, [29, 1]);
  row(yard, 9, 9, [44, 45, 46], true);
  row(yard, 13, 8, [3], true);
  row(yard, 12, 9, [2]);
  row(yard, 13, 9, [5], true);

  // Stone walls, a pair of bookcases, a carved fountain, and a worn floor.
  row(room, 0, 0, [136, 137, 146, 136, 137, 161, 136, 137, 146, 136, 137, 146], true);
  row(room, 0, 8, Array(12).fill(172), true);
  for (let y = 1; y <= 7; y++) {
    row(room, 0, y, [189], true);
    row(room, 11, y, [191], true);
  }
  row(room, 1, 1, [207, 207], true);
  row(room, 7, 1, [139, 140, 139], true);
  row(room, 7, 2, [151, 152, 151], true);
  row(room, 7, 3, [163, 164, 163], true);
  row(room, 1, 3, [174, 174], true);
  row(room, 3, 3, [181]);
  row(room, 5, 4, [174, 174]);
  row(room, 3, 6, [181]);
  row(room, 9, 5, [181]);
  const say = (ru, en) => ({op:'say', text:t(ru, en)});
  const warp = (mapId, x, y) => ({op:'goto',mapId,x,y});
  const branch = (yes, no) => ({op:'if',key:'has_key',value:true,then:yes,else:no});
  yard.events.push({
    id:'keeper', name:t('Смотритель', 'Caretaker'), x:5, y:5, sprite:art.npc, trigger:'action',
    code:formatEvent([branch([say('Ключ уже у тебя. Дверь в конце дорожки.', 'You have the key. Follow the path to the door.')],
      [say('Хочешь посмотреть мастерскую? Держи ключ.', 'Want to see the workshop? Take this key.'),{op:'set',key:'has_key',value:true}])])
  },{
    id:'locked_door', name:t('Дверь в мастерскую', 'Workshop door'), x:10, y:5, sprite:art.door, trigger:'action',
    code:formatEvent([branch([warp(room.id, 5, 6)], [say('Заперто. Ключ у смотрителя в саду.', 'Locked. The garden caretaker has the key.')])])
  });
  room.events.push({id:'exit',name:t('Выход в сад','Garden exit'),x:5,y:7,sprite:art.door,trigger:'touch',
    code:formatEvent([warp(yard.id,10,6)])});
  return validateGame({version:1,maps:[yard,room],start:{mapId:yard.id,x:5,y:6,sprite:art.hero}});
}
