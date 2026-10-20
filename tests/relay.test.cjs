const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { RelayAdapter, compatibleRequest } = require('../src/relay.cjs');

test('relay compatibility preserves messages, images and tool calls while omitting opaque reasoning', () => {
  const input = [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,fixture' }] }, { type: 'reasoning', encrypted_content: 'opaque-history' }, { type: 'custom_tool_call', call_id: 'c1', input: 'text(1)' }, { type: 'custom_tool_call_output', call_id: 'c1', output: '1' }];
  const original = { model: 'gpt-6.1-sol', reasoning: { effort: 'high' }, input, include: ['reasoning.encrypted_content', 'web_search_call.action.sources'] };
  const result = compatibleRequest(original);
  assert.deepEqual(result.input, [input[0], input[2], input[3]]);
  assert.deepEqual(result.reasoning, { effort: 'high' });
  assert.deepEqual(result.include, original.include);
  assert.equal(original.input.length, 4);
  assert.deepEqual(compatibleRequest({ include: ['reasoning.encrypted_content'] }).include, ['reasoning.encrypted_content']);
});

test('loopback adapter authenticates, decodes compressed bodies and streams upstream errors unchanged', async () => {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    seen.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks)), auth: req.headers.authorization, encoding: req.headers['content-encoding'] });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-request' });
    res.write('data: {"type":"response.created"}\n\n');
    res.end('data: {"type":"error","error":{"message":"upstream overload"}}\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const adapter = new RelayAdapter({ baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, key: 'fixture-key' });
  try {
    const base = await adapter.start();
    const denied = await fetch(base + '/responses', { method: 'POST', body: '{}' });
    assert.equal(denied.status, 401); assert.equal(seen.length, 0);
    assert.equal((await fetch(base + '/not-allowed', { method: 'POST' })).status, 404);
    const body = { input: [{ type: 'reasoning', encrypted_content: 'old' }, { type: 'message', role: 'user', content: 'hello' }], include: ['reasoning.encrypted_content'] };
    const response = await fetch(base + '/responses', { method: 'POST', headers: { authorization: 'Bearer fixture-key', 'content-encoding': 'gzip' }, body: zlib.gzipSync(JSON.stringify(body)) });
    assert.equal(response.status, 200); assert.equal(response.headers.get('x-request-id'), 'fixture-request');
    assert.match(await response.text(), /upstream overload/);
    assert.deepEqual(seen[0].body.input, [body.input[1]]);
    assert.equal(seen[0].auth, 'Bearer fixture-key'); assert.equal(seen[0].encoding, undefined);
    assert.equal(seen[0].url, '/v1/responses');
  } finally { adapter.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});

test('adapter failures do not disclose upstream errors or credentials', async () => {
  const adapter = new RelayAdapter({ baseUrl: 'http://unused.invalid/v1', key: 'fixture-secret', fetchImpl: async () => { throw Error('fixture-secret private upstream details'); } });
  try {
    const base = await adapter.start();
    const response = await fetch(base + '/responses', { method: 'POST', headers: { authorization: 'Bearer fixture-secret' }, body: '{"input":[]}' });
    assert.equal(response.status, 502);
    const text = await response.text(); assert.ok(!text.includes('fixture-secret')); assert.ok(!text.includes('private upstream'));
  } finally { adapter.stop(); }
});
