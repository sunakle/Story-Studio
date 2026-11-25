import { readFileSync, writeFileSync } from 'node:fs';

const file = 'demo/demo-project.json';
const raw = JSON.parse(readFileSync(file, 'utf8'));
const voices = { Аня: { preset: 2, params: {} }, Марк: { preset: 1, params: {} }, Радио: { preset: 3, params: { pitch: 5 } } };
let changed = 0;
for (const ch of raw.characters || []) {
  if (voices[ch.name] && !ch.voice) {
    ch.voice = voices[ch.name];
    changed++;
  }
}
if (!raw.voice) raw.voice = { preset: 0, params: {} };
writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
console.log('голоса выданы персонажам:', changed, '| голос проекта:', JSON.stringify(raw.voice));
console.log('персонажи:', raw.characters.map((c) => `${c.name}:${JSON.stringify(c.voice)}`).join(', '));
