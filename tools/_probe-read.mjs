import { readFileSync, existsSync } from 'node:fs';

const p = '.logs/selftest.json';
if (!existsSync(p)) {
  console.log('нет selftest.json');
  process.exit(0);
}
const data = JSON.parse(readFileSync(p, 'utf8'));
console.log('ИТОГ:', JSON.stringify(data.summary));
console.log('jsErrors:', (data.jsErrors || []).length);
if (data.failed && data.failed.length) {
  console.log('--- провалы ---');
  data.failed.forEach((f) => console.log(' •', f));
}
const studio = (data.checks || []).filter((c) => /студия|озвучка/i.test(c.name));
console.log('--- студия/озвучка ---');
studio.forEach((c) => console.log(` ${c.ok ? 'OK  ' : 'FAIL'} ${c.name} — ${c.info || ''}`));
