import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockAgent } from 'undici';
import { RayonClient, RayonError } from '../src/index.js';

const origin = 'https://api.rayonapi.com';
const source = 'https://example.com/page';
const shape = (extra: any = {}): any => ({source_url: source, scripts: [{url: source + '.js', source: '/* synthetic */'}], profile: {}, request: {url: source, method: 'GET', content_type: null, body: null}, ...extra});
const result = (extra: any = {}) => ({headers: Object.fromEntries([...'abcdfz'].map(s => [`X-Dynamic-${s}`, s === 'd' ? '' : 'value'])), request_id: 'req-synthetic', generation_ms: 1, profile_used: {}, material_ref: 'ref_0123456789abcdef', material_expires_at: new Date(Date.now()+60000).toISOString(), ...extra});
const miss = {error: {code: 'material_expired', billing_status: 'not_charged'}};
function setup() {
  const agent = new MockAgent(); agent.disableNetConnect();
  const client = new RayonClient('synthetic-key', {dispatcher: agent});
  const calls: any[] = [];
  function reply(value: any = result(), status = 200, delay = 0) {
    const pending = agent.get(origin).intercept({path: '/v1/shape', method: 'POST'}).reply(status, ({body}) => {
      calls.push(JSON.parse(body as string));
      return value;
    });
    if (delay > 0) pending.delay(delay);
  }
  return {agent, client, calls, reply};
}

for (const refOnly of [false, true]) test(`confirmed miss uploads retained source once, reference-only=${refOnly}`, async () => {
  const {agent, client, calls, reply} = setup();
  try {
    reply(); await client.generate(shape());
    reply(miss, 422); reply();
    const current = shape({document_cookie: 'current'});
    if (refOnly) { delete current.scripts; current.material_ref = 'ref_0123456789abcdef'; }
    await client.generate(current);
    assert.equal(calls.length, 3);
    assert.ok(calls[1].material_ref && !calls[1].scripts);
    assert.deepEqual(calls[2].scripts, shape().scripts);
    assert.equal(calls[2].document_cookie, 'current');
    assert.ok(!calls[2].material_ref);
  } finally { await client.close(); await agent.close(); }
});

for (const billing of [undefined, 'pending', 'unknown']) test(`material miss without confirmed nonbilling is never retried: ${billing}`, async () => {
  const {agent, client, calls, reply} = setup();
  try {
    reply(); await client.generate(shape());
    reply({error: {code: 'material_expired', billing_status: billing}}, 422);
    await assert.rejects(client.generate(shape()), RayonError);
    assert.equal(calls.length, 2);
  } finally { await client.close(); await agent.close(); }
});

test('recovery is limited to one upload attempt', async () => {
  const {agent, client, calls, reply} = setup();
  try {
    reply(); await client.generate(shape()); reply(miss, 422); reply(miss, 422);
    await assert.rejects(client.generate(shape()), RayonError);
    assert.equal(calls.length, 3);
  } finally { await client.close(); await agent.close(); }
});

test('refreshes near expiry without background generation', async () => {
  const {agent, client, calls, reply} = setup();
  try {
    reply(result({material_expires_at: new Date(Date.now()+3000).toISOString()})); reply();
    await client.generate(shape()); await client.generate(shape());
    assert.ok(calls.every(body => body.scripts));
  } finally { await client.close(); await agent.close(); }
});

test('simultaneous material establishment uploads once and preserves each generation', async () => {
  const {agent, client, calls, reply} = setup();
  try {
    reply(result(), 200, 40);
    for (let i=0;i<7;i++) reply();
    await Promise.all(Array.from({length: 8}, (_,i) => client.generate(shape({document_cookie: String(i)}))));
    assert.equal(calls.length, 8);
    assert.equal(calls.filter(body => body.scripts).length, 1);
    assert.equal(new Set(calls.map(body => body.document_cookie)).size, 8);
  } finally { await client.close(); await agent.close(); }
});

