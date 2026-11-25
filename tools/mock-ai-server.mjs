#!/usr/bin/env node
// StoryForge — OpenAI-совместимый заглушечный сервер для проверки AI-цикла (критерий приёмки 15).
// Без зависимостей: только node:http. Запуск: node tools/mock-ai-server.mjs [--port=8799]
//
// Маршруты:
//   GET  /v1/models            -> {"data":[{"id":"mock-model"}]}
//   POST /v1/chat/completions  -> stream:true (SSE: data: {...}\n\n ... data: [DONE]\n\n) и stream:false.
//     Если в теле есть `tools` и в истории сообщений ещё нет role:"tool" —
//     ответ содержит tool_calls (project_summary); иначе — текстовый ответ.
//
// Режимы для тестов ошибок (в query или заголовках):
//   ?fail=401  (или заголовок x-mock-fail: 401) — ответ с этим кодом и JSON-ошибкой;
//   ?delay=500 (или заголовок x-mock-delay: 500) — задержка ответа в мс.
//
// Логи запросов пишутся в stdout. Корректно завершается по SIGINT/SIGTERM.

import http from 'node:http';

const argMap = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const i = a.indexOf('=');
      return [a.slice(2, i), a.slice(i + 1)];
    })
);
const PORT = Number(argMap.get('port') || process.env.MOCK_AI_PORT || 8799);
const HOST = '127.0.0.1';
const MODEL_ID = 'mock-model';
const TOOL_NAME = 'project_summary';
const TOOL_ARGS = '{}';

// --- сценарий E2E-приёмки (заголовок x-mock-script: e2e) -------------------
// «Модель» выполняет задание критерия 15 спеки: создать персонажа, добавить
// 3 узла и связать их, переписать текст выбранного узла, перестроить ветку,
// проверить проект. Шаг = номер запроса со сценарием; реальные id мок берёт
// из предыдущих ответов инструментов (messages[*].role === 'tool').
const lastToolResult = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool') {
      try {
        return JSON.parse(messages[i].content);
      } catch {
        return null;
      }
    }
  }
  return null;
};

