import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { inspect, format } from 'node:util';
import { createServer } from 'node:http';
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { RayonError, solve } from '../src/index.js';

const target = 'https://example.com/product';
const key = 'test-secret-key';
const previous = getGlobalDispatcher();
let mock: MockAgent;
function accepted(prefix = 'X-Variable9') {
  return {
    status: 'accepted', method: 'v8_sandbox', target_url: target, duration_ms: 52,
    headers: Object.fromEntries(['a', 'b', 'c', 'd', 'f', 'z'].map(s => [`${prefix}-${s}`, s === 'd' ? '' : 'header-secret-value'])),
    cookies: [{ name: 'session', value: 'cookie-secret-value', domain: '.example.com', path: '/' }],
    profile_used: { nested: { secret: 'profile-secret-value' } }, errors: ['diagnostic-secret-value'],
  };
}
function reply(body: unknown, headers = {}) {
  mock.get('https://api.rayonapi.com').intercept({ path: '/solve', method: 'POST' }).reply(200, body, { headers });
}
function errorKind(kind: string) {
  return (error: unknown) => {
    assert.ok(error instanceof RayonError);
    assert.equal(error.kind, kind);
    assert.ok(!format(error).includes(key));
    return true;
  };
}
beforeEach(() => { mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock); });
afterEach(async () => { setGlobalDispatcher(previous); await mock.close(); });

test('redacts result inspection while preserving explicit session access and JSON', async () => {
  const body = accepted();
  reply(body);
  const result = await solve(target, key);
  for (const printed of [inspect(result), format(result), format('%o', result), format('%O', result)]) {
    for (const secret of ['header-secret-value', 'cookie-secret-value', 'profile-secret-value', 'diagnostic-secret-value']) assert.ok(!printed.includes(secret), printed);
    assert.match(printed, /REDACTED/);
    assert.match(printed, /accepted/);
  }
  assert.equal(result.headers['X-Variable9-a'], 'header-secret-value');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), body);
});
test('rejects a JSON response exceeding 2MiB', async () => {
  reply({ ...accepted(), errors: [key + 'x'.repeat(2 * 1024 * 1024)] });
  await assert.rejects(solve(target, key), errorKind('invalid_response'));
});
for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]] as const) {
  test(`accepts bounded ${encoding} responses`, async () => {
    reply(compress(Buffer.from(JSON.stringify(accepted()))), { 'content-encoding': encoding });
    assert.equal((await solve(target, key)).status, 'accepted');
  });
  test(`limits decoded ${encoding} response bytes`, async () => {
    const json = JSON.stringify({ ...accepted(), errors: [key + 'x'.repeat(2 * 1024 * 1024)] });
    reply(compress(Buffer.from(json)), { 'content-encoding': encoding });
    await assert.rejects(solve(target, key), errorKind('invalid_response'));
  });
}
for (const url of ['https://example.com#', 'https://example.com#section', 'https://example.com:0/', 'https://example.com:000/', 'https://example.com\\path', 'https://@example.com/', 'https:example.com', 'https://example.com/' + 'x'.repeat(8192)]) {
  test(`rejects ambiguous target URL (${url.slice(0, 80)})`, async () => {
    await assert.rejects(solve(url, key), errorKind('validation'));
  });
}
for (const baseUrl of ['https://example.com#', 'https://example.com:0/', 'https://@example.com/', 'https://example.com\\path']) {
  test('rejects ambiguous API base URLs before sending the key', async () => {
    await assert.rejects(solve(target, key, { baseUrl }), errorKind('validation'));
  });
}
for (const value of ['\u0001', '\t', '\u001f', '\u007f', '\u0100', '🦊']) {
  test(`rejects non-HTTP header characters ${JSON.stringify(value)}`, async () => {
    const body = accepted();
    body.headers['X-Variable9-a'] = `value${value}`;
    reply(body);
    await assert.rejects(solve(target, key), errorKind('invalid_response'));
  });
}
for (const [name, body] of [
  ['header name exceeds 256 characters', accepted('X'.repeat(255))],
  ['header value exceeds 16384 characters', { ...accepted(), headers: { ...accepted().headers, 'X-Variable9-a': 'x'.repeat(16385) } }],
] as const) {
  test(`rejects ${name}`, async () => {
    reply(body);
    await assert.rejects(solve(target, key), errorKind('invalid_response'));
  });
}
for (const wrapped of ['custom-label', null, 3, []]) {
  test('rejects a profile wrapper that is not an object', async () => {
    await assert.rejects(solve(target, key, { profile: { profile: wrapped } }), errorKind('validation'));
  });
}
test('accepts an object profile wrapper and header size boundaries', async () => {
  const body = accepted('X'.repeat(254));
  body.headers['X'.repeat(254) + '-a'] = 'x'.repeat(16384);
  mock.get('https://api.rayonapi.com').intercept({ path: '/solve', method: 'POST', body: JSON.stringify({ target_url: target, profile: { profile: { locale: 'en-GB' } } }) }).reply(200, body);
  assert.equal((await solve(target, key, { profile: { profile: { locale: 'en-GB' } } })).status, 'accepted');
});

test('cancels an oversized streamed response before waiting for its end', async () => {
  setGlobalDispatcher(previous);
  let closed = false;
  const server = createServer((_req, res) => {
    res.on('close', () => { closed = true; });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(' '.repeat(2 * 1024 * 1024 + 1));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await assert.rejects(solve(target, key, { baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 500 }), errorKind('invalid_response'));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(closed, true);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
