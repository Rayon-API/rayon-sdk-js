import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createServer } from 'node:http';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { RayonError, solve } from '../src/index.js';

const target = 'https://example.com/product';
const key = 'test-secret-key';
const origin = 'https://api.rayonapi.com';
const previousDispatcher = getGlobalDispatcher();
let mock: MockAgent;

function accepted(prefix = 'X-Variable9') {
  return {
    status: 'accepted', method: 'v8_sandbox', target_url: target, duration_ms: 52,
    headers: Object.fromEntries(['a', 'b', 'c', 'd', 'f', 'z'].map(s => [`${prefix}-${s}`, s === 'd' ? '' : `value-${s}`])),
    cookies: [{ name: 'session', value: 'value', domain: '.example.com', path: '/product' }],
    profile_used: { locale: 'en-GB', screen: { width: 1920 } }, errors: [],
  };
}
function reply(body: unknown, status = 200, headers = {}) {
  return mock.get(origin).intercept({ path: '/solve', method: 'POST' }).reply(status, body, { headers });
}
function expectError(kind: string, statusCode?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof RayonError);
    assert.equal(error.kind, kind);
    assert.equal(error.statusCode, statusCode);
    assert.ok(!JSON.stringify(error).includes(key));
    assert.ok(!error.message.includes(key));
    return true;
  };
}
beforeEach(() => { mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock); });
afterEach(async () => { setGlobalDispatcher(previousDispatcher); await mock.close(); });