test('canceling a waiting caller does not cancel material establishment', async () => {
  const {agent, client, calls, reply} = setup();
  try {
    reply(result(), 200, 50); reply();
    const leader = client.generate(shape());
    const control = new AbortController();
    const waiter = client.generate(shape(), {signal: control.signal});
    const survivor = client.generate(shape());
    control.abort();
    await assert.rejects(waiter, (error: any) => error.kind === 'aborted');
    await Promise.all([leader, survivor]);
    assert.equal(calls.length, 2);
    assert.equal(calls.filter(body => body.scripts).length, 1);
  } finally { await client.close(); await agent.close(); }
});

test('failed material establishment does not issue queued generations', async () => {
  const {agent, client, calls, reply} = setup();
  try {
    reply({error: {code: 'generation_failed'}}, 500, 40);
    const settled = await Promise.allSettled([client.generate(shape()), client.generate(shape())]);
    assert.ok(settled.every(value => value.status === 'rejected'));
    assert.equal(calls.length, 1);
  } finally { await client.close(); await agent.close(); }
});

test('byte budget eviction does not recover with discarded source', async () => {
  const {agent, client, calls, reply} = setup();
  try {
    for (let i=0;i<18;i++) {
      reply(result({material_ref: `ref_${String(i).padStart(16, '0')}`}));
      await client.generate(shape({scripts: [{url: source + '.js', source: 'x'.repeat(1024*1024)+String(i)}]}));
    }
    reply(miss, 422);
    const current = shape(); delete current.scripts; current.material_ref = 'ref_0000000000000000';
    await assert.rejects(client.generate(current), RayonError);
    assert.equal(calls.length, 19);
  } finally { await client.close(); await agent.close(); }
});

test('material recovery shares the original overall deadline', async () => {
  const agent = new MockAgent(); agent.disableNetConnect();
  const client = new RayonClient('synthetic-key', {dispatcher: agent, timeoutMs: 80});
  try {
    const pool = agent.get(origin);
    pool.intercept({path: '/v1/shape', method: 'POST'}).reply(200, result());
    await client.generate(shape());
    pool.intercept({path: '/v1/shape', method: 'POST'}).reply(422, miss).delay(50);
    pool.intercept({path: '/v1/shape', method: 'POST'}).reply(200, result()).delay(50);
    await assert.rejects(client.generate(shape()), (error: any) => error.kind === 'timeout');
  } finally { await client.close(); await agent.close(); }
});

test('waiting for material and sending share the original overall deadline', async () => {
  const agent = new MockAgent(); agent.disableNetConnect();
  const client = new RayonClient('synthetic-key', {dispatcher: agent, timeoutMs: 80});
  try {
    const pool = agent.get(origin);
    pool.intercept({path: '/v1/shape', method: 'POST'}).reply(200, result()).delay(50);
    pool.intercept({path: '/v1/shape', method: 'POST'}).reply(200, result()).delay(50);
    const leader = client.generate(shape());
    const waiter = client.generate(shape());
    await assert.rejects(waiter, (error: any) => error.kind === 'timeout');
    await leader;
  } finally { await client.close(); await agent.close(); }
});

test('clock rollback cannot extend the generation recovery deadline', async () => {
  const agent = new MockAgent(); agent.disableNetConnect();
  const client = new RayonClient('synthetic-key', {dispatcher: agent, timeoutMs: 80});
  const originalNow = Date.now;
  let rolledBack = false;
  Date.now = () => originalNow() - (rolledBack ? 60000 : 0);
  try {
    const pool = agent.get(origin);
    pool.intercept({path: '/v1/shape', method: 'POST'}).reply(200, result());
    await client.generate(shape());
    pool.intercept({path: '/v1/shape', method: 'POST'}).reply(422, () => {
      rolledBack = true;
      return miss;
    }).delay(50);
    pool.intercept({path: '/v1/shape', method: 'POST'}).reply(200, result()).delay(50);
    await assert.rejects(client.generate(shape()), (error: any) => error.kind === 'timeout');
  } finally {
    Date.now = originalNow;
    await client.close();
    await agent.close();
  }
});
