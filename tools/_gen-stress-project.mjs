// Генератор большого тестового проекта: разветвлённый сюжет с множеством сущностей,
// чтобы «Обзор сюжета» показал плотное облако из сотен точек.
// Структура: главы идут подряд; в каждой главе позвоночник из реплик,
// на нём 3 точки выбора, каждый вариант — своя ветка из 3 реплик, все ветки сходятся обратно.
import { writeFileSync } from 'node:fs';
import { autoLayout, validateProject, computeStats } from '../src/js/model.js';

const project = {
  schemaVersion: 2,
  meta: {
    title: 'Смена в сто этажей',
    author: 'Стресс-тест',
    description: 'Большой ветвящийся сюжет для проверки облака связей.',
  },
  startNodeId: '',
  characters: [],
  locations: [],
  variables: [],
  chapters: [],
  nodes: [],
  voice: { preset: 1, params: {} },
  media: {},
};

const chapterDefs = [
  ['ch_01', 'Лифт', '#7c9cff'],
  ['ch_02', 'Серверная', '#8fd6a6'],
  ['ch_03', 'Архив', '#f2a65a'],
  ['ch_04', 'Крыша', '#c39bff'],
  ['ch_05', 'Свет', '#e0c07a'],
];

const characterDefs = [
  ['c_anya', 'Аня', '#7c9cff', 'оператор лифта'],
  ['c_mark', 'Марк', '#8fd6a6', 'системный администратор'],
  ['c_radio', 'Радио', '#f2a65a', 'голос в наушниках'],
  ['c_vera', 'Вера', '#c39bff', 'начальница смены'],
  ['c_oleg', 'Олег', '#e0c07a', 'охранник у турникета'],
  ['c_timur', 'Тимур', '#79b8d8', 'инженер по лифтам'],
  ['c_nina', 'Нина', '#d88f8f', 'дежурная по этажу'],
  ['c_echo', 'Эхо', '#9aa5b4', 'запись на автоответчике'],
];

const locationDefs = [
  ['l_lift', 'Лифтовой холл'],
  ['l_server', 'Серверная на сороковом'],
  ['l_archive', 'Архив под крышей'],
  ['l_roof', 'Крыша'],
  ['l_stairs', 'Лестница Б'],
  ['l_guard', 'Пост охраны'],
];

const variableDefs = [
  ['v_trust', 'Доверие Марка', 'number', '2'],
  ['v_keys', 'Ключи от архива', 'bool', 'false'],
  ['v_signal', 'Сигнал на крыше', 'number', '0'],
  ['v_battery', 'Заряд фонаря', 'number', '62'],
  ['v_code', 'Код лифта', 'string', ''],
  ['v_note', 'Записка Нины', 'bool', 'false'],
  ['v_shift', 'Часов в смене', 'number', '4'],
  ['v_rumor', 'Слух о девятом этаже', 'bool', 'false'],
  ['v_radio', 'Радио включено', 'bool', 'true'],
  ['v_alarm', 'Тревога', 'bool', 'false'],
];

for (const [id, name, color] of chapterDefs) project.chapters.push({ id, name, color, collapsed: false });
for (const [id, name, color, role] of characterDefs) {
  project.characters.push({
    id,
    name,
    color,
    role,
    age: '30',
    description: '',
    appearance: '',
    personality: '',
    speech: '',
    notes: '',
    tags: ['стресс'],
    voice: { preset: 1, params: {} },
  });
}
for (const [id, name] of locationDefs) project.locations.push({ id, name, description: '', notes: '', tags: ['стресс'] });
for (const [id, name, kind, initial] of variableDefs) {
  project.variables.push({ id, name, kind, initial, notes: '', tags: ['стресс'] });
}

const chars = characterDefs.map(([id]) => id);
const locs = locationDefs.map(([id]) => id);
const vars = variableDefs.map(([id]) => id);

let counter = 0;
const nextId = (prefix) => `${prefix}_${(counter += 1).toString(36)}`;

function makeNode(type, chapterId, patch = {}) {
  const node = {
    id: nextId('n'),
    type,
    chapterId,
    title: '',
    speakerId: '',
    locationId: '',
    text: '',
    emotion: '',
    next: '',
    choices: [],
    branches: [],
    effects: [],
    tags: ['стресс'],
    notes: '',
    color: '',
    position: { x: 0, y: 0 },
  };
  Object.assign(node, patch);
  project.nodes.push(node);
  return node;
}

const lineTexts = [
  'Лифт останавливается между этажами и не собирается ехать дальше.',
  'В наушнике шуршит радио: кто-то дышит в открытый канал.',
  'На полу мелом обведён след человеческого шага.',
  'Марк говорит вполголоса, чтобы не разбудить пустой этаж.',
  'Фонарь мигает: заряд падает быстрее, чем должен.',
  'За дверью архива слышно, как перекладывают папки.',
  'Вера смотрит на часы так, будто они — её личный враг.',
  'На крыше ветер выносит слова в разные стороны.',
  'Код от лифта написан на обратной стороне пропуска.',
  'Тимур стучит по панели: «Они все так делают перед сменой».',
  'Нина оставляет записку под клавиатурой — если успеет.',
  'Олег делает вид, что турникет его не касается.',
];

let seed = 7;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = (list) => list[Math.floor(rand() * list.length)];

