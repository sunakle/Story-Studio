import fs from 'node:fs';
import path from 'node:path';

// Готовим чистый профиль для пользователя: убираем следы авто-приёмки,
// чтобы первый запуск показал демо-проект, а не файл теста.
// Каталог профиля можно передать аргументом: node tools/_clean-profile.mjs .userdata-test
const dir = process.argv[2] || '.userdata';
const settingsPath = path.join(dir, 'settings.json');
if (fs.existsSync(settingsPath)) {
  const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  s.lastPath = '';
  s.recent = [];
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2), 'utf8');
  console.log('settings.json: lastPath и recent очищены');
}
for (const f of ['autosave.sfproj', 'ai-history.json']) {
  const p = path.join(dir, f);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    console.log('удалён', f);
  }
}
const testProj = path.join('.logs', 'selftest-project.sfproj');
if (fs.existsSync(testProj)) {
  fs.unlinkSync(testProj);
  console.log('удалён .logs/selftest-project.sfproj');
}