import { t } from './i18n.js';
import { icon } from './icons.js';
import { firstWalkableCell } from './rpg-model.js';

const names = {
  say: ['Реплика', 'Dialogue'], set: ['Задать значение', 'Set variable'],
  if: ['Если', 'If'], goto: ['Переход', 'Transfer'],
};

function valueText(value) {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

export function eventBlocks(blocks, maps, esc, branch = '') {
  const input = (field, value, path, label, type = 'text') =>
    '<input type="'+type+'" data-field="'+field+'" data-path="'+path+'" aria-label="'+label+'" value="'+esc(String(value))+'">';
  const rows = blocks.map((block, i) => {
    const path = branch ? branch + '.' + i : String(i);
    const actions = [['up', t('Выше','Move up'), '↑'], ['down', t('Ниже','Move down'), '↓'], ['remove', t('Удалить блок','Remove block'), '×']]
      .map(([act,label,text]) => '<button type="button" data-block="'+act+'" data-path="'+path+'" title="'+label+'" aria-label="'+label+'" '+
        ((act === 'up' && i === 0 || act === 'down' && i === blocks.length - 1) ? 'disabled' : '')+'>'+text+'</button>').join('');
    let fields = '';
    if (block.op === 'say') fields = input('text', block.text, path, t('Текст реплики','Dialogue text'));
    if (block.op === 'set' || block.op === 'if') {
      fields = input('key', block.key, path, t('Переменная','Variable')) + '<span>'+(block.op === 'if' ? '==' : '=')+'</span>' +
        input('value', valueText(block.value), path, t('Значение','Value'));
    }
    if (block.op === 'goto') {
      fields = '<select data-field="mapId" data-path="'+path+'" aria-label="'+t('Куда перейти','Destination')+'">'+
        maps.map(m=>'<option value="'+esc(m.id)+'" '+(m.id===block.mapId?'selected':'')+'>'+esc(m.name)+'</option>').join('')+
        '</select><label>X '+input('x',block.x,path,'X','number')+'</label><label>Y '+input('y',block.y,path,'Y','number')+'</label>';
    }
    let branches = '';
    if (block.op === 'if') branches = '<div class="rpg-branch"><b>'+t('То','Then')+'</b>'+eventBlocks(block.then,maps,esc,path+'.then')+
      '<b>'+t('Иначе','Else')+'</b>'+eventBlocks(block.else,maps,esc,path+'.else')+'</div>';
    return '<div class="rpg-block kind-'+block.op+'"><div class="rpg-block-head"><strong>'+t(...names[block.op])+'</strong>'+
      '<span class="rpg-block-actions">'+actions+'</span></div><div class="rpg-block-fields">'+fields+'</div>'+branches+'</div>';
  }).join('');
  return rows + '<label class="rpg-add-block">'+icon('plus',12)+'<select data-add="'+branch+'" aria-label="'+t('Добавить блок','Add block')+'">'+
    '<option value="">'+t('Добавить блок','Add block')+'</option>'+Object.entries(names).map(([op,n])=>'<option value="'+op+'">'+t(...n)+'</option>').join('')+'</select></label>';
}

function atPath(root, path) {
  if (!path) return root;
  return path.split('.').reduce((part, key) => part[key], root);
}

export function firstDestination(map) {
  const floor = firstWalkableCell(map);
  if (!floor) throw Error(t('В локации нет свободной клетки.', 'This map has no free cell.'));
  return {mapId:map.id, ...floor};
}

export function changeBlock(blocks, control, map, maps) {
  if (control.hasAttribute('data-add')) {
    const queue = atPath(blocks, control.dataset.add);
    const op = control.value;
    if (!op) return;
    let entry;
    switch (op) {
      case 'say': entry = {op, text:t('Привет!','Hello!')}; break;
      case 'set': entry = {op, key:'has_key', value:true}; break;
      case 'if': entry = {op, key:'has_key', value:true, then:[], else:[]}; break;
      case 'goto': entry = {op, ...firstDestination(map)}; break;
      default: throw Error('Unknown event operation');
    }
    queue.push(entry);
    return;
  }
  const parts = control.dataset.path.split('.');
  const index = Number(parts.pop());
  const list = atPath(blocks, parts.join('.'));
  const item = list[index];
  if (control.dataset.block === 'remove') list.splice(index,1);
  else if (control.dataset.block) {
    const target = index + (control.dataset.block === 'up' ? -1 : 1);
    if (target >= 0 && target < list.length) [list[index],list[target]] = [list[target],list[index]];
  } else {
    const field = control.dataset.field;
    let value = control.value;
    if (field === 'mapId') {
      Object.assign(item, firstDestination(maps.find(m=>m.id===value)));
      return;
    }
    if (field === 'x' || field === 'y') value = control.valueAsNumber;
    if (field === 'value') {
      try { value = JSON.parse(value); } catch { /* ordinary unquoted strings */ }
    }
    item[field] = value;
  }
}
