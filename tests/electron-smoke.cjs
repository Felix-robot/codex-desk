const { app, BrowserWindow, dialog, shell, nativeImage, clipboard, Notification } = require('electron');
let systemNotifications=0;Notification.prototype.show=function(){systemNotifications++;};
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { mockProvider } = require('./mock-provider.cjs');
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-electron-')));
const project = path.join(directory, 'project'); fs.mkdirSync(project);
process.env.CODEX_DESK_DATA_DIR = path.join(directory, 'data');
process.env.CODEX_DESK_UI_TEST = '1';
if (process.env.DESK_TEST_BINARY) {
  fs.mkdirSync(process.env.CODEX_DESK_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.CODEX_DESK_DATA_DIR, 'settings.json'), JSON.stringify({ binary: process.env.DESK_TEST_BINARY }));
}
const official = ['config.toml', 'auth.json'].map((file) => path.join(os.homedir(), '.codex', file)).filter((file) => fs.existsSync(file));
const officialBefore = official.map((file) => ({ file, content: fs.readFileSync(file), mtime: fs.statSync(file).mtimeMs }));
const artifacts = process.env.DESK_TEST_ARTIFACTS || path.join(__dirname, '..', 'artifacts'); fs.mkdirSync(artifacts, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const openedLinks = [];
const copiedTexts = [];
// Exercise the native IPC route without touching the user's clipboard.
clipboard.writeText = text => copiedTexts.push(text);
shell.openPath = async (file) => { openedLinks.push({ file }); return ''; };
shell.openExternal = async (url) => { openedLinks.push({ url }); };
let pickedProject = project;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pickedProject] });
dialog.showMessageBox = async () => ({ response: 1 });
dialog.showMessageBoxSync = () => 1;
require('../src/main.cjs');

