'use strict';
const toolError = (ru, en) => Object.assign(new Error(ru), { english: en });
const https = require('node:https');
const dns = require('node:dns/promises');
const { isIP } = require('node:net');

function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return a > 0 && a < 224 && ![10, 127].includes(a)
      && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
      && !(a === 100 && b >= 64 && b <= 127) && !(a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
      && !(a === 198 && [18, 19, 51].includes(b)) && !(a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) !== 6) return false;
  const [first, second] = address.toLowerCase().split(':');
  const prefix = parseInt(first, 16);
  const next = parseInt(second || '0', 16);
  return prefix >= 0x2000 && prefix < 0x4000 && prefix !== 0x2002
    && !(prefix === 0x2001 && (next <= 0x1ff || next === 0xdb8))
    && !(prefix === 0x3fff && next < 0x1000);
}

function publicUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw toolError('Требуется публичная HTTPS-ссылка без пароля.', 'Enter a public HTTPS link without credentials.');
  }
  return url;
}

async function fetchPublic(input, { limit, accept, signal }, redirects = 0) {
  const url = publicUrl(input);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const records = isIP(host) ? [{ address: host, family: isIP(host) }] : await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(record => !publicAddress(record.address))) throw toolError('Ссылка ведёт на закрытый сетевой адрес.', 'This link points to a private network address.');
  signal.throwIfAborted();
  const res = await new Promise((resolve, reject) => {
    // Bind the connection to a validated DNS result, retaining the original TLS hostname.
    const req = https.get(url, {
      agent: false, signal, headers: { Accept: accept, 'Accept-Encoding': 'identity' },
      lookup: (_host, options, cb) => options.all ? cb(null, records) : cb(null, records[0].address, records[0].family),
    }, resolve);
    req.once('error', reject);
  });
  if (res.statusCode >= 300 && res.statusCode < 400) {
    res.destroy();
    if (redirects >= 4 || !res.headers.location) throw toolError('Слишком много перенаправлений или неверная ссылка.', 'Too many redirects or an invalid redirect.');
    return fetchPublic(new URL(res.headers.location, url), { limit, accept, signal }, redirects + 1);
  }
  if (res.statusCode !== 200 || Number(res.headers['content-length']) > limit) {
    res.destroy();
    if (res.statusCode === 200) throw toolError('Файл слишком велик.', 'The file is too large.');
    throw Error('HTTP ' + res.statusCode);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > limit) { res.destroy(); throw toolError('Файл слишком велик.', 'The file is too large.'); }
    chunks.push(chunk);
  }
  return { bytes: Buffer.concat(chunks), type: String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase() };
}

function plainHtml(html) {
  const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/&(amp|quot|apos|lt|gt|nbsp|#\d{1,7}|#x[\da-f]{1,6});/gi, (whole, key) => {
      if (key[0] !== '#') return entities[key.toLowerCase()] || whole;
      const point = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return point <= 0x10ffff ? String.fromCodePoint(point) : '';
    }).replace(/\s+/g, ' ').trim();
}

async function readLink(input) {
  if (typeof input !== 'string' || input.length > 8192) throw toolError('Неверная ссылка.', 'Invalid link.');
  const { bytes, type } = await fetchPublic(input, { accept: 'text/html, text/plain, text/markdown, application/json', limit: 1024 * 1024, signal: AbortSignal.timeout(15000) });
  if (!['text/html', 'text/plain', 'text/markdown', 'application/json', 'application/xhtml+xml'].includes(type)) throw toolError('По этой ссылке нет читаемого текста.', 'The link did not return a readable text document.');
  const source = bytes.toString('utf8');
  const html = type.includes('html');
  const title = html ? plainHtml((/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(source) || [])[1] || '').slice(0, 200) : '';
  const text = (html ? plainHtml(source) : source).slice(0, 20000).trim();
  if (!text) throw toolError('На странице нет доступного текста.', 'This page has no readable text.');
  return { ok: true, title, text };
}

module.exports = { toolError, publicAddress, publicUrl, fetchPublic, plainHtml, readLink };
