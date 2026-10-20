const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu, nativeTheme, nativeImage, clipboard, Tray, Notification, systemPreferences, globalShortcut, powerMonitor } = require('electron');
const { installNative } = require('./native-handlers.cjs');
const { installWorkspace } = require('./workspace-handlers.cjs');
const { Images } = require('./images.cjs');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const TOML = require('@iarna/toml');
const { CodexBridge } = require('./bridge.cjs');
const { RelayAdapter } = require('./relay.cjs');
const { SettingsStore, inside, writePrivate } = require('./storage.cjs');
const { resolveLink } = require('./links.cjs');
const exec = promisify(execFile);
app.setName('Codex Desk');
const dataDir = process.env.CODEX_DESK_DATA_DIR || (process.platform === 'win32' ? path.join(os.homedir(), '.codex-desk') : path.join(app.getPath('appData'), 'Codex Desk'));
app.setPath('userData', dataDir);
let win, store, bridge, starting, workflows, tray, images, native, relay;
let state = { connected: false, error: '', version: '' };
const attachments = new Set();
const loaded = new Set();
const activeTurns = new Map();
const terminals = new Set();
const completedTurns = new Set();
let quitting = false;
const send = (message) => {
  if (!win || win.isDestroyed()) return;
  let key = ''; try { key = store?.readKey() || ''; } catch {}
  if (key) message = JSON.parse(JSON.stringify(message).split(key).join('[已隐藏]'));
  win.webContents.send('desk:event', message);
};
const emitState = () => send({ method: 'desk/state', params: state });
function windowPalette() {
  const dark=store?.settings.theme==='dark'||(store?.settings.theme==='system'&&nativeTheme.shouldUseDarkColors);
  return dark?{background:'#20221f',bar:'#1b1d1a',symbol:'#e1e3db'}:{background:'#faf9f6',bar:'#efeee7',symbol:'#33382e'};
}

async function findBinary() {
  const candidates = [store.settings.binary,
    path.join(process.resourcesPath, 'codex', process.platform === 'win32' ? 'codex.exe' : 'codex'),
    path.join(__dirname, '..', 'runtime', 'codex', process.platform === 'win32' ? 'codex.exe' : 'codex'),
    process.platform === 'darwin' && '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    process.platform === 'win32' && path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'),
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  try {
    const { stdout } = await exec(process.platform === 'win32' ? 'where.exe' : '/usr/bin/which', ['codex'], {
      env: { ...process.env, PATH: `${process.env.PATH}${path.delimiter}/opt/homebrew/bin${path.delimiter}/usr/local/bin` },
    });
    const p = stdout.trim().split(/\r?\n/).find((p) => !/\.(cmd|ps1)$/i.test(p));
    if (p) return p;
  } catch {}
  throw new Error('没有找到 Codex 引擎。请在设置中选择 codex 可执行文件，或安装官方 Codex CLI。');
}

