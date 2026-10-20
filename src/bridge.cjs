const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { EventEmitter } = require('node:events');
const path = require('node:path');

class CodexBridge extends EventEmitter {
  constructor({ binary, home, env = {}, cwd, spawnProcess = spawn }) {
    super();
    Object.assign(this, { binary, home, env, cwd, spawnProcess });
    this.sequence = 0;
    this.pending = new Map();
    this.approvals = new Map();
    this.ready = false;
  }

  async start() {
    const childEnv = { ...process.env };
    // Never inherit the official client's authentication or endpoint overrides.
    for (const key of Object.keys(childEnv)) {
      if (/^(CODEX|OPENAI|CHATGPT|SKY_CUA|NODE_REPL)/i.test(key)) delete childEnv[key];
    }
    Object.assign(childEnv, this.env, { CODEX_HOME: this.home });
    if (process.platform === 'darwin') {
      childEnv.PATH = [...new Set([path.dirname(this.binary), '/opt/homebrew/bin', '/usr/local/bin', ...(childEnv.PATH || '').split(path.delimiter), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].filter(Boolean).join(path.delimiter);
    }
    this.child = this.spawnProcess(this.binary, ['app-server', '--listen', 'stdio://'], {
      cwd: this.cwd || this.home, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code, signal) => {
      this.fail(new Error(`Codex 进程已结束 (${signal || code})`));
      this.emit('exit', { code, signal });
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      this.receive(message);
    });
    this.child.stderr.on('data', (data) => this.emit('diagnostic', data.toString()));
    const result = await this.request('initialize', {
      clientInfo: { name: 'codex_desk', title: 'Codex Desk', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized', params: {} });
    this.ready = true;
    return result;
  }

  receive(message) {
    if (message.method) {
      if (message.id !== undefined) {
        this.approvals.set(String(message.id), message);
        this.emit('request', message);
      } else {
        if (message.method === 'serverRequest/resolved') this.approvals.delete(String(message.params.requestId));
        this.emit('notification', message);
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else pending.resolve(message.result);
  }

  send(message) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) throw new Error('Codex 尚未连接');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params = {}, timeout = 60000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 等待超时，请重连后再试`));
      }, timeout) : null;
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  respond(id, result) {
    const original = this.approvals.get(String(id));
    if (!original) throw new Error('这个请求已经结束');
    this.send({ id: original.id, result });
    this.approvals.delete(String(id));
  }

  fail(error) {
    this.ready = false;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
    this.approvals.clear();
  }

  stop() {
    this.fail(new Error('连接已关闭'));
    if (this.child && !this.child.killed) this.child.kill();
    this.child = null;
  }
}

module.exports = { CodexBridge };
