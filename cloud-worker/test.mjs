// Offline tests with a mocked Workers AI binding: node test.mjs
import assert from 'node:assert/strict';
import worker, { extractText, validate } from './src/index.js';

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const calls = [];
const kv = new Map();
const env = {
  ALLOWED_ORIGINS: EXT,
  DAILY_LIMIT_PER_INSTALL: '6',
  AI: { run: async (model, input) => { calls.push({ model, input }); return { response: '{"thought":"ok","done":true,"answer":"82%"}' }; } },
  RATE_LIMITER: { limit: async () => ({ success: true }) },
  USAGE: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) },
};
const install = '0123456789abcdef0123456789abcdef';
const req = (body, origin = EXT, headers = {}) =>
  new Request('https://w.example/v1/chat', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-VeilBrowse-Install': install, ...headers }, body: JSON.stringify(body) });
const text = { kind: 'text', messages: [{ role: 'user', content: 'hi' }], format: { type: 'object' } };

let r = await worker.fetch(req(text), env);
assert.equal(r.status, 200);
assert.deepEqual(await r.json(), { ok: true, content: '{"thought":"ok","done":true,"answer":"82%"}' });
assert.equal(r.headers.get('Access-Control-Allow-Origin'), EXT);
assert.deepEqual(calls[0].input.response_format, { type: 'json_schema', json_schema: { type: 'object' } });

r = await worker.fetch(req(text, 'https://evil.example'), env);
assert.equal(r.status, 403, 'other origins rejected');
assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);

r = await worker.fetch(req(text, EXT, { 'X-VeilBrowse-Install': 'x' }), env);
assert.equal(r.status, 400, 'install id required');

r = await worker.fetch(req({ kind: 'vision', messages: [{ role: 'user', content: 'describe' }], image: 'AAAA' }), env);
assert.equal(r.status, 200);
const parts = calls.at(-1).input.messages.at(-1).content;
assert.equal(parts[1].image_url.url, 'data:image/jpeg;base64,AAAA', 'image attached as content part');

// daily cap: 1 + 5 used of 6 -> next text request refused
r = await worker.fetch(req(text), env);
assert.equal(r.status, 429);

assert.equal(validate({ kind: 'text', messages: [{ role: 'tool', content: 'x' }] }, env), 'Invalid message');
assert.equal(validate({ kind: 'vision', messages: [{ role: 'user', content: 'x' }] }, { ALLOW_VISION: 'false' }), 'Cloud vision is disabled on this server');
assert.equal(extractText({ choices: [{ message: { content: 'hello' } }] }), 'hello');
assert.equal(extractText({ response: { done: true } }), '{"done":true}');

const n = calls.length;
r = await worker.fetch(new Request('https://w.example/v1/chat', { method: 'OPTIONS', headers: { Origin: EXT } }), env);
assert.equal(r.status, 204);
assert.equal(calls.length, n);
console.log('cloud-worker: all tests passed');
