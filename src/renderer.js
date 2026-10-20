/* The renderer has no Node access. Local work goes through the narrow preload API. */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const base = (p = '') => p.split(/[\\/]/).filter(Boolean).pop() || '工作台';
const state = {
  settings: null, threads: [], current: null, cwd: '', active: new Map(), requests: new Map(),
  turns: new Map(), files: [], skill: null, threadCursor: null, historyCursor: null,
  archived: false, connected: false, loading: false, started: 0, detail: 'changes',
  git: null, terminal: null, terminalId: null, terminalPending: [], models: [], completedTurns: new Set(),
};
let toastTimer, renderTimer, searchTimer;
let followBottom = true;
let selectionSequence = 0;
let collapsedProjects = new Set();
try { collapsedProjects = new Set(JSON.parse(localStorage.getItem('collapsed-projects') || '[]')); } catch {}
const pathKey = (p = '') => { const value = String(p || '').replaceAll('\\','/').replace(/\/+$/,''); return window.desk.platform === 'win32' ? value.toLowerCase() : value; };
const projectName = (p) => state.settings?.projectNames?.[p] || base(p);
function threadProject(thread) {
  const assigned = state.settings?.threadProjects?.[thread.id];
  if (state.settings.projects.includes(assigned)) return assigned;
  const key = pathKey(thread.cwd);
  return state.settings.projects.filter((p) => key === pathKey(p) || key.startsWith(pathKey(p) + '/')).sort((a,b) => b.length-a.length)[0] || '';
}
const call = (name, params) => window.desk.call(name, params);
function errorText(error) { return String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
function toast(text) { clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500); }
function action(fn) { return async (...args) => { try { return await fn(...args); } catch (e) { toast(errorText(e)); } }; }
function theme() {
  document.body.classList.toggle('dark', state.settings.theme === 'dark' || state.settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const dark = document.body.classList.contains('dark');
  $('#theme-button').innerHTML = icon(dark ? 'sun' : 'moon');
  $('#theme-button').title = dark ? '切换浅色模式' : '切换深色模式';
  $('#theme-button').setAttribute('aria-label', $('#theme-button').title);
  updateTerminalTheme();
}
function banner(text) {
  $('#banner').hidden = !text;
  $('#banner').replaceChildren();
  if (text) { const span = document.createElement('span'); span.textContent = text; const button = document.createElement('button'); button.textContent = '打开设置'; button.onclick = action(openSettings); $('#banner').append(span, button); }
}
function connection(value) {
  state.connected = value.connected;
  if (!value.connected && state.active.size) { state.active.clear(); updateRunning(); renderThreads(); }
  $('#connection-label').classList.toggle('online', value.connected);
  $('#connection-label').innerHTML = `<i class="status-dot"></i>${value.connected ? state.settings?.hasKey ? 'API 工作台 · 已连接' : '待填写 API key' : '点击设置检查连接'}`;
  if (value.error) banner(value.error);
  else if (!state.settings?.hasKey) banner('填写 API key 后即可开始。连接信息保存在独立工作台中。');
  else banner('');
}
function applySettings(settings) {
  state.settings = settings;
  if (!state.cwd || !state.current && !settings.projects.includes(state.cwd)) state.cwd = settings.projects[0] || '';
  $('#model-chip').innerHTML = `${escape(settings.model)} <span>⌄</span>`;
  $('#effort').value = settings.effort;
  $('#permission').value = settings.permission;
  const fontSize = settings.fontSize || 18;
  document.documentElement.style.setProperty('--chat-font-size', `${fontSize}px`);
  $('#font-size-button').textContent = `Aa ${fontSize}`;
  $('#font-size-button').title = `字号 ${fontSize} · 点击调整`;
  theme(); renderProjects(); updateContext();
}
function updateContext() {
  $('#breadcrumb').textContent = projectName(state.current ? threadProject(state.current) || state.cwd : state.cwd);
  $('#breadcrumb').title = state.cwd;
  $('#project-chip').textContent = state.cwd ? projectName(state.cwd) : '选择项目';
  $('#project-button').title = state.cwd || '选择项目';
  $('#welcome-subtitle').textContent = state.cwd ? `在 ${projectName(state.cwd)} 中开始` : '选择项目，开始对话。';
  $('.chat-column').classList.toggle('is-new', !state.current);
  $('#thread-title').textContent = state.current?.name || state.current?.preview?.slice(0, 50) || '新的对话';
  $('#thread-menu-button').disabled = !state.current;
  $('#thread-menu-button').title = state.current ? '重命名、分支、导出或归档对话' : '发送第一条消息后可管理对话';
}
function renderProjects() {
  const list = $('#projects'); list.innerHTML = '';
  if (!state.settings.projects.length) { list.innerHTML = '<div class="empty-projects">添加一个文件夹，开始本地工作。</div>'; return; }
  for (const cwd of state.settings.projects) {
    const group = document.createElement('section'); group.className = 'project-group'; group.dataset.project = cwd;
    const header = document.createElement('div'); header.className = 'project-heading';
    const toggle = document.createElement('button'); toggle.className = 'icon-button project-toggle'; toggle.innerHTML = icon('chevron'); toggle.title = '展开或收起项目对话';
    toggle.setAttribute('aria-expanded', String(!collapsedProjects.has(cwd)));
    toggle.onclick = () => { if (collapsedProjects.has(cwd)) collapsedProjects.delete(cwd); else collapsedProjects.add(cwd); localStorage.setItem('collapsed-projects', JSON.stringify([...collapsedProjects])); renderProjects(); };
    const selectedProject = state.current ? threadProject(state.current) : state.cwd;
    const button = document.createElement('button'); button.className = 'project' + (cwd === selectedProject ? ' selected' : '');
    button.innerHTML = `${icon('folder')}<span>${escape(projectName(cwd))}</span>`; button.title = cwd;
    button.onclick = () => { state.cwd = cwd; newChat(); refreshGit().catch(() => {}); };
    const menu = document.createElement('button'); menu.className = 'icon-button project-menu'; menu.innerHTML = icon('more'); menu.title = '项目操作：命名与新建对话'; menu.setAttribute('aria-label', `${projectName(cwd)}项目操作`);
    menu.onclick = () => openPopover(menu, [
      { label:'新建项目对话', run:() => { state.cwd=cwd;newChat(); } },
      { label:'重命名项目', description:'只改显示名，文件夹路径保持不变', run:async() => { const name=await inputDialog('重命名项目',projectName(cwd)); if(name)applySettings(await call('renameProject',{cwd,name})); } },
    ]);
    header.append(toggle, button, menu); group.append(header);
    const children = document.createElement('div'); children.className = 'project-subthreads'; children.hidden = collapsedProjects.has(cwd);
    for (const thread of visibleThreads().filter((t) => threadProject(t) === cwd)) children.append(threadRow(thread));
    group.append(children); list.append(group);
  }
}
function visibleThreads() { const term=$('#search').value.trim().toLowerCase(); return state.threads.filter((t)=>!term||(t.name||t.preview||'').toLowerCase().includes(term)).sort((a,b) => window.workspaceRank ? window.workspaceRank(a,b) : 0); }
function threadRow(thread) {
  const button=document.createElement('button');button.className='thread-row'+(thread.id===state.current?.id?' selected':'');button.dataset.threadId=thread.id;
  button.innerHTML=`${state.active.has(thread.id)?'<i class="live-dot"></i>':''}<span>${escape(thread.name||thread.preview||'新的对话')}</span><small>${relativeTime(thread.updatedAt)}</small>`;
  button.title=`${thread.name||thread.preview||'新的对话'}\n${thread.cwd||''}`;button.onclick=action(()=>selectThread(thread));return button;
}
function relativeTime(seconds) {
  const difference = Date.now() / 1000 - seconds;
  return difference < 60 ? '刚刚' : difference < 3600 ? `${Math.floor(difference / 60)} 分钟` : difference < 86400 ? `${Math.floor(difference / 3600)} 小时` : difference < 604800 ? `${Math.floor(difference / 86400)} 天` : new Date(seconds * 1000).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
function renderThreads() {
  const list = $('#threads'); list.innerHTML = '';
  const term = $('#search').value.trim().toLowerCase();
  const all = visibleThreads(); const threads = all.filter((t) => !threadProject(t));
  if (!all.length && term) list.innerHTML = '<div class="history-empty">没有找到匹配的对话。</div>';
  for (const thread of threads) {
    list.append(threadRow(thread));
  }
  renderProjects();
  $('#history-label').textContent = state.archived ? '其他归档' : '其他对话';
  $('#archive-toggle').textContent = state.archived ? '返回' : '归档';
  $('#more-threads').hidden = !state.threadCursor;
}
async function refreshThreads(append = false) {
  const result = await call('list', { archived: state.archived, search: $('#search').value.trim(), ...(append ? { cursor: state.threadCursor } : {}) });
  state.threads = append ? [...state.threads, ...result.data.filter((t) => !state.threads.some((x) => x.id === t.id))] : result.data;
  state.threadCursor = result.nextCursor; renderThreads();
}
function newChat() {
  selectionSequence++; state.current = null; state.turns.clear(); state.historyCursor = null; state.files = []; state.skill = null;
  $('#messages').innerHTML = ''; $('#welcome').hidden = false; $('#older-turns').hidden = true; $('#token-usage').textContent = '';
  $('#prompt').value = ''; sizePrompt(); updateContext(); renderProjects(); renderThreads(); renderAttachments(); renderApprovals(); updateRunning();
  $('#prompt').focus();
}
async function selectThread(thread, older = false) {
  const sequence = ++selectionSequence;
  if (!older) {
    state.current = thread; state.cwd = thread.cwd; state.turns.clear(); state.historyCursor = null;
    state.files = []; state.skill = null; renderAttachments(); $('#messages').innerHTML = ''; $('#welcome').hidden = true;
    $('#messages').innerHTML = '<div class="detail-empty">正在载入对话…</div>';
    updateContext(); renderProjects(); renderThreads(); renderApprovals(); updateRunning();
  }
  const result = await call('history', { threadId: thread.id, ...(older ? { cursor: state.historyCursor } : {}) });
  if (sequence !== selectionSequence) return;
  state.current = result.thread; state.cwd = result.thread.cwd;
  for (const turn of result.data) {
    // Live notifications may arrive while history is being read; retain the live version.
    if (!state.turns.has(turn.id)) state.turns.set(turn.id, turn);
  }
  state.turns = new Map([...state.turns].sort(([, a], [, b]) => (a.startedAt || 0) - (b.startedAt || 0)));
  state.historyCursor = result.nextCursor;
  for (const request of result.requests) state.requests.set(String(request.id), request);
  if (result.activeTurn) state.active.set(thread.id, result.activeTurn);
  updateContext(); renderMessages(); renderApprovals(); updateRunning();
  if (!older) { followBottom = true; scrollBottom(); }
  refreshGit().catch(() => {});
}
function getTurn(id) {
  if (!state.turns.has(id)) state.turns.set(id, { id, items: [], status: 'inProgress', startedAt: Date.now() / 1000 });
  return state.turns.get(id);
}
function getItem(params, type = 'agentMessage') {
  const turn = getTurn(params.turnId);
  let item = turn.items.find((item) => item.id === params.itemId);
  if (!item) { item = { id: params.itemId, type, text: '', aggregatedOutput: '', summary: [] }; turn.items.push(item); }
  return item;
}
function upsertItem(turnId, incoming) {
  if (incoming.type === 'userMessage') {
    for (const id of state.turns.keys()) if (id.startsWith('optimistic-')) state.turns.delete(id);
  }
  const turn = getTurn(turnId);
  if (incoming.type === 'userMessage') turn.items = turn.items.filter((item) => item.id !== 'pending-user');
  const index = turn.items.findIndex((item) => item.id === incoming.id);
  if (index < 0) turn.items.push(incoming); else turn.items[index] = { ...turn.items[index], ...incoming };
}
function markdown(text, baseFile = '') {
  const html = DOMPurify.sanitize(marked.parse(text || '', { breaks: false }), {
    FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button', 'video', 'audio'],
    FORBID_ATTR: ['style'],
    // File links are handled by our own explicit click path. No navigation occurs.
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|file):|[a-z]:[\\/]|data:image\/(?:png|jpeg|gif|webp);base64,|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  });
  const div = document.createElement('div'); div.className = 'markdown'; div.innerHTML = html;
  window.typesetMath(div);
  div.dataset.baseFile = baseFile;
  $$('h1,h2,h3,h4,h5,h6', div).forEach((heading) => { heading.id = heading.textContent.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, ''); });
  $$('a', div).forEach((link) => { link.title = link.getAttribute('href') || '此链接地址不可用'; });
  $$('img', div).forEach((img) => {
    // Never fetch remote tracking images, or load arbitrary local paths through Chromium.
    const src = img.getAttribute('src') || '';
    if (!src.startsWith('data:image/')) { const link = document.createElement('a'); link.textContent = img.alt || '查看图片'; link.setAttribute('href', src); img.replaceWith(link); }
  });
  $$('pre', div).forEach((pre) => {
    const button = document.createElement('button'); button.className = 'copy-code'; button.textContent = '复制';
    button.onclick = action(async () => { await call('copyText', { text: $('code', pre)?.textContent || pre.textContent }); button.textContent = '已复制'; }); pre.append(button);
  });
  return div;
}
function toolSummary(item) {
  switch (item.type) {
    case 'commandExecution': return ['terminal', item.command || '运行命令'];
    case 'fileChange': return ['diff', `修改 ${(item.changes || []).length} 个文件`];
    case 'mcpToolCall': return ['skill', `${item.server} · ${item.tool}`];
    case 'collabAgentToolCall': return ['skill', `子代理 · ${item.tool}`];
    case 'subAgentActivity': return ['skill', `子代理 · ${item.agentPath || item.agentThreadId}`];
    case 'webSearch': return ['search', item.action?.query || item.query || '搜索网页'];
    case 'reasoning': return ['more', '思考摘要'];
    case 'imageView': return ['file', `查看图片 · ${base(item.path)}`];
    case 'contextCompaction': return ['refresh', '已整理对话上下文'];
    case 'enteredReviewMode': return ['diff', '开始代码审查'];
    case 'exitedReviewMode': return ['check', '代码审查完成'];
    case 'dynamicToolCall': return ['skill', item.tool];
    case 'imageGeneration': return ['file', '生成图片'];
    case 'functionCallOutput': return ['skill', item.name || '工具结果'];
    default: return ['skill', item.type];
  }
}
function renderItem(item) {
  if (item.type === 'hookPrompt') return null;
  if (['agentMessage', 'plan', 'userMessage'].includes(item.type)) {
    const div = document.createElement('article'); div.className = 'message ' + (item.type === 'userMessage' ? 'user' : 'agent');
    const heading = document.createElement('div'); heading.className = 'message-heading';
    heading.textContent = item.type === 'userMessage' ? '' : item.phase === 'commentary' ? '进展' : item.type === 'plan' ? '计划' : 'Codex';
    const text = item.type === 'userMessage' ? (item.content || []).map((c) => c.text || (c.path ? `附件：${c.path}` : '')).join('\n') : item.text || '';
    const copy = document.createElement('button'); copy.className = 'icon-button'; copy.title = '复制消息'; copy.setAttribute('aria-label','复制消息'); copy.innerHTML = icon('copy'); copy.onclick = action(async () => { await call('copyText', { text }); toast('已复制'); }); heading.append(copy);
    div.append(heading);
    if (item.type === 'userMessage') { const body = document.createElement('div'); body.className = 'user-text'; body.textContent = text; div.append(body); }
    else div.append(markdown(text));
    return div;
  }
  const details = document.createElement('details'); details.className = 'tool-item';
  if (item.type === 'reasoning') details.classList.add('reasoning');
  if (item.status === 'failed' || item.status === 'declined') details.classList.add('failed');
  if (item.status === 'inProgress') details.classList.add('running');
  const [symbol, label] = toolSummary(item);
  details.innerHTML = `<summary>${icon(symbol)}<span class="tool-label">${escape(label)}</span><span class="tool-status">${item.status === 'inProgress' ? '运行中' : item.status === 'failed' ? '失败' : item.status === 'declined' ? '已拒绝' : item.exitCode !== undefined && item.exitCode !== null ? `退出 ${item.exitCode}` : item.status === 'completed' ? '完成' : ''}</span>${icon('chevron')}</summary>`;
  const content = document.createElement('div'); content.className = 'tool-content';
  if (item.type === 'fileChange') {
    for (const change of item.changes || []) {
      const button = document.createElement('button'); button.className = 'file-button'; button.textContent = change.path; button.onclick = action(() => previewFile(change.path)); content.append(button, diffView(change.diff));
    }
  } else if (item.type === 'reasoning') content.textContent = (item.summary || []).join('\n\n');
  else if (item.type === 'imageView') { const button = document.createElement('button'); button.className = 'file-button'; button.textContent = '打开图片'; button.onclick = action(() => previewFile(item.path)); content.append(button); }
  else content.textContent = item.aggregatedOutput || (item.error ? JSON.stringify(item.error, null, 2) : item.result ? JSON.stringify(item.result, null, 2) : item.output ? typeof item.output === 'string' ? item.output : JSON.stringify(item.output, null, 2) : item.arguments ? JSON.stringify(item.arguments, null, 2) : item.prompt || item.review || item.text || '');
  details.append(content);
  details.dataset.itemId = item.id;
  return details;
}
function renderTurnError(error) {
  const raw = String(error.message || error);
  const div = document.createElement('div'); div.className = 'error-message';
  const message = document.createElement('div');
  message.textContent = /overloaded|server_overloaded/i.test(raw)
    ? '服务端当前过载，回复中断。稍后可发送“继续”重试，已完成的工具操作会保留。'
    : /stream disconnected before completion/i.test(raw)
      ? '回复连接在完成前中断。稍后可发送“继续”重试，已完成的工具操作会保留。'
      : raw;
  div.append(message);
  const details = document.createElement('details');
  const summary = document.createElement('summary'); summary.textContent = '查看原始错误';
  const pre = document.createElement('pre'); pre.textContent = raw;
  const copy = document.createElement('button'); copy.className = 'small-link'; copy.textContent = '复制错误';
  copy.onclick = action(async () => { await call('copyText', { text: raw }); copy.textContent = '已复制'; });
  details.append(summary, pre, copy); div.append(details);
  return div;
}
function renderMessages() {
  const opened = new Set($$('details[open]', $('#messages')).map((el) => el.dataset.itemId));
  const fragment = document.createDocumentFragment();
  for (const turn of state.turns.values()) {
    const items = turn.items || [];
    const lastAgent = items.findLast((item) => item.type === 'agentMessage');
    const processItems = [];
    const group = document.createElement('details'); group.className = 'process-group'; group.dataset.itemId = `process:${turn.id}`;
    let inserted = false;
    for (const item of items) {
      const node = renderItem(item);
      if (!node) continue;
      if (opened.has(item.id)) node.open = true;
      const progress = item.type !== 'userMessage' && (item.type !== 'agentMessage' || ['commentary', 'analysis'].includes(item.phase) || item !== lastAgent && item.phase !== 'final_answer');
      if (progress) {
        if (!inserted) { fragment.append(group); inserted = true; }
        processItems.push(node);
      } else fragment.append(node);
    }
    if (turn.plan) {
      const plan = document.createElement('div'); plan.className = 'plan-list';
      for (const step of turn.plan) { const div = document.createElement('div'); div.className = 'plan-step ' + (step.status === 'completed' ? 'done' : step.status === 'inProgress' ? 'in-progress' : ''); div.textContent = step.step; plan.append(div); }
      if (!inserted) { fragment.append(group); inserted = true; }
      processItems.push(plan);
    }
    if (processItems.length) {
      const summary = document.createElement('summary');
      summary.innerHTML = `${icon('chevron')}<span>处理过程</span><small>${processItems.length} 项</small>`;
      const body = document.createElement('div'); body.className = 'process-body'; body.append(...processItems); group.append(summary, body);
      group.open = opened.has(group.dataset.itemId);
    }
    if (turn.error) fragment.append(renderTurnError(turn.error));
  }
  $('#messages').replaceChildren(fragment);
  $('#welcome').hidden = !!state.current;
  $('#older-turns').hidden = !state.historyCursor;
  if (followBottom) scrollBottom();
}
function scheduleRender() { if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; renderMessages(); }, 65); }
function scrollBottom() { requestAnimationFrame(() => { const el = $('#conversation'); el.scrollTop = el.scrollHeight; $('#scroll-bottom').hidden = true; }); }
function updateRunning() {
  const running = !!state.current && state.active.has(state.current.id);
  $('#running').hidden = !running;
  const hasText = $('#prompt').value.trim().length > 0 || state.files.length > 0;
  $('#send').classList.toggle('stop', running && !hasText);
  $('#send').classList.toggle('steer', running && hasText);
  $('#send').innerHTML = running && !hasText ? '<svg viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" rx="1"/></svg>' : icon('arrow');
  $('#send').title = running ? hasText ? '向当前任务追加说明' : '停止任务' : '发送 · Enter';
  $('#send').setAttribute('aria-label', running ? hasText ? '追加说明' : '停止任务' : '发送');
  $('#send').disabled = state.loading;
  if (!running) $('#elapsed').textContent = '';
}
function renderAttachments() {
  const el = $('#attachments'); el.innerHTML = '';
  const items = [...state.files.map((f, i) => ({ name: f.name, thumbnail: f.thumbnail, path: f.path, symbol: f.image ? 'file' : 'attach', remove: () => state.files.splice(i, 1) })),
    ...(state.skill ? [{ name: '$' + state.skill.name, symbol: 'skill', remove: () => { state.skill = null; } }] : [])];
  for (const item of items) {
    const chip = document.createElement('div'); chip.className = 'attachment';
    chip.innerHTML = `${icon(item.symbol)}<span>${escape(item.name)}</span>`;
    if (item.thumbnail) { const image = document.createElement('img'); image.src = item.thumbnail; image.alt = item.name; image.className = 'attachment-thumbnail'; image.onclick = action(() => previewFile(item.path)); chip.prepend(image); }
    const button = document.createElement('button'); button.textContent = '×'; button.title = '移除附件'; button.onclick = () => { item.remove(); renderAttachments(); }; chip.append(button); el.append(chip);
  }
  updateRunning();
}
async function chooseProject() {
  const result = await call('chooseProject');
  if (!result) return;
  state.cwd = result.directory; applySettings(result.settings); newChat(); refreshGit().catch(() => {});
}
async function sendMessage() {
  if (state.loading) return;
  const text = $('#prompt').value.trim();
  if (state.current && state.active.has(state.current.id)) {
    if (text || state.files.length) { await call('steer', { threadId: state.current.id, text, files: state.files }); $('#prompt').value = ''; state.files = []; renderAttachments(); sizePrompt(); toast('已追加到当前任务'); }
    else await call('interrupt', { threadId: state.current.id });
    return;
  }
  if (!text && !state.files.length) return;
  if (!state.settings.hasKey) { await openSettings(); return; }
  if (!state.cwd) { await chooseProject(); if (!state.cwd) return; $('#prompt').value = text; }
  state.loading = true; updateRunning();
  let pendingTurn;
  try {
    if (!state.current) {
      const result = await call('create', { cwd: state.cwd }); state.current = result.thread; updateContext();
      const name = text.replace(/\s+/g, ' ').slice(0, 42) || '附件任务';
      await call('rename', { threadId: state.current.id, name }); state.current.name = name;
    }
    const threadId = state.current.id;
    pendingTurn = { id: 'optimistic-' + Date.now(), items: [{ type: 'userMessage', id: 'pending-user', content: [{ type: 'text', text }] }], status: 'inProgress', startedAt: Date.now() / 1000 };
    state.turns.set(pendingTurn.id, pendingTurn); renderMessages(); followBottom = true;
    const result = await call('turn', { threadId, text, files: state.files, skill: state.skill, model: state.settings.model, effort: $('#effort').value, mode: $('#work-mode')?.value || 'default' });
    state.turns.delete(pendingTurn.id);
    const live = getTurn(result.turn.id);
    if (!live.items.some((i) => i.type === 'userMessage')) live.items.unshift(pendingTurn.items[0]);
    if (!state.completedTurns.has(result.turn.id)) state.active.set(threadId, result.turn.id); state.started = Date.now();
    $('#prompt').value = ''; state.files = []; state.skill = null; renderAttachments(); sizePrompt();
    refreshThreads().catch(() => {}); updateContext();
    return {threadId,turn:result.turn};
  } catch (error) { if (pendingTurn) state.turns.delete(pendingTurn.id); throw error; }
  finally { state.loading = false; renderMessages(); updateRunning(); }
}
function renderApprovals() {
  const area = $('#approval-area'); area.innerHTML = '';
  for (const request of state.requests.values()) {
    const p = request.params;
    if (p.threadId && p.threadId !== state.current?.id) continue;
    const card = document.createElement('div'); card.className = 'approval-card';
    const method = request.method;
    if (method === 'item/tool/requestUserInput') {
      card.innerHTML = '<h3>需要你补充一点信息</h3>';
      const answers = {};
      for (const question of p.questions || []) {
        const label = document.createElement('label'); label.className = 'approval-question'; label.textContent = question.question;
        const field = document.createElement('input'); field.type = question.isSecret ? 'password' : 'text'; field.placeholder = '填写回答';
        if (question.options?.length) {
          const select = document.createElement('select'); select.innerHTML = '<option value="">选择一个选项，或在下方填写</option>';
          for (const option of question.options) { const o = document.createElement('option'); o.value = option.label; o.textContent = option.label + (option.description ? ' — ' + option.description : ''); select.append(o); }
          select.onchange = () => { field.value = select.value; }; label.append(select);
        }
        label.append(field); card.append(label); answers[question.id] = field;
      }
      const actions = document.createElement('div'); actions.className = 'approval-actions';
      actions.append(approvalButton('提交回答', 'primary', request, () => ({ answers: Object.fromEntries(Object.entries(answers).map(([id, field]) => [id, { answers: [field.value] }])) })));
      card.append(actions);
    } else if (method === 'mcpServer/elicitation/request') {
      card.innerHTML = `<h3>${escape(p.serverName)} 需要确认</h3><p>${escape(p.message)}</p>`;
      const fields = {};
      for (const [name, schema] of Object.entries(p.requestedSchema?.properties || {})) {
        const label = document.createElement('label'); label.textContent = schema.title || name;
        const input = schema.enum ? document.createElement('select') : document.createElement('input');
        if (schema.enum) for (const choice of schema.enum) { const option = document.createElement('option'); option.value = choice; option.textContent = choice; input.append(option); }
        else input.type = schema.type === 'boolean' ? 'checkbox' : schema.type === 'number' || schema.type === 'integer' ? 'number' : 'text';
        label.append(input); fields[name] = { input, schema }; card.append(label);
      }
      if (p.url) { const button = document.createElement('button'); button.className = 'secondary'; button.textContent = '打开授权页面'; button.onclick = action(() => call('external', { url: p.url })); card.append(button); }
      const actions = document.createElement('div'); actions.className = 'approval-actions';
      actions.append(approvalButton('拒绝', 'secondary', request, () => ({ action: 'decline', content: null })),
        approvalButton('确认', 'primary', request, () => ({ action: 'accept', content: Object.fromEntries(Object.entries(fields).map(([k, { input, schema }]) => [k, schema.type === 'boolean' ? input.checked : ['number', 'integer'].includes(schema.type) ? Number(input.value) : input.value])) })));
      card.append(actions);
    } else if (method === 'item/tool/call' || method === 'attestation/generate' || method === 'account/chatgptAuthTokens/refresh') {
      // We do not advertise dynamic tools, attestation, or ChatGPT authentication.
      card.innerHTML = `<h3>当前客户端尚未提供此工具</h3><p>${escape(method)}</p>`;
      const button = document.createElement('button'); button.className = 'secondary'; button.textContent = '停止任务'; button.onclick = action(() => call('interrupt', { threadId: p.threadId || state.current?.id })); card.append(button);
    } else {
      const permissions = method === 'item/permissions/requestApproval';
      const fileChange = method.includes('fileChange') || method === 'applyPatchApproval';
      card.innerHTML = `<h3>${permissions ? '请求更多访问权限' : fileChange ? '确认文件修改' : p.networkApprovalContext ? '确认网络访问' : '确认执行命令'}</h3><p>${escape(p.reason || p.message || '这一步需要你的确认。')}</p>`;
      if (p.command || p.cwd || p.permissions || p.networkApprovalContext) { const pre = document.createElement('pre'); pre.textContent = p.command || JSON.stringify(p.permissions || p.networkApprovalContext, null, 2) || p.cwd; card.append(pre); }
      const result = (allow, session) => permissions ? { permissions: allow ? p.permissions : {}, scope: session ? 'session' : 'turn' }
        : method === 'applyPatchApproval' || method === 'execCommandApproval' ? { decision: allow ? 'approved' : 'denied' }
          : { decision: allow ? session ? 'acceptForSession' : 'accept' : 'decline' };
      const actions = document.createElement('div'); actions.className = 'approval-actions';
      actions.append(approvalButton('拒绝', 'secondary', request, () => result(false)), approvalButton('本次允许', 'primary', request, () => result(true)));
      // Never offer a broader grant than the engine explicitly advertises.
      if (permissions || !p.availableDecisions || p.availableDecisions.includes('acceptForSession')) actions.append(approvalButton('本会话允许', 'secondary', request, () => result(true, true)));
      card.append(actions);
    }
    area.append(card);
  }
}
function approvalButton(text, className, request, result) {
  const button = document.createElement('button'); button.className = className; button.textContent = text;
  button.onclick = action(async () => { button.disabled = true; try { await call('respond', { id: request.id, result: result() }); state.requests.delete(String(request.id)); renderApprovals(); } finally { button.disabled = false; } });
  return button;
}
function diffView(text) {
  const pre = document.createElement('pre'); pre.className = 'diff';
  for (const line of String(text || '').split('\n')) { const div = document.createElement('span'); div.className = 'diff-line' + (line.startsWith('+') ? ' add' : line.startsWith('-') ? ' remove' : line.startsWith('@@') ? ' hunk' : ''); div.textContent = line || ' '; pre.append(div); }
  return pre;
}
async function refreshGit() {
  if (!state.cwd) return;
  const cwd = state.cwd, result = await call('git', { cwd });
  if (cwd !== state.cwd) return;
  state.git = result;
  $('#branch').textContent = result.branch ? `⑂ ${result.branch}` : '';
  const count = result.status.trim().split('\n').filter(Boolean).length;
  $('#change-count').textContent = count; $('#change-count').hidden = !count;
  if (state.detail === 'changes' && !$('#detail-panel').hidden) renderChanges();
}
function showDetail(tab) {
  state.detail = tab; $('#detail-panel').hidden = false; $('#changes-button').classList.add('active');
  $('#tab-changes').classList.toggle('selected', tab === 'changes'); $('#tab-file').classList.toggle('selected', tab === 'file');
  if (tab === 'changes') { renderChanges(); refreshGit().catch((e) => toast(errorText(e))); }
}
function renderChanges() {
  const details = $('#details'); details.innerHTML = '';
  if (!state.git || state.git.notRepository) { details.innerHTML = '<div class="detail-empty">当前项目未使用 Git。<br>任务中的文件修改仍会显示在对话里。</div>'; return; }
  const count = state.git.status.trim().split('\n').filter(Boolean).length;
  const header = document.createElement('div'); header.className = 'detail-header'; header.innerHTML = `<span>${count ? `${count} 个文件有改动` : '工作区是干净的'}</span>`;
  const button = document.createElement('button'); button.className = 'icon-button'; button.title = '刷新改动'; button.innerHTML = icon('refresh'); button.onclick = action(refreshGit); header.append(button); details.append(header);
  if (!count) { details.innerHTML += '<div class="detail-empty">尚无本地改动。</div>'; return; }
  const sections = state.git.diff.split(/(?=^diff --git )/m).filter(Boolean);
  for (const section of sections) {
    const file = section.match(/^\+\+\+ b\/(.+)$/m)?.[1] || section.match(/^diff --git a\/(.+) b\//m)?.[1] || '文件修改';
    const div = document.createElement('div'); div.className = 'detail-file'; const title = document.createElement('div'); title.className = 'detail-file-title'; title.textContent = file;
    title.onclick = action(() => previewFile(state.cwd + '/' + file)); div.append(title, diffView(section)); details.append(div);
  }
  for (const file of state.git.untracked) {
    const div = document.createElement('div'); div.className = 'detail-file'; const button = document.createElement('button'); button.className = 'detail-file-title'; button.style.width = '100%'; button.style.textAlign = 'left'; button.textContent = '+ ' + file + ' · 新文件'; button.onclick = action(() => previewFile(state.cwd + '/' + file)); div.append(button); details.append(div);
  }
  const review = document.createElement('button'); review.className = 'secondary'; review.textContent = '让 Codex 审查改动'; review.onclick = action(startReview); details.append(review);
}
async function previewFile(p) {
  let file = decodeURIComponent(p.replace(/^file:\/\//, ''));
  file = file.replace(/:(\d+)(?::\d+)?$/, '');
  if (!/^(?:\/|[A-Za-z]:[\\/])/.test(file)) file = state.cwd + '/' + file;
  const data = await call('readFile', { path: file });
  showDetail('file'); const details = $('#details'); details.innerHTML = '';
  const info = document.createElement('div'); info.className = 'file-info'; info.textContent = data.path; details.append(info);
  const reveal = document.createElement('button'); reveal.className = 'small-link'; reveal.textContent = '在文件夹中显示'; reveal.onclick = action(() => call('reveal', { path: data.path })); details.append(reveal);
  if (data.image) { const img = document.createElement('img'); img.className = 'file-preview'; img.src = data.image; img.alt = base(data.path); details.append(img); }
  else if (/\.md$/i.test(data.path)) details.append(markdown(data.text, data.path));
  else { const pre = document.createElement('pre'); pre.className = 'file-text'; pre.textContent = data.text; details.append(pre); }
}
async function followLink(link) {
  const href = link.getAttribute('href');
  if (!href) throw new Error('此链接地址不可用');
  const markdownRoot = link.closest('.markdown');
  if (href.startsWith('#')) {
    const id = decodeURIComponent(href.slice(1));
    const heading = [...markdownRoot.querySelectorAll('[id]')].find((el) => el.id === id);
    if (!heading) throw new Error('没有找到链接指向的段落');
    heading.scrollIntoView({ block: 'start', behavior: 'smooth' }); return;
  }
  const target = await call('openLink', { href, cwd: state.cwd, baseFile: markdownRoot.dataset.baseFile || undefined });
  if (target.preview) {
    await previewFile(target.path);
    if (target.fragment) {
      const id = decodeURIComponent(target.fragment);
      const heading = [...$('#details').querySelectorAll('[id]')].find((el) => el.id === id);
      heading?.scrollIntoView({ block: 'start' });
    }
  }
}
async function startReview() {
  if (!state.settings.hasKey) return openSettings();
  if (!state.cwd) return toast('请先选择项目');
  if (!state.current) { const result = await call('create', { cwd: state.cwd }); state.current = result.thread; await call('rename', { threadId: result.thread.id, name: '审查本地改动' }); }
  await call('review', { threadId: state.current.id }); $('#welcome').hidden = true; updateContext(); refreshThreads().catch(() => {});
}
function openPopover(anchor, items, { search = false, notice = '' } = {}) {
  const menu = $('#popover'); menu.replaceChildren(); menu.hidden = false;
  menu.setAttribute('role',search?'dialog':'menu');menu.setAttribute('aria-label',anchor.getAttribute('aria-label')||anchor.title||'选择选项');
  const dismiss=()=>{menu.hidden=true;anchor.focus();};
  menu.onkeydown=event=>{
    const buttons=$$('button',menu),index=buttons.indexOf(document.activeElement);
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismiss();return;}
    if(['ArrowDown','ArrowUp'].includes(event.key)){
      event.preventDefault();if(buttons.length)buttons[index<0?(event.key==='ArrowDown'?0:buttons.length-1):(index+(event.key==='ArrowDown'?1:buttons.length-1))%buttons.length].focus();
    }else if(event.key==='Enter'&&event.target.tagName==='INPUT'){event.preventDefault();buttons[0]?.click();}
  };
  if (notice) { const caption = document.createElement('div'); caption.className = 'popover-notice'; caption.textContent = notice; menu.append(caption); }
  let list = menu;
  if (search) {
    const input = document.createElement('input'); input.type='search';input.setAttribute('aria-label','搜索选项');input.placeholder = '搜索…'; const container = document.createElement('div');container.setAttribute('role','menu');menu.append(input, container); list = container;
    input.oninput = () => fill(input.value.toLowerCase()); requestAnimationFrame(() => input.focus());
  }
  function fill(filter = '') {
    list.replaceChildren();
    for (const item of items.filter((i) => !filter || (i.label + (i.description || '')).toLowerCase().includes(filter))) {
      const button = document.createElement('button'); button.innerHTML = `<span>${escape(item.label)}${item.description ? `<small>${escape(item.description)}</small>` : ''}</span>`;
      button.setAttribute('role',typeof item.checked==='boolean'?'menuitemradio':'menuitem');
      if(typeof item.checked==='boolean'){button.setAttribute('aria-checked',String(item.checked));if(item.checked)button.insertAdjacentHTML('beforeend',icon('check'));}
      button.onclick = action(async (event) => { event.stopPropagation(); dismiss(); await item.run(); }); list.append(button);
    }
    if (!list.children.length) list.innerHTML = '<div class="history-empty">没有可用项目。</div>';
  }
  fill();
  if(!search)requestAnimationFrame(()=>menu.querySelector('button')?.focus());
  const rect = anchor.getBoundingClientRect();
  menu.style.left = Math.min(rect.left, innerWidth - 310) + 'px';
  if (rect.top > innerHeight / 2) { menu.style.top = ''; menu.style.bottom = innerHeight - rect.top + 7 + 'px'; }
  else { menu.style.bottom = ''; menu.style.top = rect.bottom + 7 + 'px'; }
}
async function openSettings(section = 'connection') {
  if ($('#settings-dialog').open) { selectSettingsTab(typeof section === 'string' ? section : 'connection'); return; }
  const form = $('#settings-form');
  for (const name of ['baseUrl', 'model', 'effort', 'binary', 'instructions', 'theme', 'permission', 'fontSize']) form.elements[name].value = state.settings[name] || '';
  form.elements.apiKey.value = ''; form.elements.apiKey.type = 'password'; $('#show-key').textContent = '显示';
  form.elements.apiKey.placeholder = state.settings.hasKey ? '已保存 · 留空保留当前 key' : '在这里粘贴 API key';
  $('#key-hint').textContent = state.settings.keySource === 'relay-env' ? '已从本机 .codex/.env 配置；留空继续使用，不会把 key 传入界面。' : state.settings.encryptedStorage ? 'key 通过本机系统加密保存，不会显示给模型。' : '系统加密不可用，key 将只用于本次会话。';
  $('#data-directory').textContent = state.settings.dataDirectory;
  $('#settings-message').textContent = ''; $('#test-result').textContent = '';
  selectSettingsTab(typeof section === 'string' ? section : 'connection');
  $('#settings-dialog').showModal();
  call('extensions').then((text) => { $('#extensions-config').value = text; }).catch(() => {});
  call('models').then((result) => {
    state.models = result.data || []; $('#model-options').innerHTML = state.models.map((m) => `<option value="${escape(m.model)}">${escape(m.displayName)}</option>`).join('');
  }).catch(() => {});
}
function selectSettingsTab(section) {
  $$('[data-settings]').forEach((el) => { el.hidden = el.dataset.settings !== section; });
  $$('[data-section]').forEach((el) => el.classList.toggle('selected', el.dataset.section === section));
}
async function saveSettings(close = true) {
  const form = $('#settings-form'); if (!form.reportValidity()) return false;
  const data = Object.fromEntries(new FormData(form)); data.rememberKey = form.elements.rememberKey.checked;
  if (data.permission === 'full' && state.settings.permission !== 'full' && !await call('confirmFullAccess')) {
    form.elements.permission.value = state.settings.permission;
    return false;
  }
  applySettings(await call('settings', data)); connection({ connected: state.connected });
  form.elements.apiKey.value = '';
  if (close) { $('#settings-dialog').close(); toast('设置已保存'); }
  return true;
}
async function testConnection() {
  $('#test-connection').disabled = true; $('#test-result').textContent = '正在测试…';
  try {
    if (!await saveSettings(false)) return;
    const result = await call('testConnection');
    $('#test-result').textContent = result.ok ? '已完成一次真实请求，可以使用。' : result.error;
  } catch (error) { $('#test-result').textContent = errorText(error); }
  finally { $('#test-connection').disabled = false; }
}
async function inputDialog(title, value) {
  $('#input-title').textContent = title; $('#input-value').value = value || '';
  const dialog = $('#input-dialog'); dialog.showModal(); $('#input-value').select();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' ? $('#input-value').value.trim() : null), { once: true }));
}
function threadMenu() {
  if (!state.current) return;
  const threadId = state.current.id;
  openPopover($('#thread-menu-button'), [
    { label: '重命名', run: async () => { const name = await inputDialog('重命名对话', state.current.name || ''); if (name) { await call('rename', { threadId, name }); state.current.name = name; updateContext(); await refreshThreads(); } } },
    { label: '移到项目…', run: () => openPopover($('#thread-menu-button'), state.settings.projects.map((cwd)=>({label:projectName(cwd),description:cwd,run:async()=>{applySettings(await call('assignProject',{threadId,cwd}));renderThreads();}}))) },
    { label: '从这里分支对话', run: async () => { const result = await call('fork', { threadId }); await selectThread(result.thread); await refreshThreads(); } },
    { label: '整理上下文', run: async () => { await call('compact', { threadId }); toast('已开始整理上下文'); } },
    { label: '审查本地改动', run: startReview },
    { label: state.archived ? '恢复对话' : '归档对话', run: async () => { await call('archive', { threadId, archived: state.archived }); newChat(); await refreshThreads(); } },
    { label: '导出为 Markdown', run: async () => {
      const text = [...state.turns.values()].flatMap((t) => t.items).filter((i) => ['userMessage', 'agentMessage'].includes(i.type)).map((i) => `## ${i.type === 'userMessage' ? 'You' : 'Codex'}\n\n${i.type === 'userMessage' ? i.content.map((c) => c.text || c.path || '').join('\n') : i.text}`).join('\n\n');
      await call('export', { name: state.current.name || '对话', text });
    } },
  ]);
}
async function chooseSkill() {
  toast('正在读取可用 Skills…');
  const result = await call('skills', { cwd: state.cwd });
  const skills = result.data?.flatMap((entry) => entry.skills || []).filter((s) => s.enabled) || [];
  if (!skills.length) { await openSettings('extensions'); $('#settings-message').textContent = '还没有可用 Skills，可以先导入本机个人 Skills。'; return; }
  openPopover($('#skills-button'), skills.map((skill) => ({ label: '$' + skill.name, description: (skill.shortDescription || skill.description).slice(0, 100), run: () => { state.skill = skill; renderAttachments(); $('#prompt').focus(); } })), { search: true });
}
function sizePrompt() { const el = $('#prompt'); el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 220) + 'px'; updateRunning(); }
function updateTerminalTheme() {
  if (!state.terminal) return;
  const style = getComputedStyle(document.body);
  state.terminal.options.theme = { background: style.getPropertyValue('--surface').trim(), foreground: style.getPropertyValue('--text').trim(), cursor: style.getPropertyValue('--accent').trim(), selectionBackground: '#8b9b8340' };
}
let terminalFit;
async function openTerminal() {
  if (!state.cwd) { await chooseProject(); if (!state.cwd) return; }
  if (!$('#terminal-panel').hidden) return;
  $('#terminal-panel').hidden = false; $('#terminal-button').classList.add('active'); $('#terminal-cwd').textContent = base(state.cwd);
  if (!state.terminal) {
    state.terminal = new Terminal({ fontFamily: 'SFMono-Regular, Consolas, monospace', fontSize: 11, lineHeight: 1.4, cursorBlink: true, scrollback: 5000, allowProposedApi: false });
    terminalFit = new FitAddon.FitAddon(); state.terminal.loadAddon(terminalFit); state.terminal.open($('#terminal')); updateTerminalTheme();
    state.terminal.onData((data) => { if (state.terminalId) call('terminalWrite', { processId: state.terminalId, data }).catch((e) => toast(errorText(e))); });
    new ResizeObserver(() => {
      if ($('#terminal-panel').hidden) return;
      terminalFit.fit(); if (state.terminalId) call('terminalResize', { processId: state.terminalId, rows: state.terminal.rows, cols: state.terminal.cols }).catch(() => {});
    }).observe($('#terminal'));
  }
  terminalFit.fit(); state.terminal.reset();
  const result = await call('terminalStart', { cwd: state.cwd, rows: state.terminal.rows, cols: state.terminal.cols });
  state.terminalId = result.processId;
  for (const p of state.terminalPending) if (p.processId === state.terminalId) state.terminal.write(Uint8Array.from(atob(p.deltaBase64), (c) => c.charCodeAt(0)));
  state.terminalPending = []; state.terminal.focus();
}
async function closeTerminal() {
  if (state.terminalId) await call('terminalStop', { processId: state.terminalId });
  state.terminalId = null; $('#terminal-panel').hidden = true; $('#terminal-button').classList.remove('active');
}
function handleEvent(message) {
  const { method, params: p = {} } = message;
  if (method === 'desk/state') { connection(p); return; }
  if (method === 'desk/request') { state.requests.set(String(p.id), p); renderApprovals(); return; }
  if (method === 'serverRequest/resolved') { state.requests.delete(String(p.requestId)); renderApprovals(); return; }
  if (method === 'command/exec/outputDelta') {
    if (p.processId === state.terminalId) state.terminal?.write(Uint8Array.from(atob(p.deltaBase64), (c) => c.charCodeAt(0)));
    else if (!state.terminalId && state.terminalPending.length < 100) state.terminalPending.push(p);
    return;
  }
  if (method === 'desk/terminalEnd') {
    if (p.processId === state.terminalId) { state.terminal?.writeln('\r\n' + (p.error || `进程已退出 (${p.exitCode ?? 0})`)); state.terminalId = null; } return;
  }
  if (method === 'turn/started') { state.active.set(p.threadId, p.turn.id); if (p.threadId === state.current?.id) state.started = Date.now(); updateRunning(); renderThreads(); }
  if (method === 'turn/completed') {
    state.completedTurns.add(p.turn.id);
    state.active.delete(p.threadId); for (const [id, r] of state.requests) if (r.params.threadId === p.threadId && r.params.turnId === p.turn.id) state.requests.delete(id);
    renderApprovals(); updateRunning(); renderThreads(); refreshThreads().catch(() => {}); if (p.threadId === state.current?.id) refreshGit().catch(() => {});
  }
  if (p.threadId !== state.current?.id) return;
  if (method === 'item/started' || method === 'item/completed') upsertItem(p.turnId, p.item);
  else if (method === 'item/agentMessage/delta' || method === 'item/plan/delta') getItem(p, method.includes('/plan/') ? 'plan' : 'agentMessage').text += p.delta;
  else if (method === 'item/commandExecution/outputDelta') getItem(p, 'commandExecution').aggregatedOutput += p.delta;
  else if (method === 'item/reasoning/summaryTextDelta') { const item = getItem(p, 'reasoning'); const index = p.summaryIndex || 0; item.summary[index] = (item.summary[index] || '') + p.delta; }
  else if (method === 'turn/plan/updated') getTurn(p.turnId).plan = p.plan;
  else if (method === 'turn/completed') { const turn = getTurn(p.turn.id); turn.status = p.turn.status; turn.error = p.turn.error; }
  else if (method === 'error') { if (!p.willRetry) getTurn(p.turnId || state.active.get(p.threadId) || 'error').error = p.error; }
  else if (method === 'thread/tokenUsage/updated') {
    const t = p.tokenUsage; const total = t.total?.totalTokens || 0;
    $('#token-usage').textContent = `${total > 1000 ? (total / 1000).toFixed(1) + 'k' : total} tokens`;
  } else if (method === 'thread/name/updated') { if (state.current) { state.current.name = p.threadName || p.name; updateContext(); } }
  else if (method === 'thread/compacted') toast('对话上下文已整理');
  else if (method === 'turn/started') { getTurn(p.turn.id); }
  else return;
  scheduleRender();
}

window.desk.onEvent(handleEvent);
$('#new-chat').onclick = newChat;
$('#add-project').onclick = action(chooseProject);
$('#welcome-project').onclick = action(chooseProject);
$('#project-button').onclick = () => openPopover($('#project-button'), [...state.settings.projects.map((cwd) => ({ label: base(cwd), description: cwd, run: () => { state.cwd = cwd; newChat(); } })), { label: '+ 添加项目文件夹', run: chooseProject }]);
$('#settings-button').onclick = action(openSettings);
$('#model-chip').onclick = action(async () => {
  const button = $('#model-chip'); button.disabled = true; const label = button.innerHTML; button.textContent = '读取模型列表…';
  let result;
  try { result = await call('models'); }
  catch (e) { await openSettings(); $('#settings-message').textContent = errorText(e); return; }
  finally { button.disabled = false; button.innerHTML = label; }
  state.models = result.data || [];
  if (!state.models.some((model) => model.model === state.settings.model)) state.models.unshift({ model: state.settings.model, displayName: state.settings.model });
  openPopover($('#model-chip'), [...state.models.map((model) => ({ label: model.displayName || model.model,checked:model.model===state.settings.model,
    run: async () => applySettings(await call('settings', { model: model.model })) })),
    { label: state.settings.hasKey ? '连接设置 / 手动填写模型…' : '填写 API key / 自定义模型…', run: openSettings }],
    { search: true, notice: result.source === 'provider' ? '服务商返回的模型列表' : `${result.warning ? result.warning + '。' : ''}引擎模型目录 · API 访问待验证` });
});
$('#welcome-review').onclick = action(() => { showDetail('changes'); });
$('#send').onclick = action(sendMessage);
$('#prompt').oninput = sizePrompt;
$('#prompt').onkeydown = (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); action(sendMessage)(); } };
$('#attach-button').onclick = action(async () => { state.files.push(...await call('files')); renderAttachments(); });
$('#skills-button').onclick = action(chooseSkill);
$('#toggle-sidebar').onclick = () => $('#app').classList.toggle('sidebar-hidden');
$('#theme-button').onclick = action(async () => applySettings(await call('settings', { theme: document.body.classList.contains('dark') ? 'light' : 'dark' })));
$('#changes-button').onclick = () => { if (!$('#detail-panel').hidden && state.detail === 'changes') { $('#detail-panel').hidden = true; $('#changes-button').classList.remove('active'); } else showDetail('changes'); };
$('#detail-close').onclick = () => { $('#detail-panel').hidden = true; $('#changes-button').classList.remove('active'); };
$('#tab-changes').onclick = () => showDetail('changes');
$('#tab-file').onclick = () => {
  showDetail('file'); $('#details').innerHTML = '<div class="detail-empty">选择文件，或点击对话中的文件路径。<br><br><button id="choose-preview-file" class="secondary">打开文件</button></div>';
  $('#choose-preview-file').onclick = action(async () => { const files = await call('files'); if (files[0]) await previewFile(files[0].path); });
};
$('#terminal-button').onclick = action(async () => $('#terminal-panel').hidden ? openTerminal() : closeTerminal());
$('#terminal-close').onclick = action(closeTerminal);
$('#thread-menu-button').onclick = threadMenu;
$('#archive-toggle').onclick = action(async () => { state.archived = !state.archived; await refreshThreads(); });
$('#more-threads').onclick = action(() => refreshThreads(true));
$('#older-turns').onclick = action(() => selectThread(state.current, true));
$('#search').oninput = () => { clearTimeout(searchTimer); renderThreads(); searchTimer = setTimeout(() => refreshThreads().catch((e) => toast(errorText(e))), 300); };
$('#scroll-bottom').onclick = () => { followBottom = true; scrollBottom(); };
$('#conversation').onscroll = () => { const el = $('#conversation'); followBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140; $('#scroll-bottom').hidden = followBottom; };
$('#effort').onchange = action(async () => applySettings(await call('settings', { effort: $('#effort').value })));
$('#font-size-button').onclick = () => openPopover($('#font-size-button'), [14, 16, 18, 20, 22, 24, 28].map((fontSize) => ({
  label: `${fontSize}${fontSize === (state.settings.fontSize || 18) ? ' · 当前' : ''}`,
  run: async () => applySettings(await call('settings', { fontSize })),
})));
$('#permission').onchange = action(async () => {
  const permission = $('#permission').value;
  if (permission === 'full') {
    const allowed = await call('confirmFullAccess');
    if (!allowed) { $('#permission').value = state.settings.permission; return; }
  }
  applySettings(await call('settings', { permission }));
});
$('#settings-form').onsubmit = async (event) => { event.preventDefault(); try { await saveSettings(); } catch (e) { $('#settings-message').textContent = errorText(e); } };
$$('.close-dialog').forEach((el) => { el.onclick = () => $('#settings-dialog').close(); });
$('#settings-dialog').addEventListener('click', (event) => {
  if (event.target !== $('#settings-dialog')) return;
  const r = $('#settings-dialog').getBoundingClientRect();
  if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('#settings-dialog').close();
});
$$('[data-section]').forEach((el) => { el.onclick = () => selectSettingsTab(el.dataset.section); });
$('#show-key').onclick = () => { const field = $('#settings-form').elements.apiKey; field.type = field.type === 'password' ? 'text' : 'password'; $('#show-key').textContent = field.type === 'password' ? '显示' : '隐藏'; };
$('#clear-key').onclick = action(async () => { applySettings(await call('settings', { clearKey: true })); $('#settings-form').elements.apiKey.value = ''; $('#settings-form').elements.apiKey.placeholder = '在这里粘贴 API key'; $('#key-hint').textContent = '已清除保存的 key'; });
$('#browse-binary').onclick = action(async () => { const file = await call('chooseBinary'); if (file) $('#settings-form').elements.binary.value = file; });
$('#test-connection').onclick = testConnection;
$('#open-data').onclick = action(() => call('openData'));
$('#import-skills').onclick = action(async () => { const r = await call('importSkills'); $('#import-result').textContent = `已导入 ${r.count} 个 Skills`; });
$('#save-extensions').onclick = action(async () => { await call('extensions', { content: $('#extensions-config').value }); toast('工具配置已保存'); });
$('#check-mcp').onclick = action(async () => { const result = await call('mcp'); $('#mcp-status').textContent = JSON.stringify(result.data || result, null, 2); });
document.addEventListener('click', (event) => {
  if (!event.target.closest('#popover') && !event.target.closest('#project-button, #thread-menu-button, #skills-button, #font-size-button, .project-menu')) $('#popover').hidden = true;
  const link = event.target.closest('.markdown a'); if (!link) return;
  event.preventDefault(); action(() => followLink(link))();
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); if (!$('#settings-dialog').open) newChat(); }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#search').focus(); }
  if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); if (!$('#settings-dialog').open) action(openSettings)(); }
  if (event.key === 'Escape') $('#popover').hidden = true;
});
const composer = $('#composer');
$('#prompt').addEventListener('paste', (event) => {
  let images = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith('image/'));
  if (!images.length) images = [...(event.clipboardData?.items || [])].filter((item) => item.kind === 'file' && item.type.startsWith('image/')).map((item) => item.getAsFile()).filter(Boolean);
  if (!images.length) return;
  event.preventDefault();
  action(async () => {
    for (const image of images) {
      if (state.files.length >= 20) { toast('每次最多添加20个附件'); break; }
      if (image.size > 20 * 1024 * 1024) throw new Error('粘贴的图片需小于20 MB');
      const bytes = new Uint8Array(await image.arrayBuffer());
      state.files.push(await call('pasteImage', { bytes })); renderAttachments();
    }
  })();
});
composer.ondragover = (event) => { event.preventDefault(); composer.classList.add('dragover'); };
composer.ondragleave = () => composer.classList.remove('dragover');
composer.ondrop = action(async (event) => { event.preventDefault(); composer.classList.remove('dragover'); const paths = [...event.dataTransfer.files].map((f) => window.desk.filePath(f)).filter(Boolean); state.files.push(...await call('files', { paths })); renderAttachments(); });
setInterval(() => { if (state.current && state.active.has(state.current.id) && state.started) $('#elapsed').textContent = `${Math.floor((Date.now() - state.started) / 1000)}s`; }, 1000);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.settings && theme());

async function bootstrap() {
  if (window.desk.platform !== 'darwin') { document.body.classList.add('win'); $$('kbd').forEach((el) => { el.textContent = el.textContent.replace('⌘', 'Ctrl'); }); }
  const initial = await call('bootstrap'); applySettings(initial.settings); connection(initial.state);
  for (const [id, turn] of Object.entries(initial.activeTurns)) state.active.set(id, turn);
  for (const r of initial.requests) state.requests.set(String(r.id), r);
  try { connection(await call('connect')); await refreshThreads(); }
  catch (error) { banner(errorText(error)); }
  if (state.cwd) refreshGit().catch(() => {});
  state.initialized = true;
  $('#prompt').focus();
}
bootstrap().catch((error) => { banner(errorText(error)); });
