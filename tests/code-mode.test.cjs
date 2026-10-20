const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TOML = require('@iarna/toml');
const { CodexBridge } = require('../src/bridge.cjs');
const { SettingsStore } = require('../src/storage.cjs');
const { mockProvider } = require('./mock-provider.cjs');
const binary = process.env.DESK_TEST_BINARY || path.join(__dirname, '..', 'runtime', 'codex', process.platform === 'win32' ? 'codex.exe' : 'codex');

test('bundled 6.1 Code Mode executes a real command and returns file contents', { skip: !fs.existsSync(binary), timeout: 45000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-code-mode-'));
  const provider = await mockProvider();
  const store = new SettingsStore(directory, { isEncryptionAvailable: () => false });
  store.save({ baseUrl: provider.url, model: 'gpt-6.1-sol' });
  store.writeConfig();
  const configFile = path.join(store.codexHome, 'config.toml');
  const config = TOML.parse(fs.readFileSync(configFile, 'utf8'));
  config.features.code_mode = true;
  fs.writeFileSync(configFile, TOML.stringify(config));
  const bridge = new CodexBridge({ binary, home: store.codexHome, env: { CODEX_DESK_API_KEY: 'offline-test-key' } });
  try {
    await bridge.start();
    if (process.platform === 'darwin') {
      const result = await bridge.request('command/exec', { command: ['/bin/sh', '-c', 'rg --version'], cwd: directory });
      assert.equal(result.exitCode, 0, 'desktop runtime cannot find rg');
      assert.match(result.stdout, /ripgrep/);
    }
    const { thread } = await bridge.request('thread/start', { model: 'gpt-6.1-sol', modelProvider: 'desk_api', cwd: directory, sandbox: 'read-only', approvalPolicy: 'never' });
    // Match the user's existing full-access turn without changing their saved permissions.
    const completed = new Promise(resolve => bridge.on('notification', m => {
      if (m.method === 'turn/completed' && m.params.threadId === thread.id) resolve(m.params.turn);
    }));
    await bridge.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'offline-tool-probe', text_elements: [] }], effort: 'low', sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never' });
    assert.equal((await completed).status, 'completed');
    assert.ok(provider.seen.some(body => (body.input || []).some(i => i.type === 'additional_tools' && JSON.stringify(i.tools).includes('"name":"exec"'))), 'test did not exercise Code Mode');
    assert.equal(fs.readFileSync(path.join(directory, 'desk-probe.txt'), 'utf8'), 'desk-real-tool-ok');
    const outputs = provider.seen.flatMap(body => body.input || []).filter(i => i.type === 'custom_tool_call_output');
    assert.ok(outputs.some(i => JSON.stringify(i.output).includes('desk-real-tool-ok')), 'actual command output was not returned to the model');
  } finally {
    bridge.stop(); provider.server.closeAllConnections(); await new Promise(resolve => provider.server.close(resolve));
  }
});
