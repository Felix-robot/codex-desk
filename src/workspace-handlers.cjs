const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const TOML = require('@iarna/toml');
const { Workspace, run, hash } = require('./workspace.cjs');
const { writePrivate, inside } = require('./storage.cjs');
const { spawn } = require('node:child_process');
const { sourceHash } = require('../scripts/source-manifest.cjs');

function installWorkspace({ store, engine, ensureLoaded, handlers, activeTurns, terminals, imageBusy = () => false, send, dialog, shell, app, Notification, getWindow }) {
  const workspace = new Workspace({ directory: store.directory, roots: () => store.settings.projects, readonly: () => store.settings.permission === 'readonly' });
  if (!workspace.data.syncDirectory) {
    const recordFile=path.join(store.directory,process.platform==='win32'?'windows-install.json':'install-source.json');
    if(fs.existsSync(recordFile)) {
      const source=JSON.parse(fs.readFileSync(recordFile,'utf8')).source;
      if(source&&fs.existsSync(path.join(source,'package.json'))) {const shared=path.join(source,'shared-chats');fs.mkdirSync(shared,{recursive:true,mode:0o700});workspace.data.syncDirectory=shared;workspace.save();}
    }
  }
  const redact = text => {
    let key = ''; try { key = store.readKey(); } catch {}
    return String(text).split(key || '\0').join('[已隐藏]').replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[key 已隐藏]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]');
  };
  async function confirm(message, detail) {
    const result = await dialog.showMessageBox(getWindow(), { type: 'question', message, detail, buttons: ['取消', '执行'], defaultId: 0, cancelId: 0 });
    if (result.response !== 1) throw new Error('已取消');
  }
  async function allThreads(archived = false) {
    const b = await engine(), data = []; let cursor;
    do { const page = await b.request('thread/list', { limit: 100, modelProviders: [], archived, ...(cursor ? { cursor } : {}) }); data.push(...page.data); cursor = page.nextCursor; } while (cursor && data.length < 5000);
    return data;
  }
  async function transcript(threadId) {
    const b = await engine(); const { thread } = await b.request('thread/read', { threadId });
    const turns = []; let cursor;
    do { const page = await b.request('thread/turns/list', { threadId, limit: 50, sortDirection: 'asc', itemsView: 'full', ...(cursor ? { cursor } : {}) }); turns.push(...page.data); cursor = page.nextCursor; } while (cursor && turns.length < 10000);
    // Portable transcripts deliberately contain messages, not executable tool calls, key material or absolute local attachment paths.
    return { version: 1, id: threadId, name: thread.name || thread.preview || '对话', exportedAt: new Date().toISOString(), messages: turns.flatMap(t => t.items || []).filter(i => i.type === 'userMessage' || i.type === 'agentMessage').map(i => ({ role: i.type === 'userMessage' ? 'user' : 'assistant', text: redact(i.type === 'userMessage' ? (i.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n') : i.text || '') })) };
  }
  async function syncOne(threadId) {
    if (!workspace.data.syncDirectory || !workspace.data.syncThreads.includes(threadId)) return;
    const folder = path.join(workspace.data.syncDirectory, 'CodexDesk-chats');
    writePrivate(path.join(folder, hash(threadId) + '.json'), JSON.stringify(await transcript(threadId), null, 2));
  }
  const actions = {
    async workspaceState() { return { ...workspace.data, background: !!store.settings.background, notifications: store.settings.notifications === true, version: app.getVersion(), platform: process.platform }; },
    async threadPin(p) { return workspace.pin(String(p.threadId), !!p.value); },
    async historyList(p) { return allThreads(!!p.archived); },
    async threadOrder(p) { if (!Array.isArray(p.ids)) throw new Error('排序数据无效'); return workspace.order(p.ids); },
    async threadBatch(p) {
      if (!Array.isArray(p.ids) || !p.ids.length || p.ids.length > 200) throw new Error('一次选择1–200条对话');
      if (p.ids.some(id => activeTurns.has(id))) throw new Error('选择中有运行中的对话，请先停止');
      await confirm(p.restore ? '恢复所选对话？' : '归档所选对话？', `${p.ids.length} 条对话`);
      for (const threadId of p.ids) await handlers.archive({ threadId, archived: !!p.restore });
      return true;
    },
    async fullSearch(p) {
      const term = String(p.query || '').trim().toLowerCase(); if (term.length < 2) throw new Error('请输入至少两个字符');
      const results = [], threads = await allThreads(!!p.archived);
      for (const thread of threads) {
        const data = await transcript(thread.id); let hit;
        for (const message of data.messages) { const offset = message.text.toLowerCase().indexOf(term); if (offset >= 0) { hit = message.text.slice(Math.max(0, offset - 50), offset + term.length + 140); break; } }
        if (hit || String(thread.name || thread.preview).toLowerCase().includes(term)) results.push({ thread, snippet: hit || thread.preview });
        if (results.length >= 100) break;
      }
      return { results, scanned: threads.length, capped: threads.length >= 5000 };
    },
    async portableExport(p) {
      const record = await transcript(p.threadId);
      const target = await dialog.showSaveDialog(getWindow(), { title: '导出完整对话副本', defaultPath: record.name.replace(/[/\\:*?"<>|]/g, '-') + '.codexdesk.json', filters: [{ name: 'Codex Desk 对话', extensions: ['json'] }] });
      if (target.canceled) return false;
      writePrivate(target.filePath, JSON.stringify(record, null, 2)); return true;
    },
    async syncConfigure() {
      const selected = await dialog.showOpenDialog(getWindow(), { title: '选择两台设备已有的 Syncthing 共享目录', properties: ['openDirectory'] });
      if (selected.canceled) return workspace.data;
      const folder = fs.realpathSync(selected.filePaths[0]);
      const official = path.join(os.homedir(), '.codex');
      if (inside(folder, store.directory) || inside(store.directory, folder) || fs.existsSync(official) && (inside(folder, official) || inside(official, folder))) throw new Error('请选择独立的共享文件夹，不能同步认证或运行数据库目录');
      workspace.data.syncDirectory = folder; workspace.save(); return workspace.data;
    },
    async syncThread(p) {
      if (!workspace.data.syncDirectory) throw new Error('请先选择共享目录');
      workspace.data.syncThreads = workspace.data.syncThreads.filter(id => id !== p.threadId);
      if (p.enabled) workspace.data.syncThreads.push(p.threadId);
      workspace.save(); if (p.enabled) await syncOne(p.threadId); return workspace.data;
    },
    async portableList() {
      if (!workspace.data.syncDirectory) return [];
      const folder = path.join(workspace.data.syncDirectory, 'CodexDesk-chats');
      if (!fs.existsSync(folder)) return [];
      return fs.readdirSync(folder).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).map(name => {
        const file = path.join(folder, name); if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 20 * 1024 * 1024) return null;
        try { const record = JSON.parse(fs.readFileSync(file, 'utf8')); if (record.version !== 1 || !Array.isArray(record.messages)) return null; return { id: name, name: String(record.name), exportedAt: record.exportedAt }; } catch { return null; }
      }).filter(Boolean);
    },
    async portableRead(p) {
      if (!(await actions.portableList()).some(r => r.id === p.id)) throw new Error('对话副本不存在');
      const record = JSON.parse(fs.readFileSync(path.join(workspace.data.syncDirectory, 'CodexDesk-chats', p.id), 'utf8'));
      return { ...record, messages: record.messages.filter(m => ['user', 'assistant'].includes(m.role) && typeof m.text === 'string').map(m => ({ role: m.role, text: redact(m.text) })) };
    },
    async fileTree(p) { return workspace.tree(p.cwd, p.path); },
    async editorRead(p) { return workspace.read(p.cwd, p.path); },
    async editorSave(p) { return workspace.write(p.cwd, p.path, p.text, p.revision); },
    async editorSnapshots(p) { return workspace.snapshots(workspace.filePath(p.cwd, p.path)); },
    async editorRestore(p) {
      await confirm('恢复这个文件的检查点？', p.path + '\n当前内容也会保存为新检查点。');
      return workspace.restore(p.cwd, p.path, p.id, p.revision);
    },
    async gitAction(p) {
      if (['commit', 'merge', 'worktree', 'prCreate', 'prMerge'].includes(p.operation)) await confirm(({ commit: '提交已暂存的文件？', merge: '合并所选分支？', worktree: '创建工作树？', prCreate: '向 GitHub 创建草稿 PR？', prMerge: '在 GitHub 合并这个 PR？' })[p.operation], [p.cwd, p.message, p.branch, p.destination, p.title, p.number && `PR #${p.number}`, p.head].filter(Boolean).join('\n'));
      return workspace.git(p.cwd, p.operation, p);
    },
    async worktreeActivate(p) {
      const status = await workspace.git(p.cwd, 'status');
      const candidates = status.worktrees.split('\n').filter(line => line.startsWith('worktree ')).map(line => path.resolve(line.slice(9)));
      if (!candidates.some(cwd => fs.realpathSync(cwd) === fs.realpathSync(p.destination))) throw new Error('目标不是此仓库的工作树');
      const directory = store.addProject(p.destination);store.writeConfig();return {directory,settings:store.public()};
    },
    async goal(p) {
      const b = await ensureLoaded(p.threadId);
      if (p.operation === 'get') return b.request('thread/goal/get', { threadId: p.threadId });
      if (p.operation === 'clear') return b.request('thread/goal/clear', { threadId: p.threadId });
      const values = { threadId: p.threadId };
      if (p.objective !== undefined) { if (!String(p.objective).trim()) throw new Error('目标不能为空'); values.objective = String(p.objective); }
      if (p.tokenBudget !== undefined) { const budget = Number(p.tokenBudget); if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error('Token 预算需要为正整数'); values.tokenBudget = budget; }
      if (p.status) { if (!['active', 'paused', 'complete'].includes(p.status)) throw new Error('目标状态无效'); values.status = p.status; }
      return b.request('thread/goal/set', values);
    },
    async modes() { return (await engine()).request('collaborationMode/list', {}); },
    async agents(p) {
      const b = await engine();
      const loaded = await b.request('thread/loaded/list', {});
      const threads = await Promise.all(loaded.data.map(async threadId => (await b.request('thread/read', { threadId })).thread));
      const selected = new Set([p.threadId]);
      for (let pass = 0; pass < threads.length; pass++) for (const thread of threads) if (selected.has(thread.parentThreadId || workspace.data.parallelParents?.[thread.id])) selected.add(thread.id);
      return threads.filter(t => selected.has(t.id)).map(t => ({...t, managedParent:workspace.data.parallelParents?.[t.id]||null}));
    },
    async jobAdd(p) { await ensureLoaded(p.threadId); const job = workspace.addJob(p); send({ method: 'desk/jobsChanged' }); return job; },
    async parallelStart(p) {
      if (!Array.isArray(p.tasks) || !p.tasks.length || p.tasks.length > 8 || p.tasks.some(text => typeof text !== 'string' || !text.trim() || text.length > 100000)) throw new Error('每次添加1–8项任务');
      workspace.root(p.cwd);await ensureLoaded(p.threadId);
      workspace.data.parallelParents ||= {};
      const results=[];
      for (const text of p.tasks) {
        const {thread}=await handlers.create({cwd:p.cwd});await handlers.rename({threadId:thread.id,name:text.slice(0,60)});
        workspace.data.parallelParents[thread.id]=p.threadId;workspace.addJob({threadId:thread.id,text,model:p.model,effort:p.effort,mode:p.mode});results.push(thread.id);
      }
      workspace.save();send({method:'desk/jobsChanged'});return results;
    },
    async jobCancel(p) { workspace.cancelJob(p.id); return true; },
    async jobRetry(p) {
      const job = workspace.data.jobs.find(j => j.id === p.id); if (!job || !['failed', 'missed', 'interrupted'].includes(job.status)) throw new Error('此任务不能重试');
      job.status = 'queued'; job.when = Date.now(); job.error = ''; job.turnId = undefined; workspace.save(); return true;
    },
    async connectorStatus() {
      const b = await engine(); const mcp = await b.request('mcpServerStatus/list', {});
      return { mcp, note: '此工作台仅使用独立配置的 MCP 授权。官方账号的连接器授权不在这里继承。' };
    },
    async connectorLogin(p) {
      const b = await engine(); const result = await b.request('mcpServer/oauth/login', { name: String(p.name), timeoutSecs: 180 });
      const url = result.authorizationUrl;
      if (!url || !['https:', 'http:'].includes(new URL(url).protocol)) throw new Error('服务没有返回有效的 OAuth 授权地址');
      await shell.openExternal(url); return { started: true };
    },
    async connectorAdd(p) {
      if (!/^[a-z][a-z0-9_-]{0,60}$/i.test(p.name)) throw new Error('服务名请用字母、数字、下划线或短横线');
      const url = new URL(p.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请提供不含凭据和查询参数的 MCP 地址');
      if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) await confirm('添加未加密的 MCP 服务？', url.origin + '\n工具内容及授权信息可能经过未加密连接。');
      const content = await handlers.extensions({}), config = TOML.parse(content);
      if (config.mcp_servers?.[p.name]) throw new Error('同名服务已存在，请在 Skills 与 MCP 设置中编辑');
      config.mcp_servers = { ...config.mcp_servers, [p.name]: { url: url.href } };
      await handlers.extensions({ content: TOML.stringify(config) }); return true;
    },
    async connectorPreset(p) {
      const presets = { figma: 'https://mcp.figma.com/mcp', notion: 'https://mcp.notion.com/mcp' };
      if (presets[p.name]) return actions.connectorAdd({ name: p.name, url: presets[p.name] });
      if (p.name !== 'chrome') throw new Error('没有此连接预设');
      if (activeTurns.size || terminals?.size) throw new Error('请先完成任务并关闭终端再添加浏览器');
      await confirm('连接你当前登录的 Chrome？', 'Chrome 144 及以上需先在 chrome://inspect/#remote-debugging 启用调试，并在 Chrome 中同意连接。模型可以操作被连接的网页；不复制 Cookie 或官方 Codex 登录。');
      const manifestFile = path.join(store.directory, 'local-tools.json');
      const candidates = process.platform === 'win32' ? [path.join(store.directory,'tools','runtime','node.exe')] : ['/opt/homebrew/bin/node','/usr/local/bin/node'];
      const node = candidates.find(fs.existsSync); if (!node) throw new Error('缺少独立 Node.js，请先安装工具依赖');
      const systemNpm=process.platform==='win32'?await run('where.exe',['npm.cmd'],store.directory).catch(()=>''):'';
      const npmCandidates = [path.join(path.dirname(node),'node_modules','npm','bin','npm-cli.js'),path.join(path.dirname(path.dirname(node)),'lib','node_modules','npm','bin','npm-cli.js'),...systemNpm.trim().split(/\r?\n/).filter(Boolean).map(file=>path.join(path.dirname(file),'node_modules','npm','bin','npm-cli.js'))];
      const npm = npmCandidates.find(fs.existsSync); if (!npm) throw new Error('未找到 npm，请安装 Node.js 后重试');
      const prefix = path.join(store.directory,'tools','chrome');
      const manifest=path.join(prefix,'node_modules','chrome-devtools-mcp','package.json');
      if(!fs.existsSync(manifest)||JSON.parse(fs.readFileSync(manifest,'utf8')).version!=='1.11.0') await run(node,[npm,'install','--prefix',prefix,'--no-audit','--no-fund','chrome-devtools-mcp@1.11.0'],store.directory,180000);
      const content = TOML.parse(await handlers.extensions({}));
      if (content.mcp_servers?.chrome) throw new Error('Chrome 服务已存在，请在高级配置中编辑');
      content.mcp_servers={...content.mcp_servers,chrome:{command:node,args:[path.join(prefix,'node_modules','chrome-devtools-mcp','build','src','bin','chrome-devtools-mcp.js'),'--autoConnect','--no-usage-statistics','--no-performance-crux','--redact-network-headers'],env:{CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS:'1'},startup_timeout_sec:45,tool_timeout_sec:120}};
      await handlers.extensions({content:TOML.stringify(content)});return true;
    },
    async setupLocalTools() {
      if (activeTurns.size || terminals?.size) throw new Error('请先完成任务并关闭终端，再维护工具依赖');
      if (process.platform !== 'darwin') throw new Error('Windows 工具维护入口：同步源码 local-tools/setup-tools.ps1；本机已安装独立环境');
      const python = ['/opt/homebrew/bin/python3','/usr/local/bin/python3','/usr/bin/python3'].find(fs.existsSync);
      if (!python) throw new Error('请先安装 Python 3');
      const script = path.join(process.resourcesPath,'local-tools','setup-tools-mac.py');
      const local = fs.existsSync(script) ? script : path.join(__dirname,'..','local-tools','setup-tools-mac.py');
      // Installation output is dependency metadata, not application requests or credentials.
      await run(python,[local],store.directory,600000);return true;
    },
    async skillToggle(p) { return (await engine()).request('skills/config/write', { path: p.path, enabled: !!p.enabled }); },
    async updateInfo() {
      const sourceFile = path.join(store.directory, process.platform === 'win32' ? 'windows-install.json' : 'install-source.json');
      const record = fs.existsSync(sourceFile) ? JSON.parse(fs.readFileSync(sourceFile, 'utf8')) : {};
      const source = record.source || path.join(__dirname, '..');
      const sourceAvailable = fs.existsSync(path.join(source, 'package.json'));
      const node = process.platform === 'win32' ? path.join(store.directory, 'tools', 'runtime', 'node.exe') : ['/opt/homebrew/bin/node','/usr/local/bin/node'].find(file => fs.existsSync(file));
      return { version: app.getVersion(), platform: process.platform, source, sourceAvailable, updateAvailable: sourceAvailable && !!record.sourceHash && sourceHash(source) !== record.sourceHash, canInstall: !!node && fs.existsSync(node), installed: app.getAppPath(), command: process.platform === 'win32' ? '启动.cmd' : '启动.command' };
    },
    async openUpdateSource() {
      const info = await actions.updateInfo(); if (!info.sourceAvailable) throw new Error('这台设备尚未定位到同步源码，请打开 Syncthing 的 CodexDesk 目录');
      const result = await shell.openPath(info.source); if (result) throw new Error(result); return true;
    },
    async installUpdate() {
      if (activeTurns.size || terminals?.size || imageBusy()) throw new Error('请先完成任务、图像生成并关闭终端，再安装更新');
      const info = await actions.updateInfo();
      if (!info.sourceAvailable || !info.canInstall) throw new Error('同步源码或本机 Node.js 不可用，请从同步目录手动更新');
      await confirm('退出并安装同步目录中的更新？', info.source + '\n保留独立设置和对话；安装结果写入源码 artifacts/local-update.log。');
      const node = process.platform === 'win32' ? path.join(store.directory, 'tools', 'runtime', 'node.exe') : ['/opt/homebrew/bin/node','/usr/local/bin/node'].find(file => fs.existsSync(file));
      fs.mkdirSync(path.join(info.source, 'artifacts'), { recursive: true });
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CODEX|OPENAI|CHATGPT|SUB2API|ELECTRON_RUN_AS_NODE)|API_KEY|TOKEN|SECRET/i.test(name)));
      const child = spawn(node, [path.join(info.source, 'scripts', 'update-installed.cjs'), info.source, String(process.pid)], { cwd: info.source, env, detached: true, windowsHide: true, stdio: 'ignore' });
      await new Promise((resolve,reject) => { child.once('spawn',resolve); child.once('error',reject); });child.unref();
      setTimeout(() => app.quit(), 100);return true;
    },
    async ghCheck(p) { return run('gh', ['auth', 'status'], workspace.root(p.cwd)); },
  };
  Object.assign(handlers, actions);
  const pump = () => workspace.pump({ active: id => activeTurns.has(id), available: () => !!store.readKey(), start: job => handlers.turn({ ...job, files: [] }), notify: job => send({ method: 'desk/jobFailed', params: { id: job.id, error: job.error } }) }).catch(() => {});
  const timer = setInterval(pump, 2000); timer.unref();
  return {
    workspace,
    tokenUsage(threadId,value) {
      const total=value?.total;if(!total)return;
      workspace.data.usage ||= {};workspace.data.usage[threadId]=Object.fromEntries(['totalTokens','inputTokens','outputTokens','cachedInputTokens','reasoningOutputTokens'].map(key=>[key,Number.isFinite(total[key])?total[key]:0]));workspace.save();
    },
    completed(threadId, turn) {
      workspace.complete(threadId, turn); send({ method: 'desk/jobsChanged' });
      syncOne(threadId).catch(error => send({ method: 'desk/syncError', params: { message: redact(error.message) } }));
      if (process.env.CODEX_DESK_UI_TEST !== '1' && store.settings.notifications === true && !getWindow()?.isFocused() && Notification.isSupported()) {
        const notification = new Notification({ title: 'Codex Desk', body: turn.status === 'completed' ? '任务已完成' : '任务已结束，请查看结果' });
        notification.on('click', () => { getWindow()?.show(); getWindow()?.focus(); send({ method: 'desk/openThread', params: { threadId } }); }); notification.show();
      }
      setImmediate(pump);
    },
    stop() { clearInterval(timer); },
  };
}
module.exports = { installWorkspace };