const optionLabels = [
  'Нажать кнопку вызова',
  'Спуститься по лестнице',
  'Позвать Марка',
  'Проверить журнал',
  'Взять ключи в посту',
  'Подняться на крышу',
  'Промолчать в рацию',
  'Открыть чужую дверь',
];

const spine = [];
const chapterEntries = [];
const chapterExits = [];

chapterDefs.forEach(([chapterId, chapterName], chapterIndex) => {
  const location = locs[chapterIndex % locs.length];
  const entry = makeNode('scene', chapterId, {
    title: `Глава ${chapterIndex + 1}: ${chapterName}`,
    locationId: location,
    text: `Смена идёт, этаж ${(chapterIndex + 1) * 8}. ${chapterName}.`,
  });
  chapterEntries.push(entry);

  const start = makeNode('line', chapterId, {
    title: `${chapterIndex + 1}.1`,
    speakerId: chars[chapterIndex % chars.length],
    locationId: location,
    text: lineTexts[(chapterIndex * 3) % lineTexts.length],
  });

  // позвоночник: 8 реплик подряд
  const chain = [start];
  for (let step = 1; step < 8; step += 1) {
    const prev = chain[chain.length - 1];
    const node = makeNode('line', chapterId, {
      title: `${chapterIndex + 1}.${step + 1}`,
      speakerId: pick(chars),
      locationId: pick(locs),
      text: lineTexts[(chapterIndex * 5 + step * 2) % lineTexts.length],
      emotion: step % 2 ? 'сухо' : 'настороженно',
      effects: step % 3 === 0 ? [{ varId: pick(vars), op: '+=', value: '1' }] : [],
    });
    prev.next = node.id;
    chain.push(node);
  }

  entry.next = start.id;

  // три точки выбора: между репликами 2→3, 5→6, 7→8
  for (const [choiceNo, gapIndex] of [1, 4, 6].entries()) {
    const before = chain[gapIndex];
    const after = chain[gapIndex + 1];
    const choiceNode = makeNode('choice', chapterId, {
      title: `${chapterIndex + 1}.${gapIndex + 1} — решение ${choiceNo + 1}`,
      speakerId: pick(chars),
      locationId: pick(locs),
      text: 'Нужно решить, что делать прямо сейчас.',
    });
    before.next = choiceNode.id;
    connectionPoint(chapterId, choiceNode, after.id, chapterIndex, choiceNo);
  }

  const note = makeNode('note', chapterId, {
    title: `Заметка: ${chapterName}`,
    text: 'Проверить, что все ветки сходятся обратно в позвоночник.',
  });
  chapterExits.push({ node: chain[chain.length - 1], note });
});

function connectionPoint(chapterId, choiceNode, mergeId, chapterIndex, choiceNo) {
  const count = 3;
  for (let optionIndex = 0; optionIndex < count; optionIndex += 1) {
    const label = optionLabels[(chapterIndex * 3 + choiceNo * 3 + optionIndex) % optionLabels.length];
    const branchChain = [];
    for (let step = 0; step < 3; step += 1) {
      const node = makeNode('line', chapterId, {
        title: `${label} · ${step + 1}`,
        speakerId: pick(chars),
        locationId: pick(locs),
        text: `${label}: ${lineTexts[(chapterIndex + choiceNo + step * 3) % lineTexts.length]}`,
        effects: step === 0 ? [{ varId: pick(vars), op: '+=', value: String(optionIndex + 1) }] : [],
      });
      branchChain.push(node);
    }
    for (let i = 0; i < branchChain.length - 1; i += 1) branchChain[i].next = branchChain[i + 1].id;
    branchChain[branchChain.length - 1].next = mergeId;

    const varId = step_var(chapterIndex, choiceNo, optionIndex);
    choiceNode.choices.push({
      id: `o_${counter + 1}_${optionIndex}`,
      text: label,
      next: branchChain[0].id,
      condition: optionIndex === 0 ? '' : `${varId} ${optionIndex === 1 ? '>= 2' : '< 100'}`,
      effects: [],
      hint: '',
    });
    counter += 1;
  }
}

function step_var(chapterIndex, choiceNo, optionIndex) {
  return vars[(chapterIndex + choiceNo + optionIndex) % vars.length];
}

// финал
const ending = makeNode('end', chapterDefs[chapterDefs.length - 1][0], {
  title: 'Конец сюжета',
  text: 'Смена закончилась так, как не начиналась.',
});
chapterExits.forEach(({ node, note }, index) => {
  const nextEntry = chapterEntries[index + 1];
  if (nextEntry) {
    node.next = nextEntry.id;
    note.next = nextEntry.id;
  } else {
    node.next = ending.id;
    note.next = ending.id;
  }
});

project.startNodeId = chapterEntries[0].id;

autoLayout(project);

const stats = computeStats(project);
const issues = validateProject(project);
const errors = issues.filter((i) => i.severity === 'error');
const warnings = issues.filter((i) => i.severity === 'warning');

writeFileSync('demo/stress-overview.sfproj', JSON.stringify(project, null, 2), 'utf8');

console.log('узлов:', project.nodes.length);
console.log(
  'персонажей:',
  project.characters.length,
  'локаций:',
  project.locations.length,
  'переменных:',
  project.variables.length,
  'глав:',
  project.chapters.length,
);
console.log('слов:', stats.words, 'выборов:', stats.choices);
console.log('ошибок:', errors.length, 'предупреждений:', warnings.length);
for (const issue of issues.slice(0, 10)) console.log(' •', issue.severity, issue.code, issue.message || '');