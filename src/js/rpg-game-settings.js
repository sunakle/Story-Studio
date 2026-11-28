import { t } from './i18n.js';
import { hudLimits, hudPositions, walkTiming } from './rpg-model.js';

export function openGameSettings(settings, apply) {
  const dialog = document.createElement('dialog');
  dialog.className = 'rpg-game-settings';
  dialog.setAttribute('aria-labelledby','rpg-settings-title');
  const add = (parent,tag,text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    parent.append(node);
    return node;
  };
  const form = add(dialog,'form');
  const heading = add(form,'h2',t('Параметры игры','Game settings'));
  heading.id = 'rpg-settings-title';
  function field(parent,caption,tag) {
    const label = add(parent,'label');
    add(label,'span',caption);
    return add(label,tag);
  }
  function button(parent,caption,fn) {
    const node = add(parent,'button',caption);
    node.type = 'button';
    node.onclick = fn;
    return node;
  }
  const duration = field(form,t('Длительность шага героя, мс на клетку','Player step duration, ms per tile'),'input');
  Object.assign(duration,{type:'number',min:walkTiming.min,max:walkTiming.max,step:'1',required:true,name:'stepMs',value:settings.stepMs});
  add(form,'small',t('Чем меньше число, тем быстрее шаг.','Lower values make the player walk faster.'));
  const section = add(form,'section');
  const header = add(section,'header');
  add(header,'h3',t('Игровые панели','In-game panels'));
  const create = button(header,t('Добавить панель','Add panel'),() => {
    addRow({id:'hud_' + crypto.randomUUID().slice(0,8),title:'',text:'',position:'top-left'}).focus();
  });
  add(section,'small',t('Вставьте {имя} в текст, чтобы показать значение переменной события.','Insert {name} in the text to show an event variable.'));
  const list = add(section,'div');
  const rows = new Map();
  const corners = [t('Слева вверху','Top left'),t('Справа вверху','Top right'),t('Слева внизу','Bottom left'),t('Справа внизу','Bottom right')];
  function addRow(panel) {
    const row = add(list,'fieldset');
    row.dataset.panelId = panel.id;
    const title = field(row,t('Заголовок','Title'),'input');
    Object.assign(title,{value:panel.title,maxLength:hudLimits.title,required:true,name:'title'});
    const position = field(row,t('Угол экрана','Screen corner'),'select');
    position.name = 'position';
    hudPositions.forEach((key,i) => { add(position,'option',corners[i]).value = key; });
    position.value = panel.position;
    const body = field(row,t('Текст панели','Panel text'),'textarea');
    Object.assign(body,{value:panel.text,maxLength:hudLimits.text,rows:2,name:'text'});
    button(row,t('Удалить панель','Remove panel'),() => {
      rows.delete(panel.id);
      row.remove();
      create.disabled = false;
      create.focus();
    });
    rows.set(panel.id,() => ({id:panel.id,title:title.value.trim(),text:body.value,position:position.value}));
    create.disabled = rows.size >= hudLimits.count;
    return title;
  }
  settings.panels.forEach(addRow);
  const error = add(form,'output');
  error.setAttribute('role','alert');
  const footer = add(form,'footer');
  button(footer,t('Отмена','Cancel'),() => dialog.close());
  const save = add(footer,'button',t('Применить','Apply'));
  save.type = 'submit';
  form.onsubmit = event => {
    event.preventDefault();
    try {
      apply({stepMs:duration.valueAsNumber,panels:[...rows.values()].map(read => read())});
      dialog.close();
    } catch (err) { error.textContent = err.message; }
  };
  dialog.addEventListener('keydown',event => event.stopPropagation());
  dialog.addEventListener('close',() => dialog.remove(),{once:true});
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
