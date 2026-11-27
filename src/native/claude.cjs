'use strict';

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
      blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments || '{}') });
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
    const json = await response.json();
    if (!Array.isArray(json.content)) throw Error('Claude returned an invalid message.');
    const content = json.content.filter(p => p.type === 'text').map(p => p.text).join('');
    if (content) send({ delta: content });
    send({ done: true });
    return { ok: true, content, toolCalls: json.content.filter(p => p.type === 'tool_use').map(p => ({ id: p.id, name: p.name, arguments: JSON.stringify(p.input) })), finishReason: json.stop_reason, usage: json.usage };
  }
  let content = '', finishReason = null, completed = false;
  const calls = new Map(), usage = {};
  function handle(line) {
    if (!line.startsWith('data:')) return;
    const event = JSON.parse(line.slice(5).trim());
    if (event.type === 'error') throw Error(event.error?.message || 'Claude stream failed.');
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
      if (!call) throw Error('Incomplete Claude tool call.');
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
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) handle(line.trim());
  }
  handle((pending + decoder.decode()).trim());
  if (!completed) {
    const error = new Error('Claude stream ended before the message was complete.');
    error.code = 'INCOMPLETE_AI_STREAM';
    throw error;
  }
  const toolCalls = [...calls.values()].map(({ id, name, arguments: args, initial }) => ({ id, name, arguments: args || JSON.stringify(initial) }));
  send({ done: true });
  return { ok: true, content, finishReason, toolCalls, usage };
}

module.exports = { useClaude, claudeHeaders, claudeRequest, claudeResponse };
