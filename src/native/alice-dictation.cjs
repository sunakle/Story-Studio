'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');

// This local, per-profile capability accepts transcribed phrases, never audio.
// A new app process gets a new port and token. Do not log either the token or text.
const actions = new Set(['start', 'append', 'stop', 'status']);
const failed = code => ({ ok: false, code, active: false });
const bodyLimit = 100 * 1024; // room for 16,000 escaped JSON characters

function validCommand(value) {
  return value && actions.has(value.action) && typeof value.session === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(value.session)
    && (value.action !== 'append' || (Number.isSafeInteger(value.seq) && value.seq > 0
      && typeof value.text === 'string' && value.text.length <= 16000 && value.text.trim().length > 0));
}

async function startAliceEndpoint(profile, deliver) {
  const token = randomBytes(32).toString('hex');
  const credential = Buffer.from('Bearer ' + token);
  const file = path.join(profile, 'alice-dictation.json');
  const temp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  const server = http.createServer(async (req, res) => {
    function reply(status, result) {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
      res.end(JSON.stringify(result));
    }
    if (req.method !== 'POST' || req.url !== '/v1/dictation') return reply(404, failed('invalid'));
    const received = Buffer.from(req.headers.authorization || '');
    if (req.headers.origin !== undefined || received.length !== credential.length || !timingSafeEqual(credential, received)) {
      return reply(401, failed('unauthorized'));
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return reply(415, failed('invalid'));
    if (Number(req.headers['content-length']) > bodyLimit) return reply(413, failed('invalid'));
    const chunks = [];
    let length = 0;
    try {
      for await (const part of req) {
        length += part.length;
        if (length > bodyLimit) return reply(413, failed('invalid'));
        chunks.push(part);
      }
      const command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!validCommand(command)) return reply(400, failed('invalid'));
      const { action, session, seq, text } = command;
      let result;
      try { result = await deliver({ action, session, ...(action === 'append' && {seq, text}) }); }
      catch { result = failed('not_ready'); }
      reply(200, result);
    } catch {
      if (!res.destroyed && !res.headersSent) reply(400, failed('invalid'));
    }
  });
  server.requestTimeout = 12000;
  server.headersTimeout = 6000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const descriptor = { version: 1, port: server.address().port, token, pid: process.pid };
    await fs.promises.writeFile(temp, JSON.stringify(descriptor), { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(temp, file);
  } catch (e) {
    server.close();
    await fs.promises.rm(temp, { force: true });
    throw e;
  }
  return function close() {
    server.close();
    server.closeAllConnections();
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file);
    } catch { /* The profile may already have been removed. */ }
  };
}

module.exports = { startAliceEndpoint };
