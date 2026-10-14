import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { MockAgent } from 'undici';
import { RayonClient, RayonError } from '../src/index.js';
import { validateShape } from '../src/validation.js';
import { parseResult } from '../src/response.js';
const key = 'test-secret-key';
function shape(): any {
  return {
    source_url: 'https://example.com/page', scripts: [{ url: 'https://example.com/owned.js', source: '/* owned */' }],
    profile: {}, mode: 'form', form: { id: 'checkout', name: 'checkout' },
    request: { url: 'https://example.com/submit', method: 'POST', content_type: 'application/x-www-form-urlencoded; charset=UTF-8', body: 'tag=one&tag=two&csrf=a%2Bb&empty=' },
  };
}
function result(): any {
  const fields = Object.fromEntries([...'zafbdc'].map(s => [`ExactBase${s}`, s === 'd' ? '' : 'opaque +/é~'])); return {
    form_fields: fields, form_body: new URLSearchParams(fields).toString(), request_id: 'req-123', generation_ms: 12, profile_used: {},
    material_ref: 'ref_0123456789abcdef', material_expires_at: new Date(Date.now() + 60000).toISOString(),
  };
}
const kind = (expected: string) => (error: unknown) => { assert.ok(error instanceof RayonError); assert.equal(error.kind, expected); assert.ok(!inspect(error).includes('opaque')); return true; };
test('form generation preserves field case, order, encoding and application state', async () => {
  const mock = new MockAgent(); mock.disableNetConnect(); const body = shape(), response = result();
  mock.get('https://api.rayonapi.com').intercept({ path: '/v1/shape', method: 'POST', body: JSON.stringify(body) }).reply(200, response);
  const client = new RayonClient(key, { dispatcher: mock });
  try { const generated: any = await client.generate(body); assert.deepEqual(Object.entries(generated.form_fields), Object.entries(response.form_fields)); assert.equal(generated.form_body, response.form_body); assert.ok(!('headers' in generated)); assert.ok(!inspect(generated).includes('opaque')); }
  finally { await client.close(); await mock.close(); }
});
test('empty form body is valid', () => { const value = shape(); value.request.body = ''; assert.equal(JSON.stringify(validateShape(value)), JSON.stringify(value)); });
for (const mutation of [{ mode: 'other' }, { mode: null }, { mode: 'header' }, { form: { id: 'bad\n' } }, { form: { html: '<form>' } }]) test(`invalid form metadata ${JSON.stringify(mutation)}`, () => {
  assert.throws(() => validateShape({ ...shape(), ...mutation }), kind('validation'));
});
for (const changes of [{ method: 'GET' }, { content_type: 'application/json' }, { content_type: 'application/x-www-form-urlencoded; charset=latin1' }, { body: null }, { body: 'a=%' }, { body: 'a=%GG' }, { body: 'a=%FF' }, { body: 'a=%00' }, { body: [...'abcdfz'].map(s => `Base${s}=old`).join('&') }]) test(`invalid form request ${JSON.stringify(changes)}`, () => {
  const value = shape(); Object.assign(value.request, changes); assert.throws(() => validateShape(value), kind('validation'));
});
for (const changes of [{ form_body: 'inconsistent=x' }, { headers: {} }, { form_fields: Object.fromEntries([...'abcdf'].map(s => [`Base${s}`, 'x'])) }, { form_fields: Object.fromEntries([...'abcdfZ'].map(s => [`Base${s}`, 'x'])) }, { form_fields: { ...Object.fromEntries([...'abcdf'].map(s => [`Base${s}`, 'x'])), Otherz: 'x' } }, { form_fields: Object.fromEntries([...'abcdfz'].map(s => [`Base${s}`, '\n'])) }]) test(`invalid form result ${JSON.stringify(changes)}`, () => {
  assert.throws(() => parseResult({ ...result(), ...changes }, {}, key, 'form'), kind('invalid_response'));
});
test('transport mismatches are rejected', () => {
  assert.throws(() => parseResult(result(), {}, key), kind('invalid_response'));
  assert.throws(() => parseResult({ ...result(), headers: {} }, {}, key, 'form'), kind('invalid_response'));
});

