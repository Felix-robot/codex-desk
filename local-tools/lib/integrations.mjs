import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOME = path.join(os.homedir(), '.codex');
export const MCP_PRESETS = {
  openai_docs: { name: 'OpenAI 官方文档', url: 'https://developers.openai.com/mcp', defaultEnabled: true },
  figma: { name: 'Figma', url: 'https://mcp.figma.com/mcp', oauth: true },
  notion: { name: 'Notion', url: 'https://mcp.notion.com/mcp', oauth: true },
};
export function githubStatus() {
  return new Promise(resolve=>{
    const proc=spawn('gh',['auth','status','--active'],{windowsHide:true,stdio:'ignore',env:{...process.env,GH_PROMPT_DISABLED:'1'}});
    const timer=setTimeout(()=>{proc.kill();resolve({installed:true,authenticated:false})},10000);
    proc.on('error',()=>{clearTimeout(timer);resolve({installed:false,authenticated:false})});
    proc.on('exit',code=>{clearTimeout(timer);resolve({installed:true,authenticated:code===0})});
  });
}
const localPlugins = new Set(['pdf', 'zotero']);
const localAdapters = new Set(['documents', 'spreadsheets', 'presentations', 'template-creator']);
export function integrationSettings(data) {
  try { return JSON.parse(fs.readFileSync(path.join(data, 'integrations.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; return { servers: {}, disabledSkills: [] }; }
}
export function runtimePaths(data, platform = process.platform) {
  const installed = platform === 'darwin' ? path.join(os.homedir(),'Library','Application Support','Codex Desk','tools') : path.join(os.homedir(),'.codex-desk','tools');
  const prefer = relative => fs.existsSync(path.join(data,relative)) ? path.join(data,relative) : path.join(installed,relative);
  const first = choices => choices.find(p=>p&&fs.existsSync(p)) || choices.find(Boolean);
  const nodeModules=prefer(path.join('browser','node_modules'));
  if(platform==='darwin') return {
    python:first([prefer(path.join('python','bin','python3')),'/opt/homebrew/bin/python3','/usr/local/bin/python3','/usr/bin/python3']),
    node:first([prefer(path.join('runtime','node')),'/opt/homebrew/bin/node','/usr/local/bin/node']),nodeModules,
    playwright:path.join(nodeModules,'playwright','index.mjs'),poppler:first(['/opt/homebrew/bin','/usr/local/bin']),
    browser:first(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'])
  };
  return {python:prefer(path.join('python','Scripts','python.exe')),node:prefer(path.join('runtime','node.exe')),nodeModules,
    playwright:path.join(nodeModules,'playwright','index.mjs'),poppler:prefer(path.join('poppler','Library','bin')),
    browser:[path.join(process.env.ProgramFiles||'C:/Program Files','Google','Chrome','Application','chrome.exe'),path.join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Microsoft','Edge','Application','msedge.exe')].find(fs.existsSync)};
}
export function discoverPlugins() {
  const cache = path.join(HOME, 'plugins', 'cache');
  const rows = [];
  if (!fs.existsSync(cache)) return rows;
  for (const market of fs.readdirSync(cache, { withFileTypes: true }).filter(x => x.isDirectory())) {
    for (const dir of fs.readdirSync(path.join(cache, market.name), { withFileTypes: true }).filter(x => x.isDirectory())) {
      const base = path.join(cache, market.name, dir.name);
      const versions = fs.readdirSync(base, { withFileTypes: true }).filter(x => x.isDirectory() && fs.existsSync(path.join(base, x.name, '.codex-plugin', 'plugin.json')));
      versions.sort((a,b) => fs.statSync(path.join(base,b.name)).mtimeMs - fs.statSync(path.join(base,a.name)).mtimeMs);
      if (!versions.length) continue;
      const root = path.join(base, versions[0].name);
      let m; try { m = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin', 'plugin.json'), 'utf8')); } catch { continue; }
      const skillRoot = typeof m.skills === 'string' ? path.resolve(root, m.skills) : null;
      const local = localPlugins.has(m.name);
      const adapter = localAdapters.has(m.name);
      rows.push({ id: `${m.name}@${market.name}`, name: m.name, version: m.version || versions[0].name, root,
        skillRoot: skillRoot && fs.existsSync(skillRoot) ? skillRoot : null,
        state: local ? 'local' : adapter ? 'adapted' : 'needs-service',
        detail: local ? '本地技能与脚本' : adapter ? '使用工作台本地文档适配技能；云端编辑器未接入' : '需要独立服务或官方桌面接口；未复用账号凭据' });
    }
  }
  return rows;
}
export function extraSkillRoots() {
  return [path.join(HOME, 'skills'), path.join(ROOT, 'skills'), ...discoverPlugins().filter(p => p.state === 'local' && p.skillRoot).map(p => p.skillRoot)];
}
const toml = value => JSON.stringify(value);
export function integrationConfig(data) {
  const p = runtimePaths(data), s = integrationSettings(data);
  let text = '\n# Managed by Sub2API Desk; account credentials are never imported.\nmcp_oauth_credentials_store = "file"\n';
  // The root-level credential setting must be emitted before TOML tables.
  const tables = [`\n[mcp_servers.desk_tools]\ncommand = ${toml(p.node)}\nargs = [${toml(path.join(ROOT, 'tools', 'mcp-server.mjs'))}]\nenv = { SUB2API_DESK_DATA = ${toml(data)} }\nstartup_timeout_sec = 30\ntool_timeout_sec = 120\n`];
  for (const [id, preset] of Object.entries(MCP_PRESETS)) {
    if (s.servers?.[id] ?? preset.defaultEnabled ?? false) tables.push(`\n[mcp_servers.${id}]\nurl = ${toml(preset.url)}\nstartup_timeout_sec = 30\ntool_timeout_sec = 60\n`);
  }
  for (const skill of s.disabledSkills || []) tables.push(`\n[[skills.config]]\npath = ${toml(skill)}\nenabled = false\n`);
  return { root: text, tables: tables.join('') };
}
export function pythonProbe(data) {
  const p = runtimePaths(data);
  if (!fs.existsSync(p.python)) return Promise.resolve({ ready: false, error: '独立 Python 环境尚未安装', modules: {} });
  return new Promise(resolve => {
    const code = "import importlib.util,json,sys;mods=['docx','pypdf','pdfplumber','openpyxl','pptx','reportlab','matplotlib','numpy','pandas','scipy','seaborn','shap','umap','nbformat','plotly','statsmodels','sklearn'];print(json.dumps({'ready':True,'python':sys.executable,'modules':{m:bool(importlib.util.find_spec(m)) for m in mods}}))";
    const child = spawn(p.python, ['-c', code], { windowsHide: true, stdio: ['ignore','pipe','ignore'] });
    let output = ''; child.stdout.on('data', b => output += b);
    const timer = setTimeout(() => { child.kill(); resolve({ ready: false, error: 'Python 检查超时', modules: {} }); }, 20000);
    child.on('error', () => { clearTimeout(timer); resolve({ ready: false, error: 'Python 启动失败', modules: {} }); });
    child.on('exit', () => { clearTimeout(timer); try { resolve(JSON.parse(output)); } catch { resolve({ ready: false, error: 'Python 检查失败', modules: {} }); } });
  });
}
export function skillReadiness(skill, servers, python) {
  const location = String(skill.path).replaceAll('\\','/');
  const name = skill.name.toLowerCase();
  const missing = [];
  const modules = python.modules || {};
  const requirements = { matplotlib:['matplotlib'], seaborn:['seaborn'], shap:['shap'], 'umap-learn':['umap'], 'jupyter-notebook':['nbformat'], 'statistical-analysis':['scipy','statsmodels'], 'scientific-visualization':['matplotlib'], 'paper-figures-tables':['matplotlib'], 'desk-artifacts':['docx','pypdf','openpyxl','pptx'], 'pdf:pdf':['pypdf','pdfplumber','reportlab'] };
  for (const m of requirements[name] || []) if (!modules[m]) missing.push('Python: ' + m);
  for (const dep of skill.dependencies?.tools || []) {
    const id = dep.value || dep.name || dep.command;
    if (id && !servers.some(s => s.name === id && s.runtimeStatus === 'connected')) missing.push('工具: ' + id);
  }
  if (name === 'imagegen' || /figma|sites:|visualize:|work-pets|plugin-management|pages:|notion:/.test(name)) missing.push('原技能依赖官方客户端或独立外部服务');
  if (/figma/.test(name) && servers.some(s => s.name === 'figma' && s.toolCount > 0)) return { state:'partial', missing:['已接通标准 Figma MCP；原插件专属操作不等同于标准 MCP'] };
  if (name === 'zotero:zotero' || name === 'zotero') return { state:'partial', missing:['本地脚本已接入；使用时检查 Zotero 是否启动并开放本地 API'] };
  if (/openai-docs/.test(name) && !servers.some(s => s.name === 'openai_docs' && s.toolCount > 0)) missing.push('OpenAI 文档 MCP 未连通');
  return { state: !skill.enabled ? 'disabled' : missing.length ? 'partial' : 'ready', missing, source: location.includes('/plugins/cache/') ? 'plugin' : 'local' };
}