async function connect() {
  if (bridge?.ready) return state;
  if (starting) return starting;
  starting = (async () => {
    relay?.stop(); relay = null; store.runtimeBaseUrl = null;
    if (store.settings.relayCompatibility && store.readKey()) {
      relay = new RelayAdapter({ baseUrl: store.settings.baseUrl, key: store.readKey() });
      store.runtimeBaseUrl = await relay.start();
    }
    store.writeConfig();
    // Only the bundled, verified local server receives the image credential. Shell tools do not.
    const effectiveFile=path.join(store.codexHome,'config.toml'), effective=TOML.parse(fs.readFileSync(effectiveFile,'utf8'));
    const server=effective.mcp_servers?.desk_tools;
    const bundledScripts=[path.join(__dirname,'..','local-tools','tools','mcp-server.mjs'),path.join(process.resourcesPath,'local-tools','tools','mcp-server.mjs')].filter(file=>fs.existsSync(file)).map(file=>fs.realpathSync(file));
    const trustedNodes=[path.join(dataDir,'tools','runtime',process.platform==='win32'?'node.exe':'node'),...(process.platform==='darwin'?['/opt/homebrew/bin/node','/usr/local/bin/node']:[])].filter(file=>fs.existsSync(file)).map(file=>fs.realpathSync(file));
    if(server?.command&&fs.existsSync(server.command)&&trustedNodes.includes(fs.realpathSync(server.command))&&server?.args?.[0]&&fs.existsSync(server.args[0])&&bundledScripts.includes(fs.realpathSync(server.args[0]))) {
      server.env_vars=[store.envKey];server.env={...server.env,CODEX_DESK_NATIVE_DATA:store.directory,CODEX_DESK_IMAGE_BASE_URL:store.settings.baseUrl,CODEX_DESK_IMAGE_OUTPUT:store.directory,CODEX_DESK_PROJECT_ROOTS:JSON.stringify(store.settings.projects)};
      writePrivate(effectiveFile,TOML.stringify(effective));
    }
    const binary = await findBinary();
    const key = store.readKey();
    let localTools = {};
    const localToolsFile = path.join(store.directory, 'local-tools.json');
    if (fs.existsSync(localToolsFile)) localTools = JSON.parse(fs.readFileSync(localToolsFile, 'utf8'));
    const current = new CodexBridge({ binary, home: store.codexHome, env: { ...localTools.env, [store.envKey]: key } });
    bridge = current;
    current.on('notification', (message) => {
      if (current !== bridge) return;
      const p = message.params || {};
      if (message.method === 'turn/started') activeTurns.set(p.threadId, p.turn.id);
      if (message.method === 'turn/completed') { activeTurns.delete(p.threadId); completedTurns.add(p.turn.id); workflows?.completed(p.threadId, p.turn); }
      if (message.method === 'thread/tokenUsage/updated') workflows?.tokenUsage(p.threadId,p.tokenUsage);
      send(message);
    });
    current.on('request', (message) => { if (current === bridge) send({ method: 'desk/request', params: message }); });
    current.on('exit', () => {
      if (current !== bridge || quitting) return;
      relay?.stop(); relay = null; store.runtimeBaseUrl = null;
      loaded.clear(); activeTurns.clear(); terminals.clear();
      state = { ...state, connected: false, error: '引擎连接已关闭，点击左下角重新连接。' }; emitState();
    });
    // Diagnostics never contain credentials or arbitrary request payloads in UI/log files.
    current.on('diagnostic', (text) => {
      if (process.env.CODEX_DESK_UI_TEST === '1' && process.env.DESK_TEST_DIAGNOSTICS === '1') process.stderr.write(String(text).split(key || '\0').join('[已隐藏]').replace(/Bearer\s+[^\s"']+/gi,'Bearer [已隐藏]'));
    });
    const hello = await current.start();
    if (localTools.skillRoots?.length) await current.request('skills/extraRoots/set', { extraRoots: localTools.skillRoots });
    state = { connected: true, error: '', version: hello.userAgent || hello.serverVersion || '', binary };
    emitState();
    return state;
  })();
  try { return await starting; }
  catch (error) { bridge?.stop(); relay?.stop(); relay = null; store.runtimeBaseUrl = null; state = { ...state, connected: false, error: error.message }; emitState(); throw error; }
  finally { starting = null; }
}

async function engine() { await connect(); return bridge; }
function policy(mode) {
  return mode === 'readonly' ? { type: 'readOnly', networkAccess: true } : mode === 'full' ? { type: 'dangerFullAccess' }
    : { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}
function threadOptions() {
  const { model, instructions, permission } = store.settings;
  return { model, modelProvider: store.providerId, approvalPolicy: permission === 'full' ? 'never' : 'on-request', approvalsReviewer: 'user',
    sandbox: { readonly: 'read-only', workspace: 'workspace-write', full: 'danger-full-access' }[permission],
    developerInstructions: '这是独立的 Codex Desk 客户端。不要读取官方 Codex 的认证资料、auth.json 或 .env；不要修改官方 Codex 配置或登录状态。不要打印或保存 API key。通过实际工具完成本地任务，并如实报告结果。\n' + (instructions || '') };
}
async function ensureLoaded(threadId) {
  const b = await engine();
  if (!loaded.has(threadId)) {
    await b.request('thread/resume', { threadId, ...threadOptions(), excludeTurns: true }); loaded.add(threadId);
  }
  return b;
}
function approvedPath(p) {
  if (typeof p !== 'string' || p.includes('\0') || !path.isAbsolute(p)) throw new Error('无效文件路径');
  const real = fs.realpathSync(p);
  if (/^(?:\.env(?:\..*)?|auth\.json|credential\.bin)$/i.test(path.basename(real))) throw new Error('不在预览中打开凭据文件');
  const attachmentRoot = path.join(store.directory, 'attachments');
  const ownAttachment = fs.existsSync(attachmentRoot) && inside(attachmentRoot, real);
  if (!attachments.has(real) && !ownAttachment && !store.settings.projects.some((root) => inside(root, real))) throw new Error('请先选择此文件所在的项目，或通过附件选择文件');
  return real;
}
function withDefaultCwd(p) {
  const selected = p || store.settings.projects[0];
  if (!selected || !store.settings.projects.includes(selected)) throw new Error('请先选择项目文件夹');
  return selected;
}

const handlers = {
  async imageModels() { return images.models(); },
  async imageGenerate(p) { return images.generate(p); },
  async imageCancel(p) { images.cancel(p.id); return true; },
  async imageHistory() {
    const folder = path.join(dataDir, 'attachments');if (!fs.existsSync(folder)) return [];
    return fs.readdirSync(folder).filter(name => /^generated-[a-f0-9-]+\.png$/.test(name)).map(name => ({ name, path:path.join(folder,name), image:true, size:fs.statSync(path.join(folder,name)).size, modified:fs.statSync(path.join(folder,name)).mtimeMs })).sort((a,b) => b.modified-a.modified).slice(0,8).map(file => ({...file,thumbnail:nativeImage.createFromPath(file.path).resize({width:180}).toDataURL()}));
  },
  async copyText(p) {
    if (typeof p.text !== 'string' || p.text.length > 2000000) throw new Error('复制内容过长或格式无效');
    clipboard.writeText(p.text);
    return true;
  },
  async bootstrap() {
    return { settings: store.public(), state, activeTurns: Object.fromEntries(activeTurns),
      requests: [...(bridge?.approvals.values() || [])], dark: nativeTheme.shouldUseDarkColors };
  },
  async connect() { return connect(); },
  async settings(p) {
    const changedConnection = (p.baseUrl && p.baseUrl.replace(/\/+$/, '') !== store.settings.baseUrl) ||
      (p.binary !== undefined && p.binary !== store.settings.binary) ||
      (typeof p.useRelayEnv === 'boolean' && p.useRelayEnv !== !!store.settings.useRelayEnv) ||
      (typeof p.relayCompatibility === 'boolean' && p.relayCompatibility !== !!store.settings.relayCompatibility) || !!p.apiKey || !!p.clearKey;
    if (changedConnection && (activeTurns.size || terminals.size || images?.active.size)) throw new Error('请先完成任务、图像生成并关闭终端，再修改连接设置');
    if (changedConnection && starting) await starting.catch(() => {});
    const result = store.save(p); store.writeConfig();
    if(process.platform==='win32'&&win){const colors=windowPalette();win.setTitleBarOverlay({color:colors.bar,symbolColor:colors.symbol});win.setBackgroundColor(colors.background);}
    if (changedConnection) { const old = bridge; bridge = null; old?.stop(); loaded.clear(); await connect(); }
    return result;
  },
  async chooseProject() {
    const result = await dialog.showOpenDialog(win, { title: '选择项目文件夹', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return null;
    const directory = store.addProject(result.filePaths[0]); store.writeConfig();
    return { directory, settings: store.public() };
  },
  async renameProject(p) { return store.renameProject(p.cwd, p.name); },
  async assignProject(p) {
    if (typeof p.threadId !== 'string' || p.threadId.length > 200) throw new Error('对话编号无效');
    await (await engine()).request('thread/read', { threadId:p.threadId });
    return store.assignProject(p.threadId, p.cwd);
  },
  async chooseBinary() {
    const result = await dialog.showOpenDialog(win, { title: '选择 Codex 可执行文件', properties: ['openFile'] });
    return result.canceled ? null : result.filePaths[0];
  },
  async files(p) {
    let paths = p.paths;
    if (!paths) {
      const result = await dialog.showOpenDialog(win, { title: '添加文件或图片', properties: ['openFile', 'multiSelections'] });
      if (result.canceled) return [];
      paths = result.filePaths;
    }
    return paths.slice(0, 20).map((p) => {
      const real = fs.realpathSync(p); const stat = fs.statSync(real);
      if (!stat.isFile()) throw new Error('附件需要是文件');
      attachments.add(real);
      return { path: real, name: path.basename(real), image: /\.(png|jpe?g|gif|webp)$/i.test(real), size: stat.size };
    });
  },
  async pasteImage(p) {
    if (!ArrayBuffer.isView(p.bytes) || !p.bytes.byteLength || p.bytes.byteLength > 20 * 1024 * 1024) throw new Error('粘贴的图片需小于20 MB');
    const image = nativeImage.createFromBuffer(Buffer.from(p.bytes.buffer, p.bytes.byteOffset, p.bytes.byteLength));
    if (image.isEmpty()) throw new Error('剪贴板内容不是有效图片');
    const { width, height } = image.getSize();
    if (width * height > 40_000_000) throw new Error('图片尺寸过大，请先缩小后粘贴');
    const png = image.toPNG();
    if (png.length > 20 * 1024 * 1024) throw new Error('图片超过20 MB，请先缩小后粘贴');
    const file = path.join(store.directory, 'attachments', `pasted-${randomUUID()}.png`);
    writePrivate(file, png); attachments.add(file);
    const scale = Math.min(1, 80 / width, 80 / height);
    const thumbnail = image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }).toDataURL();
    return { path: file, name: '粘贴图片.png', image: true, size: png.length, thumbnail };
  },
  async list(p) {
    return (await engine()).request('thread/list', { limit: 60, sortKey: 'updated_at', sortDirection: 'desc',
      modelProviders: [], archived: !!p.archived, ...(p.cursor ? { cursor: p.cursor } : {}), ...(p.search ? { searchTerm: p.search } : {}) });
  },
  async create(p) {
    const b = await engine();
    const result = await b.request('thread/start', { ...threadOptions(), cwd: withDefaultCwd(p.cwd) });
    loaded.add(result.thread.id);
    return result;
  },
  async history(p) {
    const b = await ensureLoaded(p.threadId);
    const [thread, turns] = await Promise.all([
      b.request('thread/read', { threadId: p.threadId }),
      b.request('thread/turns/list', { threadId: p.threadId, limit: 20, sortDirection: 'desc', itemsView: 'full', ...(p.cursor ? { cursor: p.cursor } : {}) }),
    ]);
    return { ...thread, ...turns, requests: [...b.approvals.values()].filter((r) => r.params.threadId === p.threadId), activeTurn: activeTurns.get(p.threadId) || null };
  },
  async turn(p) {
    if (!store.readKey()) throw new Error('请先在设置中填写 API key');
    const b = await ensureLoaded(p.threadId);
    if (activeTurns.has(p.threadId)) throw new Error('任务正在运行，请使用追加说明或先停止');
    const selectedFiles = (p.files || []).map((f) => ({ ...f, path: approvedPath(f.path) }));
    const fileContext = selectedFiles.filter((f) => !f.image).map((f) => `\n本地附件：${f.path}`).join('');
    const input = [{ type: 'text', text: String(p.text || '') + fileContext, text_elements: [] },
      ...selectedFiles.filter((f) => f.image).map((f) => ({ type: 'localImage', path: f.path })),
      ...(p.skill ? [{ type: 'skill', name: p.skill.name, path: p.skill.path }] : [])];
    {
      const file=path.join(store.directory,'tool-permissions.json');
      const permissions=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
      permissions[p.threadId]=store.settings.permission;
      writePrivate(file,JSON.stringify(permissions));
    }
    const result = await b.request('turn/start', { threadId: p.threadId, input,
      model: p.model || store.settings.model, effort: p.effort || store.settings.effort,
      approvalPolicy: store.settings.permission === 'full' ? 'never' : 'on-request', approvalsReviewer: 'user', sandboxPolicy: policy(store.settings.permission),
      collaborationMode: { mode: p.mode === 'plan' ? 'plan' : 'default', settings: { model: p.model || store.settings.model, reasoning_effort: p.effort || store.settings.effort, developer_instructions: null } } });
    if (!completedTurns.has(result.turn.id)) activeTurns.set(p.threadId, result.turn.id); return result;
  },
  async testConnection() {
    if (!store.readKey()) throw new Error('请先填写并保存 API key');
    const b = await engine();
    const { thread } = await b.request('thread/start', { ...threadOptions(), ephemeral: true,
      cwd: store.codexHome, sandbox: 'read-only', approvalPolicy: 'never' });
    return new Promise((resolve, reject) => {
      let turnId;
      const done = (result, error) => {
        clearTimeout(timer); b.off('notification', listener);
        if (error) reject(error); else resolve(result);
      };
      const listener = (m) => {
        if (m.method !== 'turn/completed' || m.params.threadId !== thread.id) return;
        const turn = m.params.turn;
        done({ ok: turn.status === 'completed', error: turn.error?.message || `请求结束：${turn.status}` });
      };
      const timer = setTimeout(() => {
        if (turnId) b.request('turn/interrupt', { threadId: thread.id, turnId }).catch(() => {});
        done(null, new Error('测试请求超过 45 秒，请检查地址、key 和模型是否可用'));
      }, 45000);
      b.on('notification', listener);
      b.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Reply exactly OK. Do not use tools.', text_elements: [] }], effort: 'low' })
        .then((r) => { turnId = r.turn.id; }).catch((e) => done(null, e));
    });
  },
  async steer(p) {
    const b = await ensureLoaded(p.threadId);
    const files = (p.files || []).map((f) => ({ ...f, path: approvedPath(f.path) }));
    const text = String(p.text || '') + files.filter((f) => !f.image).map((f) => `\n本地附件：${f.path}`).join('');
    const input = [{ type: 'text', text, text_elements: [] }, ...files.filter((f) => f.image).map((f) => ({ type: 'localImage', path: f.path }))];
    return b.request('turn/steer', { threadId: p.threadId, expectedTurnId: activeTurns.get(p.threadId), input });
  },
  async interrupt(p) {
    const turnId = activeTurns.get(p.threadId);
    if (turnId) return (await engine()).request('turn/interrupt', { threadId: p.threadId, turnId });
  },
  async respond(p) {
    (await engine()).respond(p.id, p.result); return true;
  },
  async rename(p) { return (await engine()).request('thread/name/set', { threadId: p.threadId, name: String(p.name).slice(0, 200) }); },
  async archive(p) {
    if (activeTurns.has(p.threadId)) throw new Error('请先停止任务');
    loaded.delete(p.threadId);
    return (await engine()).request(p.archived ? 'thread/unarchive' : 'thread/archive', { threadId: p.threadId });
  },
  async fork(p) { const r = await (await engine()).request('thread/fork', { threadId: p.threadId, ...threadOptions(), excludeTurns: true }); loaded.add(r.thread.id); return r; },
  async compact(p) { return (await ensureLoaded(p.threadId)).request('thread/compact/start', { threadId: p.threadId }); },
  async review(p) { return (await ensureLoaded(p.threadId)).request('review/start', { threadId: p.threadId, target: { type: 'uncommittedChanges' } }); },
  async models() {
    const b = await engine();
    const catalog = await b.request('model/list', { limit: 100 });
    const key = store.readKey();
    if (!key) return { ...catalog, source: 'catalog' };
    try {
      const response = await fetch(store.settings.baseUrl + '/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`获取服务商模型列表失败 (${response.status})`);
      const result = await response.json();
      if (!Array.isArray(result.data) || !result.data.length) throw new Error('服务商未返回模型列表');
      return { data: result.data.filter((entry) => typeof entry.id === 'string').map((entry) => ({ ...(catalog.data.find((m) => m.model === entry.id) || {}),
        id: entry.id, model: entry.id, displayName: entry.id })), source: 'provider' };
    } catch (error) {
      return { ...catalog, source: 'catalog', warning: error.message };
    }
  },
  async skills(p) { return (await engine()).request('skills/list', { cwds: p.cwd ? [p.cwd] : [] }); },
  async mcp() { return (await engine()).request('mcpServerStatus/list', {}); },
  async extensions(p) {
    const file = path.join(store.directory, 'extensions.toml');
    if (p.content !== undefined) {
      if (activeTurns.size) throw new Error('请先停止运行中的任务');
      if (starting) await starting.catch(() => {});
      const parsed = TOML.parse(p.content);
      if (Object.keys(parsed).some((k) => !['mcp_servers', 'skills'].includes(k))) throw new Error('这里只支持 [mcp_servers] 和 [skills]');
      writePrivate(file, p.content); store.writeConfig();
      const old = bridge; bridge = null; old?.stop(); loaded.clear(); await connect();
    }
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# 在这里添加独立的 MCP 服务配置\n# [mcp_servers.example]\n# command = "npx"\n# args = ["-y", "your-mcp-server"]\n';
  },
  async importSkills() {
    const source = path.join(os.homedir(), '.codex', 'skills');
    if (!fs.existsSync(source)) throw new Error('没有找到本机 Skills 文件夹');
    const target = path.join(store.codexHome, 'skills');
    fs.mkdirSync(target, { recursive: true });
    let count = 0;
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const from = path.join(source, entry.name), to = path.join(target, entry.name);
      if (!fs.existsSync(to) && fs.statSync(from).isDirectory()) { fs.cpSync(from, to, { recursive: true, dereference: true }); count++; }
    }
    return { count };
  },
  async readFile(p) {
    const file = approvedPath(p.path); const stat = fs.statSync(file);
    if (/\.(png|jpe?g|gif|webp)$/i.test(file)) {
      if (stat.size > 20 * 1024 * 1024) throw new Error('图片超过20 MB，请用外部程序打开');
      const ext = path.extname(file).slice(1).replace('jpg', 'jpeg');
      return { path: file, image: `data:image/${ext};base64,${fs.readFileSync(file).toString('base64')}` };
    }
    if (stat.size > 2 * 1024 * 1024) throw new Error('文件超过 2 MB，请用外部编辑器打开');
    return { path: file, text: fs.readFileSync(file, 'utf8') };
  },
  async openLink(p) {
    const target = resolveLink(p.href, { cwd: p.cwd ? withDefaultCwd(p.cwd) : store.settings.projects[0], baseFile: p.baseFile ? approvedPath(p.baseFile) : undefined });
    if (target.kind === 'external') { await shell.openExternal(target.url); return { external: true }; }
    if (target.kind === 'anchor') return target;
    let file;
    try { file = approvedPath(target.path); }
    catch (error) { if (error.code === 'ENOENT') throw new Error(`找不到本机文件：${target.path}`); throw error; }
    if (fs.statSync(file).isDirectory() || /\.(?:html?|pdf|docx?|xlsx?|pptx?|odt|ods|odp)$/i.test(file)) {
      const error = await shell.openPath(file); if (error) throw new Error(`无法打开文件：${error}`);
      return { external: true };
    }
    if (/\.(?:exe|com|msi|bat|cmd|ps1|vbs|lnk|scr|reg)$/i.test(file)) throw new Error('程序和脚本请通过终端明确运行');
    return { ...target, path: file, preview: true };
  },
  async reveal(p) { shell.showItemInFolder(approvedPath(p.path)); return true; },
  async openData() { return shell.openPath(store.directory); },
  async confirmFullAccess() {
    const r = await dialog.showMessageBox(win, { type: 'question', message: '允许 Codex 直接访问本机文件并执行命令？',
      detail: '完全访问模式下，引擎会直接执行操作。你可以随时切回“项目内执行”。', buttons: ['保持项目内执行', '允许完全访问'], defaultId: 0, cancelId: 0 });
    return r.response === 1;
  },
  async export(p) {
    const result = await dialog.showSaveDialog(win, { title: '导出对话', defaultPath: String(p.name || '对话').replace(/[/\\:*?"<>|]/g, '-') + '.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (!result.canceled) { fs.writeFileSync(result.filePath, p.text, 'utf8'); return true; }
    return false;
  },
  async external(p) { const u = new URL(p.url); if (['https:', 'http:'].includes(u.protocol)) await shell.openExternal(u.href); },
  async git(p) {
    const cwd = withDefaultCwd(p.cwd);
    try {
      const [status, diff, branch, untracked] = await Promise.all([
        exec('git', ['status', '--porcelain=v1', '-uall'], { cwd }),
        exec('git', ['diff', '--no-ext-diff', '--no-color', 'HEAD', '--'], { cwd, maxBuffer: 4 * 1024 * 1024 }).catch(() => ({ stdout: '' })),
        exec('git', ['branch', '--show-current'], { cwd }).catch(() => ({ stdout: '' })),
        exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd }),
      ]);
      return { status: status.stdout, diff: diff.stdout, branch: branch.stdout.trim(), untracked: untracked.stdout.split('\n').filter(Boolean) };
    } catch { return { status: '', diff: '', branch: '', untracked: [], notRepository: true }; }
  },
  async terminalStart(p) {
    const b = await engine(), cwd = withDefaultCwd(p.cwd);
    const id = 'desk-terminal-' + Date.now(); terminals.add(id);
    b.request('command/exec', { command: process.platform === 'win32' ? ['powershell.exe', '-NoLogo'] : [process.env.SHELL || '/bin/zsh', '-l'],
      processId: id, tty: true, disableTimeout: true, cwd, size: { rows: p.rows || 20, cols: p.cols || 100 },
      env: { CODEX_DESK_API_KEY: null, SUB2API_API_KEY: null, OPENAI_API_KEY: null, CODEX_API_KEY: null, TERM: 'xterm-256color' }, sandboxPolicy: policy(store.settings.permission),
    }, 0).then((r) => send({ method: 'desk/terminalEnd', params: { processId: id, ...r } }))
      .catch((e) => send({ method: 'desk/terminalEnd', params: { processId: id, error: e.message } }))
      .finally(() => terminals.delete(id));
    return { processId: id };
  },
  async terminalWrite(p) {
    if (!terminals.has(p.processId)) return;
    return (await engine()).request('command/exec/write', { processId: p.processId, deltaBase64: Buffer.from(p.data).toString('base64') });
  },
  async terminalResize(p) { if (terminals.has(p.processId)) return (await engine()).request('command/exec/resize', { processId: p.processId, size: { rows: p.rows, cols: p.cols } }); },
  async terminalStop(p) { if (terminals.has(p.processId)) return (await engine()).request('command/exec/terminate', { processId: p.processId }); },
};

function createWindow() {
  const colors=windowPalette();
  const testing = process.env.CODEX_DESK_UI_TEST === '1';
  win = new BrowserWindow({ width: 1440, height: 960, minWidth: 940, minHeight: 650,
    title: testing ? 'Codex Desk · 界面测试' : 'Codex Desk', ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: { color:colors.bar,symbolColor:colors.symbol,height:40 },icon:path.join(__dirname,'..','assets','desk.png') } : {titleBarStyle:'hiddenInset',trafficLightPosition:{x:20,y:20}}),
    backgroundColor: process.platform==='win32'?colors.background:'#faf9f6', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
      spellcheck: false, webSecurity: true, backgroundThrottling: !testing },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => { if (!testing) win.show(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
  win.on('close', (event) => {
    if (!quitting && store.settings.background && process.env.CODEX_DESK_UI_TEST !== '1') { event.preventDefault(); win.hide(); return; }
    if (!quitting && (activeTurns.size || images?.active.size) && dialog.showMessageBoxSync(win, { type: 'question', message: '任务仍在运行，退出会停止任务。', buttons: ['继续运行', '退出'], defaultId: 0, cancelId: 0 }) === 0) event.preventDefault();
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(() => {
    let localTools = {};
    const localToolsFile = path.join(dataDir,'local-tools.json');
    if(fs.existsSync(localToolsFile))localTools=JSON.parse(fs.readFileSync(localToolsFile,'utf8'));
    store = new SettingsStore(dataDir, safeStorage, {codexHome:localTools.engineHome});
    images = new Images({ directory: dataDir, connection: () => ({ baseUrl: store.settings.baseUrl, key: store.readKey() }), readInput: file => { const selected = approvedPath(file); if (!/\.(png|jpe?g|webp)$/i.test(selected)) throw new Error('编辑输入需要 PNG、JPEG 或 WebP'); return { bytes: fs.readFileSync(selected), mime: /\.png$/i.test(selected) ? 'image/png' : /\.webp$/i.test(selected) ? 'image/webp' : 'image/jpeg' }; } });
    workflows = installWorkspace({ store, engine, ensureLoaded, handlers, activeTurns, terminals, imageBusy: () => images.active.size > 0, send, dialog, shell, app, Notification, getWindow: () => win });
    if(process.platform==='win32')writePrivate(path.join(dataDir,'startup.json'),JSON.stringify({startedAt:new Date().toISOString(),processId:process.pid,executable:process.execPath,appPath:app.getAppPath(),dataDir}));
    ipcMain.handle('desk:call', async (event, action, params) => {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('无效请求');
      const handler = Object.hasOwn(handlers, action) && handlers[action];
      if (!handler) throw new Error('未知操作');
      try { return await handler(params || {}); }
      catch (e) {
        let message = e.message || '操作失败';
        let key = ''; try { key = store.readKey(); } catch {}
        if (key) message = message.split(key).join('[已隐藏]');
        throw new Error(message);
      }
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Codex Desk', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '视图', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    ]));
    createWindow();
    native = installNative({store,handlers,send,app,systemPreferences,globalShortcut,powerMonitor,getWindow:()=>win});
    if (process.env.CODEX_DESK_UI_TEST !== '1') {
      if (process.platform === 'win32') app.setAppUserModelId('local.felix.codexdesk');
      const image = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'desk.png')).resize({ width: 18, height: 18 });
      tray = new Tray(image); tray.setToolTip('Codex Desk');
      const show = () => { if (!win || win.isDestroyed()) createWindow(); else { win.show(); win.focus(); } };
      tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 Codex Desk', click: show }, {label:'停止电脑控制与语音',click:()=>native?.stop()}, { label: '退出并停止任务', click: () => { quitting = true; app.quit(); } }])); tray.on('click', show);
      if (process.platform === 'darwin') tray.setTitle('CD');
    }
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else win?.show(); });
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { quitting = true; native?.stop(); workflows?.stop(); bridge?.stop(); relay?.stop(); tray?.destroy(); });
}
