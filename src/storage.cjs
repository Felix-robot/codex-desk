const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const TOML = require('@iarna/toml');

const defaults = {
  baseUrl: 'https://api.example.com/v1', model: 'gpt-6.1-sol', effort: 'high',
  binary: '', projects: [], projectNames: {}, threadProjects: {}, theme: 'light', permission: 'workspace', fontSize: 18,
  notifications: false, background: false,
  relayCompatibility: false,
  instructions: '默认使用中文。表达简洁，先说明结果。修改文件前理解项目约定，完成后验证相关改动。',
};

function normalizeSettings(input, previous = defaults) {
  const next = { ...previous };
  for (const key of ['baseUrl', 'model', 'binary', 'instructions']) {
    if (typeof input[key] === 'string') next[key] = input[key].trim();
  }
  const url = new URL(next.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('API 地址需要是完整的 http:// 或 https:// 地址，不能包含账号或查询参数');
  }
  next.baseUrl = next.baseUrl.replace(/\/+$/, '');
  if (!next.model || next.model.length > 200) throw new Error('请填写模型名称');
  if (input.effort && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(input.effort)) next.effort = input.effort;
  if (input.theme && ['light', 'dark', 'system'].includes(input.theme)) next.theme = input.theme;
  if (input.fontSize !== undefined) {
    const size = Number(input.fontSize);
    if (Number.isFinite(size) && size >= 14 && size <= 28) next.fontSize = Math.round(size);
  }
  if (input.permission && ['readonly', 'workspace', 'full'].includes(input.permission)) next.permission = input.permission;
  if (typeof input.useRelayEnv === 'boolean') next.useRelayEnv = input.useRelayEnv;
  for (const field of ['background', 'notifications', 'relayCompatibility']) if (typeof input[field] === 'boolean') next[field] = input[field];
  for (const field of ['projectNames','threadProjects']) {
    if (input[field] && typeof input[field] === 'object' && !Array.isArray(input[field])) next[field] = Object.fromEntries(Object.entries(input[field]).filter(([key,value]) => key.length < 2000 && typeof value === 'string' && value.length < 2000));
  }
  return next;
}

