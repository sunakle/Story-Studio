// tools/_prime-ai-e2e.mjs — сквозная проверка AI-цикла приёмки (критерий 15/14)
// через реальное приложение в Electron и мок-сервер tools/mock-ai-server.mjs.
//
// Что делает:
//   1. сеет .userdata-prime/settings.json (AI -> мок-сервер 127.0.0.1:8799,
//      extraHeaders {"x-mock-script":"e2e"} включает сценарную ветку мока);
//   2. поднимает мок-сервер дочерним процессом;
//   3. запускает StoryForge: electron . --no-sandbox --user-data-dir=.userdata-prime
//      --remote-debugging-port=9223 (свой профиль — single-instance lock не задеваем);
//   4. через DevTools-протокол (WebSocket) рулит живым UI:
//      «Проверить подключение», отправка сообщения, ожидание конца цикла;
//   5. проверяет изменения модели (персонаж, +3 узла, tool-трейсы, текст),
//      отменяет ВЕСЬ ход AI одним Ctrl+Z, переключает тему;
//   6. пишет .logs/prime-ai-e2e.json, убивает electron и мок.
// Выход: 0 — все шаги ок, 1 — есть провалы.

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PROFILE = join(ROOT, '.userdata-prime');
const MOCK_PORT = 8799;
const DEBUG_PORT = 9223;
const CHAR_NAME = 'Тестовый Персонаж';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[e2e]', ...a);

// ---------------------------------------------------------------- 1. профиль
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
writeFileSync(
  join(PROFILE, 'settings.json'),
  JSON.stringify({
    theme: 'dark',
    ai: {
      preset: 'openai',
      baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
      apiKey: 'mock-key',
      model: 'mock-model',
      temperature: 0.4,
      maxTokens: 4096,
      extraHeaders: '{"x-mock-script":"e2e"}',
      allowDelete: true,
      showTools: true,
    },
  }, null, 2),
  'utf8'
);
log('profile seeded:', join(PROFILE, 'settings.json'));

// ---------------------------------------------------------------- 2. мок-сервер
const mock = spawn(process.execPath, [join(HERE, 'mock-ai-server.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
mock.stdout.on('data', (d) => process.stdout.write(`[mock] ${d}`));
mock.stderr.on('data', (d) => process.stderr.write(`[mock!] ${d}`));

const mockReady = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/models`);
      if (r.ok) return true;
    } catch { /* ещё не поднялся */ }
    await sleep(250);
  }
  return false;
};
if (!(await mockReady())) {
  console.error('мок-сервер не поднялся');
  mock.kill();
  process.exit(1);
}
log('mock server ready on', MOCK_PORT);

// ---------------------------------------------------------------- 3. electron
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.ELECTRON_ENABLE_LOGGING = '1';
const app = spawn(EXE, ['.', '--no-sandbox', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${DEBUG_PORT}`], { cwd: ROOT, env, windowsHide: true });
let electronOut = '';
app.stdout.on('data', (d) => { electronOut += d.toString(); });
app.stderr.on('data', (d) => { electronOut += d.toString(); });

const results = { checks: [], jsErrors: null };
const check = (name, ok, detail) => {
  results.checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  [' + String(detail) + ']' : ''}`);
};

// ---------------------------------------------------------------- 4. CDP
let ws = null;
let msgId = 0;
const pending = new Map();

const findPage = async () => {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const targets = await r.json();
      const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url || ''));
      if (page) return page;
    } catch { /* приложение ещё стартует */ }
    await sleep(500);
  }
  return null;
};

const ev = (expression) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
});

const page = await findPage();
if (!page) {
  console.error('CDP-цель (страница) не найдена');
  app.kill();
  mock.kill();
  process.exit(1);
}
log('CDP target:', page.url);

ws = new WebSocket(page.webSocketDebuggerUrl);
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    const val = m.result?.result?.value;
    if (m.result?.exceptionDetails) reject(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400)));
    else resolve(val);
  }
});
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});
log('CDP connected');

// ---------------------------------------------------------------- 5. прогон
const waitFor = async (expr, timeoutMs = 30000, poll = 400) => {
  const t0 = Date.now();
  for (;;) {
    const v = await ev(expr);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(poll);
  }
};

// приложение и демо загрузились
check('window.sf доступен', await waitFor('!!window.sf', 20000));
check('демо-проект отрисован (узлы на графе)', await waitFor(`document.querySelectorAll('#graph .node-card').length > 0`, 30000));

const nodesBefore = await ev(`document.querySelectorAll('#graph .node-card').length`);
const themeBefore = await ev(`document.documentElement.dataset.theme`);
log('baseline: nodes =', nodesBefore, ', theme =', themeBefore);

// --- «Проверить подключение» (критерий 14)
await ev(`document.querySelector('#rightTabs [data-tab="ai"]')?.click()`);
// карточка настроек может быть открыта (нет ключа) или скрыта (ключ есть) — откроем принудительно
await ev(`document.querySelector('[data-ai-act="setup"]')?.click()`);
await ev(`document.querySelector('[data-ai-act="test"]')?.click()`);
const testStatus = await waitFor(`(() => { const s = document.querySelector('[data-ai-status]'); return s && /Связь есть/.test(s.textContent) ? s.textContent : ''; })()`, 15000);
check('«Проверить подключение» -> успех', !!testStatus, testStatus);
await ev(`document.querySelector('[data-ai-act="setup"]')?.click()`); // закрыть карточку

