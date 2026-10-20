const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CodexBridge } = require('../src/bridge.cjs');
const { SettingsStore } = require('../src/storage.cjs');
const { mockProvider } = require('./mock-provider.cjs');
const binary = process.env.DESK_TEST_BINARY || path.join(__dirname, '..', 'runtime', 'codex', process.platform === 'win32' ? 'codex.exe' : 'codex');

test('real app-server: streamed API turn, shell file write, history, rename, branch, archive, restart', { skip: !fs.existsSync(binary), timeout: 60000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-integration-'));
  const provider = await mockProvider();
  const store = new SettingsStore(directory, { isEncryptionAvailable: () => false });
  store.save({ baseUrl: provider.url, model: 'desk-test-model', apiKey: 'test-key', rememberKey: false });
  store.addProject(directory); store.writeConfig();
  let bridge = new CodexBridge({ binary, home: store.codexHome, env: { CODEX_DESK_API_KEY: 'test-key' } });
  const events = [];
  try {
    await bridge.start();
    bridge.on('notification', (m) => events.push(m));
    bridge.on('request', (m) => bridge.respond(m.id, { decision: 'accept' }));
    const { thread } = await bridge.request('thread/start', { model: 'desk-test-model', modelProvider: 'desk_api', cwd: directory, approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    await bridge.request('thread/name/set', { threadId: thread.id, name: 'integration-probe' });
    const complete = new Promise((resolve) => {
      bridge.on('notification', (m) => { if (m.method === 'turn/completed') resolve(m.params.turn); });
    });
    await bridge.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'offline-tool-probe: run the test command in this project.', text_elements: [] }], effort: 'low' });
    const turn = await complete;
    assert.equal(turn.status, 'completed', JSON.stringify(turn.error));
    assert.equal(fs.readFileSync(path.join(directory, 'desk-probe.txt'), 'utf8'), 'desk-real-tool-ok');
    assert.ok(events.some((m) => m.method === 'item/agentMessage/delta'));
    assert.ok(events.some((m) => m.method === 'item/completed' && m.params.item.type === 'commandExecution'));
    const history = await bridge.request('thread/turns/list', { threadId: thread.id, itemsView: 'full' });
    assert.ok(history.data.some((t) => t.items.some((i) => i.type === 'agentMessage')));
    const fork = await bridge.request('thread/fork', { threadId: thread.id, excludeTurns: true });
    assert.notEqual(fork.thread.id, thread.id);
    await bridge.request('thread/archive', { threadId: fork.thread.id });
    assert.ok((await bridge.request('thread/list', { archived: true, modelProviders: [] })).data.some((t) => t.id === fork.thread.id));
    await bridge.request('thread/unarchive', { threadId: fork.thread.id });
    bridge.stop();
    bridge = new CodexBridge({ binary, home: store.codexHome, env: { CODEX_DESK_API_KEY: 'test-key' } });
    await bridge.start();
    const resumed = await bridge.request('thread/resume', { threadId: thread.id, excludeTurns: true });
    assert.equal(resumed.thread.name, 'integration-probe');
    const interrupted = new Promise((resolve) => {
      bridge.on('notification', (m) => { if (m.method === 'turn/completed') resolve(m.params.turn); });
    });
    const next = await bridge.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'offline-slow-probe', text_elements: [] }] });
    await provider.waitForRequest((body) => JSON.stringify(body.input).includes('offline-slow-probe'));
    await bridge.request('turn/interrupt', { threadId: thread.id, turnId: next.turn.id });
    assert.equal((await interrupted).status, 'interrupted');
    assert.ok(provider.seen.length >= 2);
  } finally { bridge.stop(); provider.server.closeAllConnections(); await new Promise((r) => provider.server.close(r)); }
});