function writePrivate(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

class SettingsStore {
  constructor(directory, encryption, options = {}) {
    this.directory = directory;
    this.encryption = encryption;
    this.file = path.join(directory, 'settings.json');
    this.secretFile = path.join(directory, 'credential.bin');
    this.relayEnvFile = options.relayEnvFile || path.join(os.homedir(), '.codex', '.env');
    this.codexHome = options.codexHome || path.join(directory, 'codex');
    if (options.codexHome && path.resolve(options.codexHome).toLowerCase() === path.resolve(os.homedir(), '.codex').toLowerCase()) throw new Error('不能使用官方 Codex 的配置目录');
    this.settings = { ...defaults, projects: [], projectNames: {}, threadProjects: {} };
    fs.mkdirSync(this.codexHome, { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.file)) this.settings = normalizeSettings(JSON.parse(fs.readFileSync(this.file, 'utf8')), this.settings);
    // Projects are only ever added by the native folder picker.
    if (fs.existsSync(this.file)) this.settings.projects = JSON.parse(fs.readFileSync(this.file, 'utf8')).projects || [];
    this.sessionKey = '';
  }
  readKey() {
    if (this.sessionKey) return this.sessionKey;
    if (!fs.existsSync(this.secretFile)) {
      if (this.settings.useRelayEnv) {
        const file = this.relayEnvFile;
        if (!fs.existsSync(file)) return '';
        return fs.readFileSync(file, 'utf8').match(/^SUB2API_API_KEY=(sk-[^\r\n]+)\r?$/m)?.[1] || '';
      }
      return '';
    }
    if (!this.encryption.isEncryptionAvailable()) throw new Error('系统密钥存储不可用，请重新填写 key，仅用于本次会话');
    return this.encryption.decryptString(fs.readFileSync(this.secretFile));
  }
  save(input) {
    const next = normalizeSettings(input, this.settings);
    if (input.apiKey !== undefined && input.apiKey !== '') {
      const key = input.apiKey.trim();
      if (/[\r\n\0]/.test(key)) throw new Error('API key 包含无效字符');
      if (input.rememberKey !== false && this.encryption.isEncryptionAvailable()) {
        writePrivate(this.secretFile, this.encryption.encryptString(key));
        this.sessionKey = '';
      } else {
        this.sessionKey = key;
        if (fs.existsSync(this.secretFile)) fs.unlinkSync(this.secretFile);
      }
    }
    if (input.clearKey) {
      next.useRelayEnv = false;
      this.sessionKey = '';
      if (fs.existsSync(this.secretFile)) fs.unlinkSync(this.secretFile);
    }
    writePrivate(this.file, JSON.stringify(next, null, 2));
    this.settings = next;
    return this.public();
  }
  public() {
    let hasKey = false;
    try { hasKey = !!this.readKey(); } catch {}
    return { ...this.settings, hasKey, keySource: this.settings.useRelayEnv && !fs.existsSync(this.secretFile) ? 'relay-env' : 'encrypted', dataDirectory: this.directory,
      encryptedStorage: this.settings.useRelayEnv && !fs.existsSync(this.secretFile) ? null : this.encryption.isEncryptionAvailable() };
  }
  addProject(directory) {
    const real = fs.realpathSync(directory);
    if (!fs.statSync(real).isDirectory()) throw new Error('请选择文件夹');
    this.settings.projects = [real, ...this.settings.projects.filter((p) => p !== real)];
    this.save({});
    return real;
  }
  renameProject(directory, name) {
    if (!this.settings.projects.includes(directory)) throw new Error('项目未登记');
    const label = String(name || '').replace(/[\r\n]/g, ' ').trim();
    if (!label || label.length > 80) throw new Error('项目名需要1–80个字符');
    return this.save({ projectNames: { ...this.settings.projectNames, [directory]: label } });
  }
  assignProject(threadId, directory) {
    if (!this.settings.projects.includes(directory)) throw new Error('项目未登记');
    return this.save({ threadProjects: { ...this.settings.threadProjects, [threadId]: directory } });
  }
  writeConfig() {
    const advancedFile = path.join(this.directory, 'extensions.toml');
    let extensions = {};
    if (fs.existsSync(advancedFile)) extensions = TOML.parse(fs.readFileSync(advancedFile, 'utf8'));
    // Only tool configuration can enter through the extensions editor.
    const config = {};
    for (const key of ['mcp_servers', 'skills']) if (extensions[key]) config[key] = extensions[key];
    Object.assign(config, {
      model_provider: this.providerId, model: this.settings.model,
      model_reasoning_effort: this.settings.effort,
      cli_auth_credentials_store: 'file', web_search: 'live',
      model_providers: { [this.providerId]: { name: this.providerId === 'sub2api' ? 'Sub2API 中转' : 'Desk API', base_url: this.settings.baseUrl,
        env_key: this.envKey, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false } },
      features: { multi_agent: true, goals: true },
      sandbox_mode: 'workspace-write', approval_policy: 'on-request',
      sandbox_workspace_write: { network_access: true },
      shell_environment_policy: { exclude: [this.envKey, ...(this.envKey === 'SUB2API_API_KEY' ? ['CODEX_DESK_API_KEY','OPENAI_API_KEY','CODEX_API_KEY'] : [])] },
      analytics: { enabled: false },
      projects: Object.fromEntries(this.settings.projects.map((p) => [p, { trust_level: 'trusted' }])),
    });
    if (this.runtimeBaseUrl) config.model_providers[this.providerId].base_url = this.runtimeBaseUrl;
    writePrivate(path.join(this.codexHome, 'config.toml'), TOML.stringify(config));
  }
  get providerId() { return this.settings.useRelayEnv ? 'sub2api' : 'desk_api'; }
  get envKey() { return this.providerId === 'sub2api' ? 'SUB2API_API_KEY' : 'CODEX_DESK_API_KEY'; }
}

function inside(root, target) {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(target));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

module.exports = { SettingsStore, normalizeSettings, writePrivate, inside, defaults };
