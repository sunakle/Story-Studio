// Быстрая проверка демо-проекта: миграция, валидация, статистика, раскладка.
// Запуск: node tools/_check-demo.mjs
import { readFileSync } from 'node:fs';
import * as M from '../src/js/model.js';

const raw = JSON.parse(readFileSync(new URL('../demo/demo-project.json', import.meta.url), 'utf8'));

const { project, warnings } = M.migrateProject(raw);
console.log('миграция: предупреждений', warnings.length, warnings.join(' | '));

const issues = M.validateProject(project);
const errors = issues.filter((i) => i.severity === 'error');
const warns = issues.filter((i) => i.severity === 'warning');
const hints = issues.filter((i) => i.severity === 'hint');
console.log(`валидация: ${errors.length} ошибок / ${warns.length} предупреждений / ${hints.length} подсказок`);
for (const i of issues) console.log(`  ${i.severity} ${i.code}: ${i.message}`);

const stats = M.computeStats(project);
console.log('статистика:', JSON.stringify({
  nodes: stats.nodes, lines: stats.lines, words: stats.words, chars: stats.chars,
  choices: stats.choices, endings: stats.endings, notes: stats.notes, minutes: stats.minutes,
  longestChain: stats.longestChain, unreachable: stats.unreachable,
  byType: stats.byType,
  bySpeaker: stats.bySpeaker.map((s) => `${s.name}:${s.lines}/${s.words}`).join(', '),
  byLocation: stats.byLocation.map((l) => `${l.name}:${l.scenes}/${l.words}`).join(', '),
  chapters: stats.chapters.map((c) => `${c.name}:${c.nodes}/${c.words}`).join(', '),
}));

const layout = M.autoLayout(project);
console.log('автораскладка: узлов', Object.keys(layout.positions).length);

const byId = new Map(project.nodes.map((n) => [n.id, n]));
let pathGood = M.findPath(project, 'n_start', 'n_end_good');
let pathBad = M.findPath(project, 'n_start', 'n_end_bad');
console.log('путь до хорошей концовки:', pathGood && pathGood.join(' → '));
console.log('путь до плохой концовки:', pathBad && pathBad.join(' → '));
console.log('спикеры:', ['n_start', 'n_radio', 'n_joke', 'n_find'].map((id) => M.nodeSpeakerName(project, byId.get(id))).join(', '));
console.log('локации:', ['n_start', 'n_scene_cor'].map((id) => M.nodeLocationName(project, byId.get(id))).join(', '));

// Условие доверия: симуляция честного пути (o_honest +2, o_key +1 → trust_mark = 3).
const p = { trust_mark: 0, found_key: false };
for (const e of project.nodes.find((n) => n.id === 'n_choice1').choices.find((c) => c.id === 'o_honest').effects) {
  if (e.op === '+=') p[e.varId === 'v_trust_mark' ? 'trust_mark' : 'var'] += e.value;
}
for (const e of project.nodes.find((n) => n.id === 'n_choice2').choices.find((c) => c.id === 'o_key').effects) {
  if (e.op === '+=') p['trust_mark'] += e.value;
}
const cond = M.parseCondition('trust_mark >= 3');
console.log('parseCondition(trust_mark >= 3):', JSON.stringify(cond), '· симуляция честного пути trust_mark =', p.trust_mark);

const ok = errors.length === 0 && warns.length === 0;
console.log(ok ? 'ИТОГ: демо-проект валиден (0 ошибок, 0 предупреждений)' : 'ИТОГ: ЕСТЬ ПРОБЛЕМЫ — см. выше');
process.exit(ok ? 0 : 1);
