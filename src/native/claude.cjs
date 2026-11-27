'use strict';

const { protocolError, providerError, responseJson, jsonEvents, toolInput, completeToolCalls } = require('./ai-response.cjs');

function useClaude(base, preset) {
  try { return preset === 'anthropic' || new URL(base).hostname === 'api.anthropic.com'; } catch { return false; }
}

function claudeHeaders(key, extra = {}) {
  return { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(key && { 'x-api-key': key }), ...extra };
}

function userParts(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return (content || []).map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(part.image_url?.url || '');
    if (!match) throw Error('Unsupported image format for Claude.');
    return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
  });
}

function claudeRequest(body) {
  const system = [], messages = [];
  for (const entry of body.messages || []) {
    if (entry.role === 'system') { system.push(entry.content); continue; }
    const role = entry.role === 'assistant' ? 'assistant' : 'user';
    const blocks = entry.role === 'tool'
      ? [{ type: 'tool_result', tool_use_id: entry.tool_call_id, content: String(entry.content || '') }]
      : userParts(entry.content);
    for (const call of entry.tool_calls || []) {
      blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: toolInput(call.function.arguments ?? '{}') });
    }
    if (!blocks.length) continue;
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  }
  const tools = (body.tools || []).map(({ function: fn }) => ({ name: fn.name, description: fn.description, input_schema: fn.parameters }));
  return { model: body.model, max_tokens: body.max_tokens, messages, stream: Boolean(body.stream),
    ...(system.length && { system: system.join('\n\n') }), ...(tools.length && { tools }) };
}

async function claudeResponse(response, send) {
  if (!response.headers.get('content-type')?.includes('event-stream')) {
    const json = await responseJson(response);
    if (json?.error) throw providerError(json.error);
    if (!Array.isArray(json?.content)) throw protocolError('INCOMPLETE_AI_STREAM');
    const content = json.content.filter(p => p.type === 'text').map(p => p.text).join('');
    const toolCalls = completeToolCalls(json.content.filter(p => p.type === 'tool_use').map(p => ({
      id: p.id, name: p.name, arguments: p.input,
    })), json.stop_reason, content);
    if (content) send({ delta: content });
    send({ done: true });
    return { ok: true, content, toolCalls, finishReason: json.stop_reason, usage: json.usage };
  }
  let content = '', finishReason = null, completed = false;
  const calls = new Map(), usage = {};
  for await (const event of jsonEvents(response)) {
    if (event.type === 'error') throw providerError(event.error);
    if (event.type === 'message_start') Object.assign(usage, event.message?.usage);
    if (event.content_block?.type === 'text' && event.content_block.text) {
      content += event.content_block.text;
      send({ delta: event.content_block.text });
    }
    if (event.content_block?.type === 'tool_use') {
      const b = event.content_block;
      calls.set(event.index, { id: b.id, name: b.name, arguments: '', initial: b.input || {} });
    }
    if (event.delta?.type === 'input_json_delta') {
      const call = calls.get(event.index);
      if (!call || typeof event.delta.partial_json !== 'string') throw protocolError('INCOMPLETE_AI_STREAM');
      call.arguments += event.delta.partial_json;
    }
    if (event.delta?.type === 'text_delta' && event.delta.text) {
      content += event.delta.text;
      send({ delta: event.delta.text });
    }
    if (event.type === 'message_delta') {
      finishReason = event.delta?.stop_reason;
      Object.assign(usage, event.usage);
    }
    if (event.type === 'message_stop') completed = true;
  }
  if (!completed) throw protocolError('INCOMPLETE_AI_STREAM');
  const toolCalls = completeToolCalls([...calls.values()].map(({ id, name, arguments: args, initial }) => ({
    id, name, arguments: args || initial,
  })), finishReason, content);
  send({ done: true });
  return { ok: true, content, finishReason, toolCalls, usage };
}

module.exports = { useClaude, claudeHeaders, claudeRequest, claudeResponse };
