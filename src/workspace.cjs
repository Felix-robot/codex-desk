// Local workflows shared by the Windows and macOS clients. No renderer shell access.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { writePrivate, inside } = require('./storage.cjs');
const exec = promisify(execFile);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const secretName = name => /^(?:\.env(?:\..*)?|auth\.json|credential\.bin|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12))$/i.test(name);
function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:CODEX|OPENAI|CHATGPT|SUB2API)|(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(key)));
}
async function run(command, args, cwd, timeout = 60000) {
  try { return (await exec(command, args, { cwd, env: cleanEnv(), windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 })).stdout; }
  catch (error) { throw new Error(String(error.stderr || error.message).slice(0, 2000)); }
}
class Workspace {
  constructor({ directory, roots, readonly = () => false }) {
    Object.assign(this, { directory, roots, readonly });
    this.file = path.join(directory, 'workspace.json');
    this.data = { version: 1, pinned: [], order: [], jobs: [], syncDirectory: '', syncThreads: [] };
    if (fs.existsSync(this.file)) {
      try {
        const saved=JSON.parse(fs.readFileSync(this.file,'utf8'));
        if(saved.version!==1||!Array.isArray(saved.pinned)||!Array.isArray(saved.order)||!Array.isArray(saved.jobs)||typeof saved.syncDirectory!=='string'||!Array.isArray(saved.syncThreads))throw new Error('metadata');
        if(saved.jobs.some(job=>!job||typeof job.id!=='string'||typeof job.threadId!=='string'||typeof job.text!=='string'||!Number.isFinite(job.when)))throw new Error('jobs');
        Object.assign(this.data,saved);
      }catch{
        const backup=this.file+`.invalid-${Date.now()}`;writePrivate(backup,fs.readFileSync(this.file));
        this.data.notice='工作区偏好格式异常，原文件已备份，未自动恢复待执行任务。';
      }
    }
    for (const job of this.data.jobs) if (job.status === 'running') { job.status = 'interrupted'; job.error = '应用已退出，请检查任务结果后手动重试'; }
    this.save();
  }
  save() { writePrivate(this.file, JSON.stringify(this.data, null, 2)); }
  writable() { if (this.readonly()) throw new Error('当前为只读权限，请先切换执行权限'); }
  root(cwd) {
    if (!this.roots().includes(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('请先选择项目');
    return fs.realpathSync(cwd);
  }
  filePath(cwd, input) {
    const root = this.root(cwd), file = fs.realpathSync(path.resolve(root, input));
    const official = path.join(os.homedir(), '.codex');
    if (!inside(root, file) || fs.existsSync(official) && inside(official, file) || inside(this.directory, file) || file.split(path.sep).some(secretName) || file.split(path.sep).some(n => n.toLowerCase() === '.git') || !fs.statSync(file).isFile()) throw new Error('文件不在可编辑的项目范围内');
    if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('文本编辑上限2 MB');
    return file;
  }
  read(cwd, input) {
    const file = this.filePath(cwd, input), bytes = fs.readFileSync(file);
    if (bytes.includes(0)) throw new Error('请用外部程序打开二进制文件');
    return { path: file, text: bytes.toString('utf8'), revision: hash(bytes) };
  }
  snapshots(file) {
    const folder = path.join(this.directory, 'checkpoints', hash(file));
    return fs.existsSync(folder) ? fs.readdirSync(folder).filter(n => n.endsWith('.json')).sort().reverse().map(n => {
      const record = JSON.parse(fs.readFileSync(path.join(folder, n), 'utf8'));
      return { id: n, createdAt: record.createdAt, revision: record.revision };
    }) : [];
  }
  write(cwd, input, text, revision) {
    this.writable();
    if (typeof text !== 'string' || Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('文本编辑上限2 MB');
    const current = this.read(cwd, input);
    if (current.revision !== revision) throw new Error('文件已被其他程序修改，请重新读取后再保存');
    const folder = path.join(this.directory, 'checkpoints', hash(current.path));
    const record = { createdAt: Date.now(), revision, text: current.text };
    writePrivate(path.join(folder, `${Date.now()}-${crypto.randomUUID()}.json`), JSON.stringify(record));
    const mode = fs.statSync(current.path).mode;
    writePrivate(current.path, text); fs.chmodSync(current.path, mode);
    for (const old of this.snapshots(current.path).slice(20)) fs.unlinkSync(path.join(folder, old.id));
    return this.read(cwd, current.path);
  }
  restore(cwd, input, id, revision) {
    const current = this.read(cwd, input);
    if (!this.snapshots(current.path).some(s => s.id === id)) throw new Error('检查点不存在');
    const record = JSON.parse(fs.readFileSync(path.join(this.directory, 'checkpoints', hash(current.path), id), 'utf8'));
    return this.write(cwd, current.path, record.text, revision);
  }
  tree(cwd, input = '.') {
    const root = this.root(cwd), folder = fs.realpathSync(path.resolve(root, input));
    const official = path.join(os.homedir(), '.codex');
    if (!inside(root, folder) || fs.existsSync(official) && inside(official, folder) || inside(this.directory, folder) || folder.split(path.sep).some(n => secretName(n) || n.toLowerCase() === '.git')) throw new Error('目录不在项目内');
    return { folder, entries: fs.readdirSync(folder, { withFileTypes: true }).filter(e => !secretName(e.name) && !['.git', 'node_modules', '.DS_Store'].includes(e.name)).slice(0, 500).map(e => ({ name: e.name, path: path.join(folder, e.name), directory: e.isDirectory(), symbolicLink: e.isSymbolicLink() })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)) };
  }
  async git(cwd, operation, p = {}) {
    cwd = this.root(cwd);
    const git = args => run('git', args, cwd);
    if (operation === 'status') {
      const [status, branch, branches, worktrees, staged, unstaged] = await Promise.all([
        git(['status', '--porcelain=v1', '-z', '-uall']), git(['branch', '--show-current']), git(['branch', '--format=%(refname:short)']),
        git(['worktree', 'list', '--porcelain']), git(['diff', '--cached', '--no-ext-diff', '--no-color']), git(['diff', '--no-ext-diff', '--no-color'])
      ]);
      const tokens = status.split('\0'), files = [];
      for (let i = 0; i < tokens.length; i++) if (tokens[i]) {
        const entry = tokens[i], item = { status: entry.slice(0, 2), path: entry.slice(3) };
        if (/[RC]/.test(item.status)) item.oldPath = tokens[++i];
        files.push(item);
      }
      return { branch: branch.trim(), branches: branches.trim().split('\n').filter(Boolean), worktrees, files, staged, unstaged };
    }
    if (operation === 'fileDiff') {
      const file = this.filePath(cwd, p.path);
      const diff = await git(['diff', '--no-ext-diff', '--no-color', '--', path.relative(cwd, file)]);
      return { diff, revision: hash(diff) };
    }
    if (operation === 'prStatus') {
      try { return JSON.parse(await run('gh', ['pr', 'list', '--json', 'number,title,url,state,headRefName'], cwd)); }
      catch (e) { throw new Error('GitHub CLI 未就绪或尚未授权：' + e.message); }
    }
    this.writable();
    if (['stage', 'unstage'].includes(operation)) {
      if (typeof p.path !== 'string' || p.path.startsWith('-') || path.isAbsolute(p.path) || p.path.split(/[\\/]/).includes('..') || p.path.split(/[\\/]/).some(secretName)) throw new Error('无效 Git 文件路径');
      // git add supports deleted files; the real parent must still be inside the project.
      if (!inside(cwd, fs.realpathSync(path.dirname(path.resolve(cwd, p.path))))) throw new Error('文件越过项目边界');
      return git(operation === 'stage' ? ['add', '--', p.path] : ['restore', '--staged', '--', p.path]);
    }
    if (operation === 'stageHunk') {
      const { diff, revision } = await this.git(cwd, 'fileDiff', p);
      if (revision !== p.revision) throw new Error('差异已变化，请刷新');
      const parts = diff.split(/(?=^@@ )/m), header = parts.shift();
      if (!Number.isInteger(p.index) || !parts[p.index] || !header.startsWith('diff --git ')) throw new Error('差异块不存在');
      const patch = header + parts[p.index];
      const temporary = path.join(this.directory, `stage-${crypto.randomUUID()}.patch`);
      writePrivate(temporary, patch);
      try { await git(['apply', '--cached', '--check', temporary]); return await git(['apply', '--cached', temporary]); }
      finally { fs.unlinkSync(temporary); }
    }
    if (operation === 'commit') {
      if (typeof p.message !== 'string' || !p.message.trim() || p.message.length > 10000) throw new Error('请填写提交说明');
      return git(['commit', '-m', p.message]);
    }
    if (['branch', 'switch', 'merge', 'worktree'].includes(operation)) {
      if (typeof p.branch !== 'string' || p.branch.startsWith('-') || p.branch.includes('\0')) throw new Error('分支名无效');
      await git(['check-ref-format', '--branch', p.branch]);
      if (operation === 'branch') return git(['switch', '-c', p.branch]);
      if (operation === 'switch') return git(['switch', p.branch]);
      if (operation === 'merge') return git(['merge', '--no-edit', p.branch]);
      if (!path.isAbsolute(p.destination) || fs.existsSync(p.destination)) throw new Error('请选择尚不存在的新工作树目录');
      return git(['worktree', 'add', p.destination, p.branch]);
    }
    if (operation === 'prCreate') {
      if (!p.title?.trim() || typeof p.body !== 'string') throw new Error('请填写 PR 标题与说明');
      const file = path.join(this.directory, `pr-${crypto.randomUUID()}.txt`); writePrivate(file, p.body);
      try { return await run('gh', ['pr', 'create', '--draft', '--title', p.title, '--body-file', file], cwd); }
      finally { fs.unlinkSync(file); }
    }
    if (operation === 'prMerge') {
      if (!/^\d+$/.test(String(p.number))) throw new Error('PR 编号无效');
      // Resolve and require the exact head reviewed in the UI, guarding concurrent pushes.
      if (!/^[a-f0-9]{40}$/.test(p.head)) throw new Error('请先读取 PR 的当前提交再合并');
      return run('gh', ['pr', 'merge', String(p.number), '--merge', '--match-head-commit', p.head], cwd);
    }
    if (operation === 'prRead') return JSON.parse(await run('gh', ['pr', 'view', String(Number(p.number)), '--json', 'number,title,url,headRefOid,mergeable'], cwd));
    throw new Error('不支持的 Git 操作');
  }
  pin(id, value) {
    this.data.pinned = this.data.pinned.filter(x => x !== id); if (value) this.data.pinned.unshift(id); this.save(); return this.data;
  }
  order(ids) { this.data.order = [...new Set(ids.map(String))].slice(0, 10000); this.save(); return this.data; }
  addJob(input) {
    if (!input.text?.trim() || input.text.length > 100000 || !input.threadId) throw new Error('请指定对话和任务内容');
    const when = input.when ? Date.parse(input.when) : Date.now();
    if (!Number.isFinite(when) || input.when && when <= Date.now()) throw new Error('请选择未来的时间');
    const interval = Number(input.interval || 0);
    if (interval && (!Number.isFinite(interval) || interval < 15)) throw new Error('重复间隔至少15分钟');
    const job = { id: crypto.randomUUID(), threadId: input.threadId, text: input.text, when, interval, status: 'queued', createdAt: Date.now(), mode: input.mode === 'plan' ? 'plan' : 'default', model: input.model, effort: input.effort };
    this.data.jobs.push(job); this.save(); return job;
  }
  cancelJob(id) {
    const job = this.data.jobs.find(j => j.id === id);
    if (!job || job.status === 'running') throw new Error('运行中的任务请在对话中停止');
    job.status = 'cancelled'; this.save();
  }
  async pump({ active, start, available = () => true, notify = () => {} }, now = Date.now()) {
    if (this.pumping || !available()) return;
    this.pumping = true;
    try {
      for (const job of this.data.jobs) {
        if (job.status !== 'queued' || job.when > now || active(job.threadId)) continue;
        if (now - job.when > 120000 && job.when > job.createdAt) { job.status = 'missed'; job.error = '错过预定时间，未补发请求'; this.save(); continue; }
        job.status = 'running'; this.save();
        try { const result = await start(job); if (job.status === 'running') job.turnId = result.turn.id; }
        catch (e) { job.status = 'failed'; job.error = e.message; notify(job); }
        this.save();
      }
    } finally { this.pumping = false; }
  }
  complete(threadId, turn) {
    for (const job of this.data.jobs.filter(j => j.threadId === threadId && j.status === 'running' && (!j.turnId || j.turnId === turn.id))) {
      job.status = turn.status === 'completed' ? 'completed' : 'failed'; job.finishedAt = Date.now();
      if (job.interval && job.status === 'completed') this.data.jobs.push({ ...job, id: crypto.randomUUID(), createdAt: Date.now(), when: Date.now() + job.interval * 60000, status: 'queued', turnId: undefined, finishedAt: undefined });
    }
    this.save();
  }
}
module.exports = { Workspace, run, hash, secretName };