for (const body of ['x=' + 'a'.repeat(262144), Array(1025).fill('x=1').join('&'), 'é'.repeat(129) + '=x', 'x=\ud800']) test('bounds application pairs, keys, bytes and UTF8', () => {
  const value = shape(); value.request.body = body; assert.throws(() => validateShape(value), kind('validation'));
});
test('application duplicates, newlines and partial families survive', () => {
  const value = shape(); value.request.body = 'tag=1&tag=2&notes=line%0Aline%0D%09&Basea=application&basez=application';
  assert.equal(JSON.stringify(validateShape(value)), JSON.stringify(value));
});
for (const fields of [
  { ...Object.fromEntries([...'abcdf'].map(s => [`Base${s}`, 'x'])), basez: 'x' },
  { ...Object.fromEntries([...'abcdf'].map(s => [`Base${s}`, 'x'])), Baseaa: 'x' },
  Object.fromEntries([...'abcdfz'].map(s => ['x'.repeat(129) + s, 'x'])),
  Object.fromEntries([...'abcdfz'].map(s => [`Base${s}`, 'x'.repeat(16385)])),
  Object.fromEntries([...'abcdfz'].map(s => [`Base${s}`, ''])),
]) test('bounds exact-case form family and values', () => { assert.throws(() => parseResult({ ...result(), form_fields: fields }, {}, key, 'form'), kind('invalid_response')); });

test('form cache reuses material while retaining fresh mode and application state', async () => {
  const mock = new MockAgent(); mock.disableNetConnect();
  const first = shape(), next = shape(); next.request.body = 'tag=fresh&csrf=current'; next.document_cookie = 'current';
  mock.get('https://api.rayonapi.com').intercept({ path: '/v1/shape', method: 'POST', body: JSON.stringify(first) }).reply(200, result());
  const cached = { ...next, material_ref: 'ref_0123456789abcdef' }; delete cached.scripts;
  mock.get('https://api.rayonapi.com').intercept({ path: '/v1/shape', method: 'POST', body: JSON.stringify(cached) }).reply(200, result());
  const client = new RayonClient(key, { dispatcher: mock });
  try { await client.generate(first); await client.generate(next); mock.assertNoPendingInterceptors(); assert.ok(next.scripts); }
  finally { await client.close(); await mock.close(); }
});

test('form response uses strict UTF8 on the wire', async () => {
  const mock = new MockAgent(); mock.disableNetConnect();
  const value = result(); value.form_fields.ExactBasea = '�'; value.form_body = new URLSearchParams(value.form_fields).toString();
  const valid = Buffer.from(JSON.stringify(value));
  const position = valid.indexOf(Buffer.from('�'));
  const invalid = Buffer.concat([valid.subarray(0, position), Buffer.from([0xff]), valid.subarray(position + 3)]);
  mock.get('https://api.rayonapi.com').intercept({ path: '/v1/shape', method: 'POST' }).reply(200, invalid);
  const client = new RayonClient(key, { dispatcher: mock });
  try { await assert.rejects(client.generate(shape()), kind('invalid_response')); }
  finally { await client.close(); await mock.close(); }
});

test('form field names must end exactly at the suffix', () => {
  const value = result(), fields = value.form_fields;
  fields['ExactBasea\n'] = fields.ExactBasea; delete fields.ExactBasea;
  value.form_body = new URLSearchParams(fields).toString();
  assert.throws(() => parseResult(value, {}, key, 'form'), kind('invalid_response'));
});


test('form keeps exactly six fields with a larger a value', () => {
  const value = result();
  value.form_fields.ExactBasea = 'x'.repeat(16384);
  value.form_body = new URLSearchParams(value.form_fields).toString();
  const output = parseResult(value, {}, key, 'form');
  assert.ok('form_fields' in output);
  assert.equal(Object.keys(output.form_fields).length, 6);
  assert.equal(output.form_fields.ExactBasea, 'x'.repeat(16384));
  value.form_fields.ExactBasea0 = 'supplement';
  value.form_body = new URLSearchParams(value.form_fields).toString();
  assert.throws(() => parseResult(value, {}, key, 'form'), kind('invalid_response'));
});
