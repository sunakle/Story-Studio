// Быстрый прогон export.js на синтетическом проекте (проверка лидом).
import { buildExport } from '../src/js/export.js';

const project = {
  schemaVersion: 1,
  meta: { title: 'Проверка экспорта', author: 'Тест', description: 'Проверка экспорта' },
  startNodeId: 'n_start',
  characters: [{ id: 'qa_actor', name: 'Автор', color: '#7c9cff', role: 'Спикер' }],
  locations: [{ id: 'l_wh', name: 'Зона A', atmosphere: 'Параметр' }],
  variables: [{ id: 'v_trust', name: 'counter', type: 'number', initial: 0 }],
  chapters: [{ id: 'ch_prologue', name: 'Пролог' }],
  nodes: [
    {
      id: 'n_start', type: 'line', chapterId: 'ch_prologue', speakerId: 'qa_actor', locationId: 'l_wh',
      text: 'Проверка текста. Кавычка " и апостроф \' тоже.',
      emotion: 'настороженно', next: 'n_choice',
      effects: [{ varId: 'v_trust', op: '+=', value: 1 }],
    },
    {
      id: 'n_choice', type: 'choice', chapterId: 'ch_prologue', text: 'Что делать?',
      choices: [
        { id: 'o_1', text: 'Путь A', next: 'n_cond', condition: 'counter >= 3 && found_key', effects: [{ varId: 'v_trust', op: '+=', value: 1 }] },
        { id: 'o_2', text: 'Уйти', next: 'n_end' },
      ],
      next: 'n_jump',
    },
    { id: 'n_cond', type: 'condition', chapterId: 'ch_prologue', branches: [{ id: 'b_1', condition: 'counter > 5', next: 'n_end' }], next: 'n_scene' },
    { id: 'n_jump', type: 'jump', chapterId: 'ch_prologue', next: 'n_scene' },
    { id: 'n_scene', type: 'scene', chapterId: 'ch_prologue', locationId: 'l_wh', text: 'Проверка сцены.', next: 'n_end' },
    { id: 'n_end', type: 'end', chapterId: 'ch_prologue', text: 'Проверка конца.' },
    { id: 'n_note', type: 'note', text: 'заметка автора' },
    { id: 'n_orphan', type: 'line', text: 'Недостижимая реплика', next: 'n_broken' },
  ],
};

let fails = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`PASS  ${name}`);
  else { fails++; console.log(`FAIL  ${name} ${extra}`); }
};

for (const format of ['godot', 'renpy', 'markdown', 'json', 'clipboard']) {
  let built;
  try {
    built = buildExport(project, format);
  } catch (err) {
    check(`${format}: не падает`, false, err.message);
    continue;
  }
  check(`${format}: есть файлы`, built.files.length > 0);
  check(`${format}: контент непустой`, built.files.every((f) => typeof f.content === 'string' && f.content.length > 20));
  if (format === 'godot') {
    const names = built.files.map((f) => f.name).sort().join(',');
    check('godot: 3 файла', names === 'README.md,dialogue.json,dialogue_runner.gd', names);
    const d = JSON.parse(built.files[0].content);
    check('godot: start', d.start === 'n_start', d.start);
    check('godot: note исключён', !d.nodes.n_note);
    check('godot: битая ссылка помечена', d.nodes.n_orphan && d.nodes.n_orphan.broken === true);
    check('godot: переменные по имени', !!d.variables.counter);
    check('godot: эффект по имени', d.nodes.n_start.effects[0].var === 'counter');
    check('godot: speaker человекочитаемый', d.nodes.n_start.speaker === 'Автор', d.nodes.n_start.speaker);
    check('godot: warnings про битую ссылку', built.warnings.some((w) => w.includes('n_broken')));
    const gd = built.files[1].content;
    check('godot: runner — GDScript класс', gd.includes('class_name DialogueRunner') && gd.includes('func eval_condition'));
    check('godot: runner без ${ (нет подстановок)', !gd.includes('${'));
  }
  if (format === 'renpy') {
    const rpy = built.files[0].content;
    check('renpy: label start', rpy.includes('label start:'));
    check('renpy: Character с кириллицей', rpy.includes('Character("Автор"'));
    check('renpy: default переменной', rpy.includes('default counter = 0'));
    check('renpy: menu', rpy.includes('menu:'));
    check('renpy: условие переведено', rpy.includes('if counter >= 3 and found_key'), rpy.split('\n').find((l) => l.includes('counter >=')));
    check('renpy: кавычка экранирована', rpy.includes('\\"'));
    check('renpy: битая ссылка помечена', rpy.includes('# ОШИБКА'));
  }
  if (format === 'markdown') {
    const md = built.files[0].content;
    check('md: заголовок главы', md.includes('## Пролог'));
    check('md: жирный спикер', md.includes('**АВТОР:**'));
    check('md: конец', md.includes('— КОНЕЦ —'));
    check('md: битая ссылка помечена', md.includes('# ОШИБКА'));
    check('md: недостижимый узел помечен', md.includes('Недостижимый узел'));
  }
}

// пустой проект не должен ронять экспорт
const empty = { schemaVersion: 1, meta: {}, startNodeId: '', characters: [], locations: [], variables: [], chapters: [], nodes: [] };
for (const format of ['godot', 'renpy', 'markdown', 'json']) {
  try {
    buildExport(empty, format);
    check(`пустой проект / ${format}`, true);
  } catch (err) {
    check(`пустой проект / ${format}`, false, err.message);
  }
}

console.log(fails ? `\n${fails} FAIL` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
process.exit(fails ? 1 : 0);
