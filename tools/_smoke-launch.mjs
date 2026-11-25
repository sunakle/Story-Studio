// tools/_smoke-launch.mjs вЂ” Р·Р°РїСѓСЃРє StoryForge РІ Electron РЅР° N СЃРµРєСѓРЅРґ СЃ РїРµСЂРµС…РІР°С‚РѕРј Р»РѕРіРѕРІ.
// РСЃРїРѕР»СЊР·РѕРІР°РЅРёРµ: node tools/_smoke-launch.mjs [СЃРµРєСѓРЅРґС‹]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const SECONDS = Number(process.argv[2] || 12);
const EXTRA = process.argv.slice(3); // РґРѕРїРѕР»РЅРёС‚РµР»СЊРЅС‹Рµ С„Р»Р°РіРё electron

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // РёРЅР°С‡Рµ electron.exe СЂР°Р±РѕС‚Р°РµС‚ РєР°Рє node
env.ELECTRON_ENABLE_LOGGING = '1';

let out = '';
let err = '';
let exited = null;

const child = spawn(EXE, ['.', ...EXTRA], { cwd: ROOT, env, windowsHide: true });
child.stdout.on('data', (d) => {
  const s = d.toString();
  out += s;
  process.stdout.write(s);
});
child.stderr.on('data', (d) => {
  const s = d.toString();
  err += s;
  process.stderr.write(s);
});
child.on('exit', (code, signal) => {
  exited = { code, signal };
});

await new Promise((r) => setTimeout(r, SECONDS * 1000));

const alive = exited === null;
if (alive) {
  try {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } catch {
    child.kill('SIGKILL');
  }
  await new Promise((r) => setTimeout(r, 800));
}

mkdirSync(HERE, { recursive: true });
writeFileSync(join(HERE, '_smoke.out.log'), out, 'utf8');
writeFileSync(join(HERE, '_smoke.err.log'), err, 'utf8');

const noise = /\[\d+:\d+:ERROR:.*\.(cc|mm)\(\d+\)\]/;
const bad = (err + out)
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .filter((l) => !noise.test(l))
  .filter((l) => /Uncaught|Failed to load|Cannot find module|ReferenceError|TypeError|SyntaxError|is not a function|ERR_FILE|ERR_|Unhandled/i.test(l));

console.log('\n=== РРўРћР“ ===');
console.log(`alive_after_${SECONDS}s: ${alive}`);
console.log(`exit: ${exited ? JSON.stringify(exited) : 'РµС‰С‘ СЂР°Р±РѕС‚Р°Р», СѓР±РёС‚'}`);
console.log(`stderr_lines: ${err.split(/\r?\n/).filter(Boolean).length}, stdout_lines: ${out.split(/\r?\n/).filter(Boolean).length}`);
if (bad.length) {
  console.log(`РџРћР”РћР—Р РРўР•Р›Р¬РќР«Р• РЎРўР РћРљР (${bad.length}):`);
  for (const l of bad.slice(0, 40)) console.log('  ' + l);
  process.exit(1);
}
console.log('РљСЂСЌС€-РїРѕРґРѕР±РЅС‹С… СЃС‚СЂРѕРє РЅРµС‚.');