// Offscreen, synthetic UI content. No network, real chats, notifications, microphone or desktop capture.
const {app,BrowserWindow,ipcMain,Notification}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
app.disableHardwareAcceleration();
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'desk-visual-'));app.setPath('userData',temporary);
let notifications=0;Notification.prototype.show=()=>notifications++;
const project=path.join(temporary,'study'),other=path.join(temporary,'app');
let settings={theme:'dark',fontSize:18,model:'gpt-6.1-sol',effort:'high',permission:'workspace',baseUrl:'http://example.invalid/v1',projects:[project,other],projectNames:{[project]:'学习资料',[other]:'Codex Desk'},threadProjects:{},hasKey:true,keySource:'relay-env',encryptedStorage:null,dataDirectory:temporary};
const titles=['整理本周的课程笔记','解释这个积分的推导','为交互页面补充图表','检查公式与引用','调整文件预览布局','复查最近的代码改动'];
const threads=titles.map((name,i)=>({id:'visual-'+i,name,preview:name,cwd:i<4?project:other,updatedAt:Date.now()/1000-i*1900}));
const calls=[];
ipcMain.handle('desk:call',(_event,name,p={})=>{
  calls.push(name);
  if(name==='bootstrap')return{settings,state:{connected:true},activeTurns:{},requests:[]};
  if(name==='connect')return{connected:true};
  if(name==='list')return{data:threads,nextCursor:null};
  if(name==='git')return{branch:'main',status:'',diff:'',notRepository:false};
  if(name==='settings'){settings={...settings,...p};return settings;}
  if(name==='workspaceState')return{pinned:[],order:[],jobs:[],usage:{},syncThreads:[]};
  if(name==='modes')return{data:[]};
  if(name==='models')return{source:'provider',data:[{model:'gpt-6.1-sol',displayName:'gpt-6.1-sol'},{model:'gpt-6-astra',displayName:'gpt-6-astra'}]};
  if(name==='goal')return{goal:null};
  if(name==='agents')return[];
  if(name==='fileTree')return{folder:project,entries:[{name:'README.md',path:path.join(project,'README.md'),directory:false}]};
  if(name==='skills')return{data:[]};
  if(name==='connectorStatus')return{mcp:{data:[]}};
  if(name==='nativeStatus')return{modules:{},model:false,desktop:null,platform:'win32',permissions:{},hotkey:false};
  if(name==='extensions')return'';
  if(name==='history')return{thread:threads[0],data:[],nextCursor:null,requests:[]};
  throw new Error('Unexpected visual fixture action: '+name);
});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function contrast(fg,bg){const rgb=s=>s.match(/[\d.]+/g).slice(0,3).map(v=>{const x=+v/255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;});const l=s=>{const v=rgb(s);return .2126*v[0]+.7152*v[1]+.0722*v[2];};return (Math.max(l(fg),l(bg))+.05)/(Math.min(l(fg),l(bg))+.05);}
(async()=>{
  let win;const output=process.env.DESK_TEST_ARTIFACTS||path.join(temporary,'artifacts');fs.mkdirSync(output,{recursive:true});
  try{
    await app.whenReady();win=new BrowserWindow({width:1440,height:960,show:false,webPreferences:{preload:path.join(__dirname,'../src/preload.cjs'),offscreen:true,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
    let frame;win.webContents.on('paint',(_event,_rect,image)=>{frame=image;});win.webContents.setFrameRate(30);
    const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
    await win.loadFile(path.join(__dirname,'../src/index.html'));await win.webContents.insertCSS('*{animation:none!important;transition:none!important}');
    const js=code=>win.webContents.executeJavaScript(code,true);
    const until=async(code,label)=>{const end=Date.now()+10000;while(Date.now()<end){if(await js(code))return;await wait(50);}throw new Error(label);};
    const shot=async name=>{await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await wait(200);assert.ok(frame&&!frame.isEmpty());fs.writeFileSync(path.join(output,name),frame.toPNG());};
    await until('state.initialized&&state.threads.length===6','bootstrap');
    assert.equal(await js("document.querySelectorAll('#composer #model-chip,#composer #effort,#composer #work-mode,#composer #voice-button,#composer #desktop-button').length"),5);
    assert.equal(await js("document.querySelectorAll('.sidebar-shortcuts button').length"),3);
    assert.ok(await js("!getComputedStyle(document.querySelector('.welcome h1')).fontFamily.includes('Georgia')"));
    await shot('welcome-dark.png');
    const userText='帮我整理这周的课程笔记，把复积分的关键公式和讲解入口放在一起。';
    const answer='已整理好，讲解入口和关键公式放在同一页。\n\n### 本周笔记\n\n- [复积分知识点](/example/project/复积分.md)\n- [练习讲解网页](/example/project/练习讲解.html)\n\n沿闭曲线 $C$ 的积分满足：\n\n$$\\oint_C f(z)\\,dz=2\\pi i\\sum_k\\operatorname{Res}(f,z_k)$$\n\n计算时先确认奇点的位置，再逐个求留数。';
    const turn={id:'visual-turn',status:'completed',items:[{id:'u',type:'userMessage',content:[{type:'text',text:userText}]},{id:'p',type:'agentMessage',phase:'commentary',text:'正在核对课程目录与公式。'},{id:'tool',type:'commandExecution',command:'rg --files 课程笔记',status:'completed',exitCode:0,aggregatedOutput:'notes.md'},{id:'a',type:'agentMessage',phase:'final_answer',text:answer}]};
    await js(`state.current=state.threads[0];state.turns=new Map([[${JSON.stringify(turn.id)},${JSON.stringify(turn)}]]);updateContext();renderMessages();renderThreads();`);
    await until("document.querySelectorAll('.katex').length>0",'math rendering');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('DOM.enable');await win.webContents.debugger.sendCommand('CSS.enable');
    const documentNode=await win.webContents.debugger.sendCommand('DOM.getDocument');
    const textNode=await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:documentNode.root.nodeId,selector:'#messages>.message.agent .markdown p'});
    const fonts=await win.webContents.debugger.sendCommand('CSS.getPlatformFontsForNode',{nodeId:textNode.nodeId});
    win.webContents.debugger.detach();fs.writeFileSync(path.join(output,'font-audit.json'),JSON.stringify(fonts,null,2));
    assert.equal(await js("document.querySelector('.process-group').open"),false);
    await shot('conversation-dark.png');
    await js("document.querySelector('#theme-button').click()");await until("!document.body.classList.contains('dark')",'light mode');await shot('conversation-light.png');
    const ratios={};for(const mode of ['light','dark']){
      await js(`applySettings({...state.settings,theme:${JSON.stringify(mode)}})`);
      const colors=await js("({text:getComputedStyle(document.body).color,main:getComputedStyle(document.body).backgroundColor,muted:getComputedStyle(document.querySelector('.breadcrumb')).color,sidebar:getComputedStyle(document.querySelector('.sidebar')).backgroundColor,sideText:getComputedStyle(document.querySelector('.section-label')).color})");
      ratios[mode]={body:contrast(colors.text,colors.main),secondary:contrast(colors.muted,colors.main),sidebar:contrast(colors.sideText,colors.sidebar)};
      assert.ok(Object.values(ratios[mode]).every(n=>n>=4.5),JSON.stringify(ratios[mode]));
    }
    await js("document.querySelector('[data-workspace-open=files]').click()");await until("document.querySelector('#workspace-dialog').open&&document.querySelector('#workspace-content').textContent.includes('README.md')",'file shortcut');
    await shot('workspace-dark.png');await js("document.querySelector('#workspace-close').click()");
    await js("document.querySelector('#model-chip').click()");await until("!document.querySelector('#popover').hidden",'model popup');assert.match(await js("document.querySelector('#popover').textContent"),/gpt-6-astra/);
    assert.match(await js("document.querySelector('#popover [aria-checked=true]').textContent"),/gpt-6.1-sol/);
    await js("document.querySelector('#popover input').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))");assert.ok(await js("document.activeElement.matches('#popover button')"));
    await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");assert.ok(await js("document.activeElement.id==='model-chip'&&document.querySelector('#popover').hidden"));
    const sizes=[];
    for(const [width,height,fontSize] of [[1440,960,18],[1000,780,22],[940,650,28]]){
      win.setSize(width,height);await js(`applySettings({...state.settings,fontSize:${fontSize}})`);await wait(150);
      const measurements=await js("({width:innerWidth,bodyWidth:document.body.scrollWidth,composer:document.querySelector('#composer').getBoundingClientRect().toJSON(),buttons:[...document.querySelectorAll('#composer button,#composer select')].map(el=>({id:el.id,...el.getBoundingClientRect().toJSON()})),settings:document.querySelector('#settings-button').getBoundingClientRect().toJSON(),height:innerHeight,promptFont:getComputedStyle(document.querySelector('#prompt')).fontSize})");
      assert.ok(measurements.bodyWidth<=measurements.width);assert.ok(measurements.settings.bottom<=measurements.height);
      assert.equal(measurements.promptFont,fontSize+'px');for(const b of measurements.buttons.filter(b=>b.width>0))assert.ok(b.left>=measurements.composer.left-1&&b.right<=measurements.composer.right+1,'Composer control clipped: '+b.id);
      sizes.push({width,height,fontSize});if(width===1000)await shot('compact-dark.png');
    }
    await js("document.querySelector('#toggle-sidebar').click()");assert.equal(await js("getComputedStyle(document.querySelector('.sidebar')).display"),'none');await js("document.querySelector('#toggle-sidebar').click()");
    assert.equal(win.isVisible(),false);assert.equal(notifications,0);assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'ui-polish.json'),JSON.stringify({passed:true,offscreen:true,syntheticContent:true,networkRequests:false,systemNotifications:notifications,contrast:ratios,sizes,checks:['model and reasoning inside composer','sidebar task/files/skills shortcuts','files shortcut opens correct panel','selected model and keyboard menu navigation','question/answer alignment','collapsed process','local math and clickable links','no clipped composer controls at 28px','fixed footer remains visible','sidebar toggle','neutral light/dark themes'],fixtureCalls:[...new Set(calls)]},null,2));
    console.log('UI polish checks passed with offscreen rendering.');app.exit(0);
  }catch(e){console.error(e.stack);if(win)fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());app.exit(1);}
})();