const E2E_CHAR_NAME = 'Тестовый Персонаж';
const e2eSteps = [
  { tool: 'create_character', args: { name: E2E_CHAR_NAME, color: '#e05555', role: 'мок-проверка', description: 'Персонаж, созданный ИИ в рамках приёмки.' } },
  { tool: 'bulk_apply', args: { ops: [
    { op: 'createNode', node: { id: 'tmp_1', type: 'line', text: 'Первая реплика, добавленная ассистентом.' } },
    { op: 'createNode', node: { id: 'tmp_2', type: 'line', text: 'Вторая реплика, добавленная ассистентом.' } },
    { op: 'createNode', node: { id: 'tmp_3', type: 'end', text: 'Концовка мок-проверки.' } },
    { op: 'connect', from: 'tmp_1', to: 'tmp_2' },
    { op: 'connect', from: 'tmp_2', to: 'tmp_3' },
  ] } },
  { tool: 'get_project_overview', args: {} },
  { tool: 'set_node_text', args: { text: 'Текст переписан ассистентом (мок-проверка).' }, resolve: (prev) => ({ id: prev?.startNodeId }) },
  { tool: 'list_nodes', args: { type: 'condition' } },
  { tool: 'get_node', resolve: (prev) => ({ id: prev?.nodes?.find((n) => n.type === 'condition')?.id }) },
  { tool: 'set_branches', resolve: (prev) => ({ id: prev?.id, branches: [...(prev?.branches || [])].reverse() }) },
  { tool: 'validate_project', args: {} },
  { text: 'Мок-задание выполнено: персонаж создан, три узла добавлены и связаны, текст старта переписан, ветка перестроена, проект проверен.' },
];
let e2eCount = 0;
const e2eStep = (prev) => {
  const step = e2eSteps[e2eCount] || e2eSteps[e2eSteps.length - 1];
  e2eCount++;
  if (step.text) return { text: step.text };
  const extra = step.resolve ? (step.resolve(prev) || {}) : {};
  return { tool: step.tool, args: { ...(step.args || {}), ...extra } };
};

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...parts) => console.log(`[mock-ai ${stamp()}]`, ...parts);
const uid = (p) => `${p}-${Math.random().toString(36).slice(2, 10)}`;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const fail = String(url.searchParams.get('fail') || req.headers['x-mock-fail'] || '');
  const delay = Number(url.searchParams.get('delay') || req.headers['x-mock-delay'] || 0);
  // Какой инструмент «вызывать» и с какими аргументами — можно переопределить
  // через query: ?tool=create_node&args={"type":"note","text":"..."} (args — URL-encoded JSON).
  const toolNameQ = url.searchParams.get('tool') || TOOL_NAME;
  const toolArgsQ = url.searchParams.get('args') || TOOL_ARGS;
  let toolName = toolNameQ;
  let toolArgs = toolArgsQ;

  try {
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      log('GET /v1/models -> 200');
      sendJson(res, 200, { object: 'list', data: [{ id: MODEL_ID }] });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        log('POST /v1/chat/completions -> 400 (некорректный JSON)');
        sendJson(res, 400, { error: { message: 'Некорректный JSON в теле запроса', type: 'invalid_request_error' } });
        return;
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const roles = messages.map((m) => m.role).join(',');
      log(
        `POST /v1/chat/completions stream=${!!body.stream} tools=${(body.tools || []).length}`,
        `messages=${messages.length} (${roles}) model=${body.model || '-'}`
      );

      if (delay > 0) await new Promise((r) => setTimeout(r, Math.min(delay, 30000)));

      if (fail) {
        const code = Number(fail) || 500;
        log(`  -> ${code} (mock fail по запросу)`);
        sendJson(res, code, {
          error: { message: `Мок-ошибка по запросу (fail=${fail})`, type: 'mock_error', code },
        });
        return;
      }

      // Сценарий E2E: последовательность tool_calls по номеру запроса.
      // Новый диалог (ещё нет ни одного ответа инструмента) начинает сценарий с начала.
      const msgList = Array.isArray(messages) ? messages : [];
      const freshConversation = !msgList.some((m) => m && m.role === 'tool');
      if (req.headers['x-mock-script'] === 'e2e' && freshConversation) e2eCount = 0;
      const scripted = req.headers['x-mock-script'] === 'e2e' ? e2eStep(lastToolResult(messages)) : null;
      if (scripted && scripted.tool) {
        toolName = scripted.tool;
        toolArgs = JSON.stringify(scripted.args);
      }

      // Первый раунд с tools -> tool_calls; после role:"tool" -> текст.
      const wantToolCall = scripted
        ? !!scripted.tool
        : Array.isArray(body.tools) && body.tools.length > 0 && !messages.some((m) => m.role === 'tool');

      if (body.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const chunk = (delta, finishReason) =>
          sseWrite(res, { id: uid('chatcmpl'), object: 'chat.completion.chunk', created: Date.now() / 1000 | 0, model: MODEL_ID, choices: [{ index: 0, delta, finish_reason: finishReason }] });

        if (wantToolCall) {
          chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name: toolName, arguments: '' } }] }, null);
          chunk({ tool_calls: [{ index: 0, function: { arguments: toolArgs } }] }, null);
          chunk({}, 'tool_calls');
          log('  -> 200 SSE, tool_calls:', toolName);
        } else {
          const text = scripted && scripted.text ? scripted.text : 'Ответ мок-сервера: цикл tool-calling завершён, проект не менялся.';
          const parts = text.length > 40 ? [text.slice(0, Math.ceil(text.length / 3)), text.slice(Math.ceil(text.length / 3), Math.ceil((2 * text.length) / 3)), text.slice(Math.ceil((2 * text.length) / 3))] : [text];
          parts.forEach((part, i) => {
            chunk(i === 0 ? { role: 'assistant', content: part } : { content: part }, null);
          });
          chunk({}, 'stop');
          log('  -> 200 SSE, текст');
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // stream:false
      const completion = {
        id: uid('chatcmpl'),
        object: 'chat.completion',
        created: (Date.now() / 1000) | 0,
        model: MODEL_ID,
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      };
      if (wantToolCall) {
        log('  -> 200, tool_calls:', toolName);
        sendJson(res, 200, {
          ...completion,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_mock_1', type: 'function', function: { name: toolName, arguments: toolArgs } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        });
      } else {
        log('  -> 200, текст');
        sendJson(res, 200, {
          ...completion,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: scripted && scripted.text ? scripted.text : 'Ответ мок-сервера: цикл tool-calling завершён, проект не менялся.' },
              finish_reason: 'stop',
            },
          ],
        });
      }
      return;
    }

    log(`${req.method} ${url.pathname} -> 404`);
    sendJson(res, 404, { error: { message: `Неизвестный маршрут: ${req.method} ${url.pathname}`, type: 'invalid_request_error' } });
  } catch (err) {
    log('ошибка обработки:', err && err.stack ? err.stack.split('\n')[0] : err);
    if (!res.headersSent) sendJson(res, 500, { error: { message: String(err && err.message) } });
    else res.end();
  }
});

function shutdown(signal) {
  log(`получен ${signal} — останавливаюсь`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
  log(`слушаю http://${HOST}:${server.address().port} (models: /v1/models, chat: /v1/chat/completions)`);
});
