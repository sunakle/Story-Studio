'use strict';

function protocolError(code) {
  return Object.assign(new Error(code), { code });
}

function providerError(detail) {
  const message = typeof detail === 'string' ? detail : detail?.message;
  const kind = detail?.type || detail?.code || '';
  if (!/auth|permission|rate.limit|quota|billing/i.test(kind) &&
      /\b(?:unterminated string in JSON|unexpected end of JSON input|EOF while parsing (?:a string|an object|a value))\b/i.test(message || '')) {
    return protocolError('INCOMPLETE_AI_STREAM');
  }
  return new Error(message || 'The model provider returned an error.');
}

async function responseJson(response) {
  try { return await response.json(); }
  catch (err) {
    if (err.name === 'AbortError') throw err;
    throw protocolError('INCOMPLETE_AI_STREAM');
  }
}

// SSE dispatches a whole event on a blank line. A fetch chunk may end in the
// middle of JSON, a CRLF pair, or a multibyte character.
async function* jsonEvents(response) {
  const decoder = new TextDecoder();
  let buffer = '', data = [];
  function parseEvent(payload) {
    if (payload === '[DONE]') return payload;
    let event;
    try { event = JSON.parse(payload); }
    catch { throw protocolError('INCOMPLETE_AI_STREAM'); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw protocolError('INCOMPLETE_AI_STREAM');
    return event;
  }
  function* consume(line) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    if (line || !data.length) return;
    const parts = data;
    data = [];
    const payload = parts.join('\n').trim();
    if (!payload) return;
    try { yield parseEvent(payload); }
    catch (err) {
      // Older compatible gateways omit the blank separator between complete events.
      if (parts.length === 1) throw err;
      yield* parts.map(part => parseEvent(part.trim()));
    }
  }
  try {
    for await (const chunk of response.body) {
      const lines = (buffer + decoder.decode(chunk, {stream:true})).split('\n');
      buffer = lines.pop();
      for (const line of lines) yield* consume(line);
    }
  } catch (err) {
    if (err.name === 'AbortError' || err.code === 'INCOMPLETE_AI_STREAM') throw err;
    throw protocolError('INCOMPLETE_AI_STREAM');
  }
  // Some compatible gateways close immediately after the final data line.
  yield* consume(buffer + decoder.decode());
  yield* consume('');
}

function toolInput(raw) {
  let input = raw;
  if (typeof raw === 'string') {
    try { input = JSON.parse(raw); }
    catch { throw protocolError('INVALID_AI_TOOL_ARGUMENTS'); }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw protocolError('INVALID_AI_TOOL_ARGUMENTS');
  return input;
}

function completeToolCalls(calls, finishReason, content) {
  const hasText = typeof content === 'string' && content.trim().length > 0;
  if (finishReason === 'max_tokens' || finishReason === 'length') {
    throw protocolError('AI_OUTPUT_LIMIT');
  }
  if (!calls.length && !hasText) throw protocolError('EMPTY_AI_RESPONSE');
  const ids = new Set();
  return calls.map(call => {
    // Validate the entire batch before the renderer can execute its first edit.
    if (typeof call.id !== 'string' || !call.id.trim() || ids.has(call.id) ||
        typeof call.name !== 'string' || !call.name.trim()) throw protocolError('INVALID_AI_TOOL_ARGUMENTS');
    ids.add(call.id);
    const input = toolInput(call.arguments);
    return { ...call, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(input) };
  });
}

module.exports = { protocolError, providerError, responseJson, jsonEvents, toolInput, completeToolCalls };