// --- отправка сообщения (критерий 15)
const msg = 'Мок-задание приёмки: создай персонажа, добавь три узла и свяжи их, перепиши текст старта, перестрой ветку и проверь проект.';
const sent = await ev(`(() => { const i = document.querySelector('#aiInput'); if (!i) return false; i.value = ${JSON.stringify(msg)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
check('сообщение отправлено в чат', sent);

// ждём конца стриминга: chat-status перестаёт быть «модель думает»
const streamingDone = await waitFor(
  `(() => { const s = document.querySelector('.chat-status'); if (!s) return false; const t = s.textContent || ''; return /думает/.test(t) ? false : (document.querySelector('#aiLog .msg-assistant:last-of-type') && !/думает/.test(t)) || t.includes('Ctrl+Enter'); })()`,
  90000, 500
);
check('цикл tool-calling завершился (стриминг стоп)', !!streamingDone);

const nodesAfter = await ev(`document.querySelectorAll('#graph .node-card').length`);
const toolOk = await ev(`document.querySelectorAll('#aiLog .tool-ok').length`);
const toolFail = await ev(`document.querySelectorAll('#aiLog .tool-fail').length`);
const lastAssistant = await ev(`(() => { const b = document.querySelectorAll('#aiLog .msg-assistant .msg-bubble'); return b.length ? b[b.length - 1].innerText.slice(0, 200) : ''; })()`);
check('создано 3 новых узла (граф)', nodesAfter === nodesBefore + 3, `${nodesBefore} -> ${nodesAfter}`);

// персонаж: вкладка персонажей
const charFound = await ev(`(() => { document.querySelector('#leftTabs [data-tab="characters"]')?.click(); const items = [...document.querySelectorAll('#leftBody .list-item')]; return items.some((li) => li.innerText.includes(${JSON.stringify(CHAR_NAME)})) ? items.length : 0; })()`);
check(`персонаж «${CHAR_NAME}» создан`, typeof charFound === 'number' && charFound > 0, `list items: ${charFound}`);

check('tool-трейсы в чате (>= 7 успешных)', toolOk >= 7, `ok=${toolOk}, fail=${toolFail}`);
check('нет проваленных инструментов', toolFail === 0, `fail=${toolFail}`);
check('финальный ответ ассистента получен', /Мок-задание выполнено/.test(lastAssistant || ''), (lastAssistant || '').slice(0, 80));

// --- отмена всего хода AI одним Ctrl+Z (критерий 14)
await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))`);
await sleep(700);
const nodesAfterUndo = await ev(`document.querySelectorAll('#graph .node-card').length`);
const charAfterUndo = await ev(`(() => { document.querySelector('#leftTabs [data-tab="characters"]')?.click(); const items = [...document.querySelectorAll('#leftBody .list-item')]; return items.some((li) => li.innerText.includes(${JSON.stringify(CHAR_NAME)})) ? 1 : 0; })()`);
check('Ctrl+Z откатывает весь ход AI (узлы)', nodesAfterUndo === nodesBefore, `${nodesAfter} -> ${nodesAfterUndo}`);
check('Ctrl+Z откатывает созданного персонажа', charAfterUndo === 0);

// --- тема без перезапуска (критерий 16)
await ev(`document.querySelector('#btnTheme')?.click()`);
await sleep(300);
const themeAfter = await ev(`document.documentElement.dataset.theme`);
check('тема переключается без перезапуска', themeAfter !== themeBefore, `${themeBefore} -> ${themeAfter}`);
await ev(`document.querySelector('#btnTheme')?.click()`); // вернуть как было

// --- ошибки консоли рендерера (критерий 18)
results.jsErrors = await ev(`window.__sfErrors || []`);

// ---------------------------------------------------------------- 6. итог
const failed = results.checks.filter((c) => !c.ok);
results.summary = {
  pass: results.checks.length - failed.length,
  fail: failed.length,
  nodesBefore,
  nodesAfter,
  nodesAfterUndo,
  toolOk,
  toolFail,
  themeBefore,
  themeAfter,
  electronCrashLines: electronOut.split(/\r?\n/).filter((l) => /ReferenceError|TypeError|SyntaxError|Uncaught|Cannot find module/.test(l)).slice(0, 20),
};
mkdirSync(join(ROOT, '.logs'), { recursive: true });
writeFileSync(join(ROOT, '.logs', 'prime-ai-e2e.json'), JSON.stringify(results, null, 2), 'utf8');
log('результаты: .logs/prime-ai-e2e.json');

try { spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true }); } catch { app.kill(); }
mock.kill();
await sleep(800);
console.log(`\n=== E2E AI: ${results.summary.pass} PASS / ${results.summary.fail} FAIL ===`);
if (results.jsErrors && results.jsErrors.length) console.log('jsErrors:', JSON.stringify(results.jsErrors));
process.exit(failed.length ? 1 : 0);
