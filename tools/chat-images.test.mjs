import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/js/model.js';
import { createAI } from '../src/js/ai.js';
import { imageEndpoint, imageRejection, userMessageContent, turnCost, visionUnavailable, prepareChatImage } from '../src/js/chat-images.js';

const settings = {baseUrl:'https://example.test/v1/', model:'vision'};
const photo = {name:'reference.png', data:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==', thumb:'data:image/webp;base64,UklGRg=='};
const source = imageEndpoint(settings);
const message = {role:'user',content:'Read the sign',images:[photo],imageEndpoint:source};

test('vision content and history are isolated to the chosen endpoint, with separate text and photo budgets', () => {
  assert.deepEqual(userMessageContent(message, settings), [
    {type:'text',text:message.content}, {type:'image_url',image_url:{url:photo.data}},
  ]);
  assert.equal(userMessageContent({role:'user',content:'hello'},settings),'hello');
  assert.equal(userMessageContent({...message,content:''},settings).length,1);
  assert.match(userMessageContent(message,{...settings,baseUrl:'https://elsewhere.test/v1'}),/Read the sign/);
  assert.doesNotMatch(userMessageContent(message,{...settings,baseUrl:'https://elsewhere.test/v1'}),/base64/);
  assert.equal(turnCost([message], settings).images,photo.data.length);
  assert.equal(turnCost([message], {...settings,baseUrl:'https://elsewhere.test/v1'}).images,0);
  assert.ok(turnCost([{...message,images:[{...photo,data:photo.data+'a'.repeat(90000)}]}],settings).text<256);
});

test('documented official text-only models are identified without blocking compatible third-party models', async () => {
  assert.equal(visionUnavailable({baseUrl:'https://api.deepseek.com/v1',model:'deepseek-v4-pro'}),true);
  assert.equal(visionUnavailable({baseUrl:'https://api.deepseek.com/v1',model:'deepseek-flash'}),false);
  assert.equal(visionUnavailable({...settings,model:'deepseek-v4-pro'}),false);
  assert.equal(imageRejection('HTTP 400: this model does not support image input'),true);
  assert.equal(imageRejection('HTTP 401: incorrect API key'),false);
  await assert.rejects(prepareChatImage({type:'image/svg+xml',size:10}));
  await assert.rejects(prepareChatImage({type:'image/png',size:21*1024*1024}));
});

test('photo survives tool loop, history reload, and text follow-up; errors can be retried without phantom turns', async () => {
  const store = new Store();
  let saved = [], calls = [], reject = true;
  const mockSettings = { ai: { ...settings, apiKey:'local-test' } };
  globalThis.window = {sf:{
    history:{read:async()=>structuredClone(saved),write:async items=>{saved=structuredClone(items);}},
    ai:{chat:async ({body})=>{
      calls.push(structuredClone(body.messages));
      if(reject) return {ok:false,error:'HTTP 400: model does not accept image_url'};
      if(!body.messages.some(m=>m.role==='tool')) return {ok:true,toolCalls:[{id:'tool1',name:'get_project_overview',arguments:'{}'}]};
      return {ok:true,content:'Ready'};
    }},
  }};
  const open = () => createAI({root:null, store, ui:{escapeHTML:String,settings:mockSettings}});
  const app=open();
  await app.send('Use this photo',[photo]);
  assert.equal(saved.length,0);
  assert.equal(calls.length,1);
  reject=false;
  await app.send('Use this photo',[photo]);
  assert.equal(saved.filter(m=>m.role==='user').length,1);
  assert.equal(saved[0].images[0].data,photo.data);
  assert.equal(calls.at(-1).find(m=>m.role==='user').content.at(-1).image_url.url,photo.data);
  assert.equal(calls.at(-1).find(m=>m.role==='tool').tool_call_id,'tool1');
  const reopened=open();
  await reopened.send('What did you see?');
  assert.equal(calls.at(-1).filter(m=>m.role==='user')[0].content.at(-1).image_url.url,photo.data);
  mockSettings.ai.baseUrl='https://next.test/v1';
  await reopened.send('Continue writing');
  assert.ok(calls.at(-1).every(m=>typeof m.content==='string'));
});
