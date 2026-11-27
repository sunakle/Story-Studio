'use strict';
const { fetchPublic, toolError } = require('./public-reference.cjs');

const LIMIT = 8 * 1024 * 1024;
const SIZES = new Set(['auto', '1024x1024', '1536x1024', '1024x1536']);

function raster(bytes) {
  if (bytes.length > LIMIT) throw toolError('Изображение превышает 8 МБ.', 'The image exceeds 8 MB.');
  let type;
  if (bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii', 12, 16) === 'IHDR') type = 'png';
  else if (bytes.length > 12 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) type = 'jpeg';
  else if (bytes.length > 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') type = 'webp';
  if (!type) throw toolError('Генератор вернул неподдерживаемое изображение.', 'The generator returned an unsupported image.');
  return 'data:image/' + type + ';base64,' + bytes.toString('base64');
}

async function boundedText(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) throw toolError('Ответ генератора слишком велик.', 'The image service response is too large.');
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw toolError('Ответ генератора слишком велик.', 'The image service response is too large.'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function generateImage({ prompt, size } = {}, settings, fetcher = fetch, signal = AbortSignal.timeout(180000)) {
  if (!settings.imageBaseUrl || !settings.imageModel) throw toolError('Откройте настройки ИИ и укажите адрес и модель в разделе «Генерация изображений».', 'Open AI settings and enter an endpoint and model under Image generation.');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000) throw toolError('Нужно описание для изображения (до 16 000 символов).', 'Enter an image prompt of up to 16,000 characters.');
  if (size && !SIZES.has(size)) throw toolError('Неподдерживаемый размер изображения.', 'Unsupported image dimensions.');
  const base = new URL(settings.imageBaseUrl.trim().replace(/\/+$/, '') + '/');
  const local = ['localhost','127.0.0.1','[::1]'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !(local && base.protocol === 'http:')) || base.search || base.hash || base.username || base.password) throw toolError('Проверьте адрес сервиса изображений.', 'Check the image service URL.');
  let key = settings.imageApiKey;
  if (!key && settings.baseUrl && new URL(settings.baseUrl).origin === base.origin) key = settings.apiKey;
  const res = await fetcher(new URL('images/generations', base).href, { method: 'POST', redirect: 'error', credentials: 'omit', signal,
    headers: { 'Content-Type': 'application/json', ...(key && { Authorization: 'Bearer ' + key }) },
    body: JSON.stringify({ model: settings.imageModel, prompt: prompt.trim(), n: 1, ...(size && { size }) }) });
  if (!res.ok) throw Error('HTTP ' + res.status + '. ' + (await boundedText(res, 64000)).slice(0, 400));
  const item = JSON.parse(await boundedText(res, Math.ceil(LIMIT * 4 / 3) + 65536)).data?.[0];
  let bytes;
  if (typeof item?.b64_json === 'string' && /^[a-zA-Z0-9+/]+={0,2}$/.test(item.b64_json)) bytes = Buffer.from(item.b64_json, 'base64');
  else if (typeof item?.url === 'string') bytes = (await fetchPublic(item.url, { accept: 'image/png,image/jpeg,image/webp', limit: LIMIT, signal })).bytes;
  else throw toolError('Ответ сервиса не содержит изображения.', 'The service returned no image.');
  return { ok: true, dataUrl: raster(bytes) };
}

module.exports = { generateImage, raster };