(async () => {
  await app.whenReady();
  let provider, win;
  try {
    provider = await mockProvider();
    win = BrowserWindow.getAllWindows()[0];
    const consoleErrors = [];
    win.webContents.on('console-message', (...args) => { const info = args[1]; if (info && typeof info === 'object' && info.level === 'error') consoleErrors.push(info.message); });
    if (win.webContents.isLoadingMainFrame()) await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    const js = async (code) => {
      try { return await win.webContents.executeJavaScript(code, true); }
      catch (error) { throw new Error(`Renderer failed in ${code.slice(0,100)}: ${error.message}. ${consoleErrors.join(' | ')}`); }
    };
    const until = async (code, message, timeout = 15000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) { if (await js(code)) return; await wait(100); }
      throw new Error(message + ' · ' + await js("document.querySelector('#banner').textContent + ' | ' + document.querySelector('#toast').textContent"));
    };
    await until("!!state.settings", 'bootstrap failed');
    assert.equal(await js('state.settings.model'), 'gpt-6.1-sol', 'new install default model is outdated');
    assert.equal(await js('state.settings.effort'), 'high', 'new install default effort is outdated');
    await js("document.querySelector('#model-chip').click()");
    await until("!document.querySelector('#popover').hidden && /6\\.1/i.test(document.querySelector('#popover').textContent)", 'model catalog unavailable before entering key');
    assert.equal(await js("document.querySelector('#settings-dialog').open"), false, 'model menu unexpectedly requires a key');
    assert.ok(await js("document.querySelector('.popover-notice').textContent.includes('API 访问待验证')"));
    await js("document.querySelector('#popover').hidden=true");
    await js("document.querySelector('#add-project').click()");
    await until("state.cwd !== ''", 'folder selection failed');
    await js(`window.desk.call('settings', {baseUrl:${JSON.stringify(provider.url)},model:'desk-test-model',apiKey:'desktop-fixture-key',rememberKey:false,relayCompatibility:true}).then(applySettings)`);
    await until('state.settings.hasKey', 'key setup failed');
    await js("document.querySelector('#model-chip').click()");
    await until("!document.querySelector('#popover').hidden && document.querySelector('#popover').textContent.includes('desk-test-model')", 'provider model menu missing');
    await js("document.querySelector('#popover').hidden=true");
    assert.equal((await js("window.desk.call('testConnection')")).ok, true, 'connection test failed');
    await js("connection({connected:true});document.querySelector('#prompt').value='offline-tool-probe offline-approval-probe: verify the local file and terminal workflow';document.querySelector('#prompt').dispatchEvent(new Event('input'));document.querySelector('#send').click()");
    await until("document.querySelector('.approval-card') !== null", 'approval UI missing');
    await js("Array.from(document.querySelectorAll('.approval-actions button')).find(b=>b.textContent==='本次允许').click()");
    await until("document.querySelector('#messages').textContent.includes('本地工具已完成') && state.active.size === 0", 'real tool task did not finish');
    assert.equal(fs.readFileSync(path.join(project, 'desk-probe.txt'), 'utf8'), 'desk-real-tool-ok');
    assert.ok(await js("document.querySelector('#messages').textContent.includes('本地工具已完成')"));
    assert.equal(await js("document.querySelectorAll('.message.user').length"), 1, 'duplicate user message');
    const realThreadId = await js('state.current.id');
    await until(`Array.from(document.querySelectorAll('.project-group')).some(g=>g.dataset.project===${JSON.stringify(project)}&&Array.from(g.querySelectorAll('.thread-row')).some(t=>t.dataset.threadId===${JSON.stringify(realThreadId)}))`, 'conversation not grouped under project');
    const secondProject = path.join(directory,'second-project');fs.mkdirSync(secondProject);pickedProject=secondProject;
    await js("window.desk.call('chooseProject').then(r=>applySettings(r.settings))");
    await js(`Array.from(document.querySelectorAll('.project-group')).find(g=>g.dataset.project===${JSON.stringify(secondProject)}).querySelector('.project-menu').click();Array.from(document.querySelectorAll('#popover button')).find(b=>b.textContent.includes('重命名项目')).click()`);
    await until("document.querySelector('#input-dialog').open", 'project rename dialog missing');
    await js("document.querySelector('#input-value').value='学习笔记';document.querySelector('#input-dialog button[value=ok]').click()");
    await until(`state.settings.projectNames[${JSON.stringify(secondProject)}]==='学习笔记'`, 'project display name was not saved');
    assert.ok(fs.existsSync(secondProject), 'project rename changed folder');
    await js("document.querySelector('#thread-menu-button').click();Array.from(document.querySelectorAll('#popover button')).find(b=>b.textContent==='移到项目…').click()");
    await until("!document.querySelector('#popover').hidden && document.querySelector('#popover').textContent.includes('学习笔记')", 'move-to-project submenu failed');
    await js("Array.from(document.querySelectorAll('#popover button')).find(b=>b.querySelector('span').firstChild.textContent==='学习笔记').click()");
    await until(`state.settings.threadProjects[${JSON.stringify(realThreadId)}]===${JSON.stringify(secondProject)}`, 'conversation assignment not saved');
    assert.equal(await js('state.cwd'), project, 'organizing a chat changed its working directory');
    assert.equal(await js("document.querySelector('.project.selected').closest('.project-group').dataset.project"),secondProject);
    assert.equal(await js(`Array.from(document.querySelectorAll('.project-group')).find(g=>g.dataset.project===${JSON.stringify(secondProject)}).querySelector('.thread-row').dataset.threadId`),realThreadId);
    await js("document.querySelector('#thread-menu-button').click()");
    assert.ok(await js("document.querySelector('#popover').textContent.includes('从这里分支')"));
    await js("document.querySelector('#popover').hidden=true;document.querySelector('#terminal-button').click()");
    await until('!!state.terminalId', 'PTY terminal failed');
    const terminalCommand=process.platform === 'win32' ? 'Write-Output terminal-ui-ok\r' : "printf 'terminal-ui-ok\\n'\r";
    await js(`window.desk.call('terminalWrite',{processId:state.terminalId,data:${JSON.stringify(terminalCommand)}})`);
    await until("Array.from({length:state.terminal.buffer.active.length},(_,i)=>state.terminal.buffer.active.getLine(i)?.translateToString()).join('').includes('terminal-ui-ok')", 'PTY output missing');
    await js("closeTerminal()");
    await js(`previewFile(${JSON.stringify(path.join(project, 'desk-probe.txt'))})`);
    await until("document.querySelector('#details').textContent.includes('desk-real-tool-ok')", 'file preview failed');
    fs.writeFileSync(path.join(artifacts, 'conversation-light.png'), (await win.webContents.capturePage()).toPNG());
    await js("document.querySelector('#detail-close').click();document.querySelector('#theme-button').click()");
    await until("document.body.classList.contains('dark') && state.settings.theme === 'dark'", 'dark mode toggle failed');
    assert.ok(await js("parseFloat(getComputedStyle(document.querySelector('.message.agent')).fontSize) >= 16"));
    await wait(100); fs.writeFileSync(path.join(artifacts, 'conversation-dark.png'), (await win.webContents.capturePage()).toPNG());
    await js("document.querySelector('#theme-button').click()");
    await until("!document.body.classList.contains('dark')", 'light mode toggle failed');
    const png = nativeImage.createFromBitmap(Buffer.from([100,150,200,255]), {width:1,height:1}).toPNG();
    const pasteImage = () => js(`(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(png.toString('base64'))}),c=>c.charCodeAt(0));const data=new DataTransfer();data.items.add(new File([bytes],'clipboard.png',{type:'image/png'}));const e=new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});document.querySelector('#prompt').dispatchEvent(e);return e.defaultPrevented})()`);
    assert.equal(await pasteImage(), true);
    await until("state.files.length===1 && !!document.querySelector('.attachment-thumbnail')", 'clipboard image did not attach');
    const imagePath = await js('state.files[0].path'); assert.ok(fs.existsSync(imagePath));
    await js("document.querySelector('.attachment-thumbnail').click()");
    await until("!!document.querySelector('#details .file-preview')", 'pasted image preview failed');
    await js("document.querySelector('#detail-close').click();document.querySelector('.attachment button').click()");
    assert.equal(await js('state.files.length'), 0, 'pasted attachment removal failed');
    assert.equal(await js("(()=>{const d=new DataTransfer();d.setData('text/plain','normal text');const e=new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true});document.querySelector('#prompt').dispatchEvent(e);return e.defaultPrevented})()"), false, 'text paste was intercepted');
    await pasteImage(); await until('state.files.length===1', 'second paste failed');
    const beforeImageRequest = provider.seen.length;
    await js("document.querySelector('#prompt').value='offline-pasted-image';document.querySelector('#send').click()");
    await until('state.files.length===0 && state.active.size===0 && !state.loading', 'pasted image turn did not finish');
    assert.ok(provider.seen.slice(beforeImageRequest).some((body)=>JSON.stringify(body.input).includes('data:image/')), 'image bytes did not reach Responses request');
    await js("newChat()");
    fs.writeFileSync(path.join(artifacts, 'welcome.png'), (await win.webContents.capturePage()).toPNG());
    await js("openSettings()");
    await until("document.querySelector('#settings-dialog').open", 'settings failed');
    fs.writeFileSync(path.join(artifacts, 'settings.png'), (await win.webContents.capturePage()).toPNG());
    await js("document.querySelector('#settings-dialog').close()");
    win.setSize(1000, 720); await wait(100);
    assert.ok(await js("document.documentElement.scrollWidth <= innerWidth"));
    fs.writeFileSync(path.join(artifacts, 'compact.png'), (await win.webContents.capturePage()).toPNG());
    await js("document.querySelector('#font-size-button').click();Array.from(document.querySelectorAll('#popover button')).find(b=>b.textContent==='22').click()");
    await until("state.settings.fontSize === 22 && getComputedStyle(document.querySelector('#prompt')).fontSize === '22px'", 'font size selection did not apply');
    const reloaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    win.webContents.reload(); await reloaded;
    await until("!!state.settings && state.settings.fontSize === 22", 'font size did not survive reload');
    assert.equal(await js(`state.settings.projectNames[${JSON.stringify(secondProject)}]`),'学习笔记');
    assert.equal(await js(`state.settings.threadProjects[${JSON.stringify(realThreadId)}]`),secondProject);
    const fixture = {id:'display-fixture',status:'completed',items:[
      {id:'display-user',type:'userMessage',content:[{type:'text',text:'请检查项目文件。'}]},
      {id:'display-progress',type:'agentMessage',phase:'commentary',text:'先检查项目约定与文件内容。'},
      {id:'display-reasoning',type:'reasoning',summary:['接口返回的简短思考摘要。'],status:'completed'},
      {id:'display-tool',type:'commandExecution',command:'read project files',aggregatedOutput:'file-read-ok',status:'completed',exitCode:0},
      {id:'display-final',type:'agentMessage',phase:'final_answer',text:'检查完成。\n\n[项目说明](README.md)'}]};
    await js(`state.cwd=${JSON.stringify(project)};state.current={id:'display-thread',cwd:${JSON.stringify(project)}};state.turns=new Map([['display-fixture',${JSON.stringify(fixture)}]]);renderMessages()`);
    assert.equal(await js("getComputedStyle(document.querySelector('#messages > .message.agent')).fontSize"), '22px');
    assert.equal(await js("document.querySelectorAll('.process-group').length"), 1);
    assert.equal(await js("document.querySelector('.process-group').open"), false);
    assert.equal(await js("document.querySelectorAll('#messages > .message.agent').length"), 1, 'progress leaked into final answer area');
    assert.equal(await js("document.querySelector('#messages > .message.agent').textContent.includes('检查完成')"), true);
    await js("document.querySelector('.process-group > summary').click()");
    assert.equal(await js("document.querySelector('.process-group').open"), true);
    assert.equal(await js("document.querySelector('.reasoning').open"), false);
    await js("document.querySelector('.reasoning > summary').click();renderMessages()");
    assert.equal(await js("document.querySelector('.process-group').open && document.querySelector('.reasoning').open"), true, 'expanded process state was lost on rerender');
    await js("document.querySelector('.process-group > summary').click();renderMessages()");
    assert.equal(await js("document.querySelector('.process-group').open"), false);
    assert.ok(await js("document.querySelector('.message.agent .markdown a') !== null"));
    assert.ok(await js("document.documentElement.scrollWidth <= innerWidth"));
    await js("followBottom=false;document.querySelector('#conversation').scrollTop=0");
    await wait(150);
    fs.writeFileSync(path.join(artifacts, 'font-and-process.png'), (await win.webContents.capturePage()).toPNG());
    const note = path.join(project, '中文 说明.md'); fs.writeFileSync(note, '# 测试说明\n本地链接已打开。');
    const nested = path.join(project, 'notes'); fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'index.md'), '[下一级](detail.md)'); fs.writeFileSync(path.join(nested, 'detail.md'), 'nested-relative-link-ok');
    const html = path.join(project, '讲解 页面.html'); fs.writeFileSync(html, '<!doctype html><title>Local fixture</title>');
    const pdf = path.join(project, '说明.pdf'); fs.writeFileSync(pdf, '%PDF-1.4\n%%EOF');
    fs.writeFileSync(path.join(project, '.env'), 'fixture-only');
    const links = `[盘符路径](<${note.replaceAll('\\','/')}>)\n\n[文件URL](<${pathToFileURL(note).href}>)\n\n[相对文档](notes/index.md)\n\n[HTML讲解](<${pathToFileURL(html).href}>)\n\n[PDF](<${pathToFileURL(pdf).href}>)\n\n[网站](https://example.com/)\n\n[凭据](.env)`;
    await js(`state.turns=new Map([['links',{id:'links',items:[{id:'links-final',type:'agentMessage',phase:'final_answer',text:${JSON.stringify(links)}}]}]]);renderMessages()`);
    const clickLink = (label, root = '#messages') => js(`Array.from(document.querySelectorAll(${JSON.stringify(root + ' .markdown a')})).find(a=>a.textContent===${JSON.stringify(label)}).click()`);
    await clickLink('盘符路径');
    await until("document.querySelector('#details').textContent.includes('本地链接已打开')", 'drive-letter path link failed');
    await clickLink('文件URL');
    await until("document.querySelector('#details').textContent.includes('本地链接已打开')", 'file URL failed');
    await clickLink('相对文档');
    await until("document.querySelector('#details .markdown a')?.textContent==='下一级'", 'relative document link failed');
    await clickLink('下一级', '#details');
    await until("document.querySelector('#details').textContent.includes('nested-relative-link-ok')", 'preview-relative link resolved against wrong folder');
    await clickLink('HTML讲解'); await clickLink('PDF'); await clickLink('网站');
    for(let i=0;i<30 && openedLinks.length<3;i++)await wait(50);
    assert.ok(openedLinks.some((item)=>item.file===fs.realpathSync(html)), 'HTML was not routed to default app');
    assert.ok(openedLinks.some((item)=>item.file===fs.realpathSync(pdf)), 'PDF was not routed to default app');
    assert.ok(openedLinks.some((item)=>item.url==='https://example.com/'), 'website was not routed to browser');
    await clickLink('凭据');
    await until("document.querySelector('#toast').textContent.includes('凭据文件')", 'credential preview was not blocked');
    assert.ok(!openedLinks.some((item)=>item.file?.endsWith('.env')));
    const mathText = [
      String.raw`行内公式：\(e^{i\pi}+1=0\)，以及 $a^2+b^2=c^2$。`, '',
      String.raw`$$\int_0^1 x^2\,dx=\frac{1}{3}$$`, '',
      String.raw`\[f(x)=\begin{cases}x^2,&x\ge0\\-x,&x<0\end{cases}\]`, '',
      '`$notMath$`', '', '```latex', '$literal$', '```', '',
      String.raw`价格为 \$20 和 \$30。`, '',
      String.raw`无效公式：$\notARealMathCommand{x}$`,
    ].join('\n');
    await js(`document.querySelector('#detail-close').click();state.turns=new Map([['math',{id:'math',items:[{id:'math-final',type:'agentMessage',phase:'final_answer',text:${JSON.stringify(mathText)}}]}]]);renderMessages();document.querySelector('#conversation').scrollTop=0`);
    assert.equal(await js("document.querySelectorAll('#messages .katex').length"), 4, 'math delimiters were not rendered');
    assert.equal(await js("document.querySelectorAll('#messages .katex-display').length"), 2);
    assert.equal(await js("document.querySelectorAll('#messages code .katex').length"), 0, 'code was incorrectly typeset');
    assert.ok(await js("document.querySelector('#messages').textContent.includes('$20')"), 'escaped currency was consumed');
    assert.equal(await js("document.querySelectorAll('#messages .math-fallback').length"), 1, 'invalid TeX did not preserve original text');
    assert.ok(await js("document.fonts.load('20px KaTeX_Main').then(fonts=>fonts.length>0)"), 'local math font did not load');
    assert.ok(await js("document.documentElement.scrollWidth <= innerWidth"));
    await js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{followBottom=false;document.querySelector('#conversation').scrollTop=0;document.querySelector('#toast').hidden=true;resolve()})))");
    await wait(150); fs.writeFileSync(path.join(artifacts, 'math-light.png'), (await win.webContents.capturePage()).toPNG());
    await js("document.querySelector('#theme-button').click()"); await wait(150);
    fs.writeFileSync(path.join(artifacts, 'math-dark.png'), (await win.webContents.capturePage()).toPNG());
    assert.equal(await js(`markdown(${JSON.stringify(String.raw`流式未完成：\(\frac{1}{2}`)}).querySelectorAll('.katex').length`), 0);
    assert.equal(await js(`markdown(${JSON.stringify(String.raw`流式完成：\(\frac{1}{2}\)`)}).querySelectorAll('.katex').length`), 1);
    assert.equal(await js(`markdown(${JSON.stringify(String.raw`$\href{javascript:alert(1)}{x}$`)}).querySelectorAll('a').length`), 0);
    const copyFixture = '中文复制测试\n\n```text\ncopy-code-ok\n```';
    const overloadError = 'stream disconnected before completion: Our servers are currently overloaded. Please try again later.';
    await js(`Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:()=>Promise.reject(new Error('Browser clipboard blocked'))});state.turns=new Map([['copy-test',{id:'copy-test',items:[{id:'copy-final',type:'agentMessage',phase:'final_answer',text:${JSON.stringify(copyFixture)}}],error:{message:${JSON.stringify(overloadError)}}}]]);renderMessages()`);
    const copiesBefore = copiedTexts.length;
    await js("document.querySelector('.message-heading button[title=\"复制消息\"]').click()");
    await until("document.querySelector('#toast').textContent==='已复制'", 'message copy failed while browser clipboard blocked');
    assert.equal(copiedTexts[copiesBefore], copyFixture);
    await js("document.querySelector('.copy-code').click()");
    await until("document.querySelector('.copy-code').textContent==='已复制'", 'code copy failed');
    assert.equal(copiedTexts[copiesBefore + 1].trim(), 'copy-code-ok');
    assert.ok(await js("document.querySelector('.error-message > div').textContent.includes('服务端当前过载')"));
    assert.equal(await js("document.querySelector('.error-message pre').textContent"), overloadError);
    await js("document.querySelector('.error-message summary').click();document.querySelector('.error-message button').click()");
    await until("document.querySelector('.error-message button').textContent==='已复制'", 'raw error copy failed');
    assert.equal(copiedTexts[copiesBefore + 2], overloadError);
    assert.equal(copiedTexts.length, copiesBefore + 3);
    for (const snapshot of officialBefore) {
      assert.ok(fs.readFileSync(snapshot.file).equals(snapshot.content), 'official file content changed');
      assert.equal(fs.statSync(snapshot.file).mtimeMs, snapshot.mtime, 'official file timestamp changed');
    }
    if (consoleErrors.length) throw new Error(consoleErrors.join('\n'));
    assert.equal(win.isVisible(),false,'UI test window became visible');
    assert.equal(systemNotifications,0,'hidden tests emitted a real system notification');
    fs.writeFileSync(path.join(artifacts, 'ui-verification.json'), JSON.stringify({ status: 'passed',
      offlineProvider: true, realCodexHarness: true, completed: ['startup','6.1/high default','model menu available without API key with source notice','key configuration','project picker','streamed reply','native tool approval','actual shell file write','history list','context menu','interactive PTY','file preview','light/dark','pasted image attachment/thumbnail/preview/removal','plain text paste not intercepted','image bytes sent to Responses','compact layout','font selection and persistence','process collapsed by default','expansion retained while rendering','final reply and links visible','drive and file URL clicks','nested relative links','HTML/PDF/browser OS routing (stubbed)','credential file denied','inline/display math and local fonts','code/currency preserved','incomplete and invalid TeX fallback','math commands cannot create active links','official files unchanged'],
      projectGroupingAndRename:true, hiddenTestWindow:!win.isVisible(),
      nativeClipboardWithBrowserPermissionDenied:true, overloadMessageAndRawErrorCopy:true,
      directory, screenshots: ['welcome.png','conversation-light.png','conversation-dark.png','settings.png','compact.png'] }, null, 2));
    console.log('UI verification passed: real harness + local provider, official files unchanged.');
    app.exit(0);
  } catch (error) {
    console.error(error.stack);
    if (win) { try { fs.writeFileSync(path.join(artifacts, 'ui-failure.png'), (await win.webContents.capturePage()).toPNG()); } catch {} }
    app.exit(1);
  } finally { provider?.server.closeAllConnections(); provider?.server.close(); }
})();