test('posts only target_url and optional profile with Bearer authentication', async () => {
  mock.get(origin).intercept({ path: '/solve', method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ target_url: target, profile: { locale: 'en-GB' } }) }).reply(200, accepted());
  const result = await solve(target, key, { profile: { locale: 'en-GB' } });
  assert.equal(result.target_url, target);
  assert.equal(result.duration_ms, 52);
  assert.equal(result.method, 'v8_sandbox');
  assert.equal(Object.keys(result.headers).length, 6);
  assert.deepEqual(result.cookies, accepted().cookies);
  assert.equal(Object.getPrototypeOf(result.headers), null);
  assert.equal(Object.getPrototypeOf(result.profile_used), null);
  assert.equal(Object.getPrototypeOf(result.profile_used.screen), null);
  mock.assertNoPendingInterceptors();
});
test('omits profile when absent and accepts empty d header and fallback diagnostics', async () => {
  const body = { ...accepted(), method: 'playwright', errors: ['Earlier capture tier failed'] };
  mock.get(origin).intercept({ path: '/solve', method: 'POST', body: JSON.stringify({ target_url: target }) }).reply(200, body);
  const result = await solve(target, key);
  assert.equal(result.headers['X-Variable9-d'], '');
  assert.deepEqual(result.errors, body.errors);
  assert.equal(result.method, 'playwright');
});
for (const url of ['garbage', 'ftp://example.com', 'https://user:pass@example.com', ' https://example.com', 'https://']) {
  test(`rejects invalid target URL ${url}`, async () => { await assert.rejects(solve(url, key), expectError('validation')); });
}
for (const apiKey of ['', ' ', ' key', 'key\n', 'key\u0000']) {
  test('rejects an empty or malformed API key before transport', async () => { await assert.rejects(solve(target, apiKey), expectError('validation')); });
}
for (const timeoutMs of [0, -1, NaN, Infinity, 0.5, 2_147_483_648]) {
  test(`rejects invalid timeout ${timeoutMs}`, async () => { await assert.rejects(solve(target, key, { timeoutMs }), expectError('validation')); });
}
for (const baseUrl of ['ftp://example.com', 'https://user:pass@example.com', 'https://example.com?key=1', 'https://example.com/#hash', 'http://remote.example.com']) {
  test('rejects an unsafe base URL', async () => { await assert.rejects(solve(target, key, { baseUrl }), expectError('validation')); });
}
test('supports a custom API path without adding options to the payload', async () => {
  mock.get('https://custom.example.com').intercept({ path: '/v1/solve', method: 'POST', body: JSON.stringify({ target_url: target }) }).reply(200, accepted());
  assert.equal((await solve(target, key, { baseUrl: 'https://custom.example.com/v1/', timeoutMs: 1000 })).status, 'accepted');
});
for (const [statusCode, kind] of [[401, 'auth'], [403, 'auth'], [422, 'http'], [429, 'rate_limit'], [503, 'http']] as const) {
  test(`handles HTTP ${statusCode} with safe metadata without retrying`, async () => {
    reply({ detail: `private body ${key}` }, statusCode, { 'x-request-id': 'req-123', 'retry-after': '42' });
    await assert.rejects(solve(target, key), error => {
      expectError(kind, statusCode)(error);
      assert.equal((error as RayonError).requestId, 'req-123');
      assert.equal((error as RayonError).retryAfter, '42');
      assert.ok(!(error as Error).message.includes('private body'));
      assert.equal((error as Error).cause, undefined);
      return true;
    });
    mock.assertNoPendingInterceptors();
  });
}
test('does not follow redirects or forward the API key', async () => {
  reply('', 307, { location: 'https://redirect.example.com/solve' });
  await assert.rejects(solve(target, key), expectError('http', 307));
});
test('drops unsafe diagnostic response headers', async () => {
  reply('private body', 429, { 'x-request-id': key, 'retry-after': key });
  await assert.rejects(solve(target, key), error => {
    expectError('rate_limit', 429)(error);
    assert.equal((error as RayonError).requestId, undefined);
    assert.equal((error as RayonError).retryAfter, undefined);
    return true;
  });
});
for (const status of ['failed', 'rejected']) {
  test(`throws for HTTP 200 ${status} capture results`, async () => {
    reply({ ...accepted(), status, headers: {}, errors: [`private ${key}`] });
    await assert.rejects(solve(target, key), expectError('capture', 200));
  });
}
test('rejects malformed JSON without exposing raw content', async () => {
  reply(`not JSON ${key}`);
  await assert.rejects(solve(target, key), expectError('invalid_response', 200));
});
const malformed: [string, (body: ReturnType<typeof accepted>) => unknown][] = [
  ['missing header', b => { delete b.headers['X-Variable9-a']; return b; }],
  ['extra header', b => { b.headers.extra = 'x'; return b; }],
  ['mixed prefix', b => { b.headers['Other-z'] = b.headers['X-Variable9-z']; delete b.headers['X-Variable9-z']; return b; }],
  ['empty a', b => { b.headers['X-Variable9-a'] = ''; return b; }],
  ['invalid method', b => ({ ...b, method: 'unknown' })],
  ['invalid status', b => ({ ...b, status: 'ok' })],
  ['negative duration', b => ({ ...b, duration_ms: -1 })],
  ['fractional duration', b => ({ ...b, duration_ms: 1.5 })],
  ['missing cookie domain', b => ({ ...b, cookies: [{ name: 'session', value: 'x', path: '/' }] })],
  ['bad cookies', b => ({ ...b, cookies: {} })],
  ['bad profile', b => ({ ...b, profile_used: [] })],
  ['bad errors', b => ({ ...b, errors: [1] })],
  ['bad target', b => ({ ...b, target_url: 'invalid' })],
  ['different target', b => ({ ...b, target_url: 'https://other.example.com' })],
  ['prototype header', b => ({ ...b, headers: JSON.parse('{"__proto__":"unsafe"}') })],
  ['nested prototype profile', b => ({ ...b, profile_used: JSON.parse('{"nested":{"constructor":{"prototype":{"unsafe":true}}}}') })],
];
for (const [name, change] of malformed) {
  test(`rejects malformed response: ${name}`, async () => {
    reply(change(accepted()));
    await assert.rejects(solve(target, key), expectError('invalid_response', 200));
  });
}
test('rejects unsafe caller profiles before transport', async () => {
  await assert.rejects(solve(target, key, { profile: JSON.parse('{"__proto__":{"unsafe":true}}') }), expectError('validation'));
});
test('reports network failures without preserving unsafe transport messages', async () => {
  mock.get(origin).intercept({ path: '/solve', method: 'POST' }).replyWithError(new Error(key));
  await assert.rejects(solve(target, key), expectError('network'));
});
test('aborts the whole request when the timeout elapses', async () => {
  reply(accepted()).delay(150);
  const started = Date.now();
  await assert.rejects(solve(target, key, { timeoutMs: 20 }), expectError('timeout'));
  assert.ok(Date.now() - started < 140);
});
test('aborts while consuming a slow response body using localhost only', async () => {
  setGlobalDispatcher(previousDispatcher);
  let closed = false;
  const server = createServer((_req, res) => {
    res.on('close', () => { closed = true; });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await assert.rejects(solve(target, key, { baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 250 }), expectError('timeout', 200));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(closed, true);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('preserves safe future cookie fields without inventing attributes', async () => {
  const body = { ...accepted(), cookies: [{ ...accepted().cookies[0], future_flag: true }] };
  reply(body);
  const result = await solve(target, key);
  assert.equal(result.cookies[0].future_flag, true);
  assert.equal(Object.hasOwn(result.cookies[0], 'secure'), false);
  assert.equal(Object.hasOwn(result.cookies[0], 'expires'), false);
});
