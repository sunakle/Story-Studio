import assert from 'node:assert/strict';
import test from 'node:test';
import claude from '../src/native/claude.cjs';
import references from '../src/native/public-reference.cjs';
import images from '../src/native/image-generation.cjs';

test('Claude request keeps image, tool IDs and ordered tool results together', () => {
  const headers = claude.claudeHeaders('local-fixture');
  assert.equal(headers['x-api-key'], 'local-fixture');
  assert.ok(!headers.Authorization);
  assert.equal(claude.useClaude('https://api.anthropic.com/v1', 'custom'), true);
  assert.equal(claude.useClaude('https://api.gateway.test/v1', 'custom'), false);
  const request = claude.claudeRequest({ model: 'test', max_tokens: 128, stream: true,
    messages: [{ role: 'system', content: 'project context' }, { role: 'user', content: [{ type: 'text', text: 'Edit' }, { type: 'image_url', image_url: {url:'data:image/png;base64,YQ=='} }] },
      { role:'assistant', content:'', tool_calls: ['one','two'].map(id => ({ id, function: {name:'edit_artwork',arguments:'{"x":1}'} })) },
      {role:'tool', tool_call_id:'one',content:'OK'}, {role:'tool', tool_call_id:'two',content:'OK'}],
    tools:[{function:{name:'edit_artwork',parameters:{type:'object'},description:'Edit'}}] });
  assert.equal(request.system, 'project context');
  assert.deepEqual(request.messages.map(m => m.role), ['user','assistant','user']);
  assert.equal(request.messages[0].content[1].source.media_type, 'image/png');
  assert.deepEqual(request.messages[1].content[0].input, {x:1});
  assert.deepEqual(request.messages[2].content.map(r=>r.tool_use_id), ['one','two']);
  assert.equal(request.tools[0].input_schema.type, 'object');
});

test('Claude stream dispatches text and completes a fragmented tool call only on message_stop', async () => {
  const events = [{type:'message_start',message:{usage:{input_tokens:12}}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Начинаю'}},
    {type:'content_block_start',index:1,content_block:{type:'tool_use',id:'test',name:'edit_artwork',input:{}}},
    {type:'content_block_delta', index:1, delta:{type:'input_json_delta',partial_json:'{"x":'}},
    {type:'content_block_delta', index:1, delta:{type:'input_json_delta',partial_json:'42}'}},
    {type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:8}}];
  const stream = events => new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''), {headers:{'content-type':'text/event-stream'}});
  const chunks = [];
  const result = await claude.claudeResponse(stream([...events,{type:'message_stop'}]), c=>chunks.push(c));
  assert.equal(result.toolCalls[0].arguments,'{"x":42}');
  assert.deepEqual(chunks,[{delta:'Начинаю'},{done:true}]);
  assert.deepEqual(result.usage,{input_tokens:12,output_tokens:8});
  await assert.rejects(claude.claudeResponse(stream(events),()=>{}), /before/);
});

test('external page references exclude credentials, local networks and embedded scripts', async () => {
  for (const address of ['::1','fc00::1','::ffff:127.0.0.1','2002:7f00:1::','2001::ff','127.0.0.2','172.17.1.1','169.254.169.254','10.255.255.1','224.0.0.1'])
    assert.equal(references.publicAddress(address),false,address);
  for (const address of ['8.8.8.8','2606:4700:4700::1111']) assert.equal(references.publicAddress(address),true);
  for (const url of ['file:///etc/hosts','http://example.com','https://u:p@example.com','https://example.com:3000']) assert.throws(()=>references.publicUrl(url));
  await assert.rejects(references.readLink('https://127.0.0.1/path'), /закрытый/);
  assert.equal(references.plainHtml('<b>OK &amp; OK</b><script>alert(1)</script>'),'OK & OK');
});

test('image generation uses only configured providers and validates the returned raster', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNXsAAAAASUVORK5CYII=';
  const settings = {baseUrl:'https://chat.example/v1',apiKey:'chat-fixture',imageBaseUrl:'https://images.example/v1',imageModel:'test'};
  const requests = [];
  const send = async (url, options) => {
    requests.push({url, ...options});
    return Response.json({data:[{b64_json:png}]});
  };
  const result = await images.generateImage({prompt:'A harbour'},settings,send);
  assert.equal(result.dataUrl,'data:image/png;base64,'+png);
  assert.equal(requests[0].url,'https://images.example/v1/images/generations');
  assert.equal(requests[0].headers.Authorization,undefined);
  await images.generateImage({prompt:'A harbour'}, {...settings,imageApiKey:'image-fixture'},send);
  assert.equal(requests[1].headers.Authorization,'Bearer image-fixture');
  await images.generateImage({prompt:'A harbour'}, {...settings,imageBaseUrl:settings.baseUrl},send);
  assert.equal(requests[2].headers.Authorization,'Bearer chat-fixture');
  await assert.rejects(images.generateImage({prompt:'x'}, {},send), /настройки/);
  await assert.rejects(images.generateImage({prompt:'x'},settings, async()=>Response.json({data:[{b64_json:'YWJj'}]})), /неподдерживаемое/);
});
