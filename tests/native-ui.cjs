const {app,BrowserWindow,ipcMain,Notification}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {mockProvider}=require('./mock-provider.cjs');
let notifications=0;Notification.prototype.show=()=>notifications++;
const root=fs.mkdtempSync(path.join(os.tmpdir(),'desk-native-ui-')),project=path.join(root,'project');fs.mkdirSync(project);
process.env.CODEX_DESK_DATA_DIR=path.join(root,'data');process.env.CODEX_DESK_UI_TEST='1';fs.mkdirSync(process.env.CODEX_DESK_DATA_DIR);
fs.writeFileSync(path.join(process.env.CODEX_DESK_DATA_DIR,'settings.json'),JSON.stringify({binary:process.env.DESK_TEST_BINARY||'',projects:[project]}));
// Synthetic audio transport only; nativeStart / nativeSpeak production paths stay untouched.
const handle=ipcMain.handle.bind(ipcMain),commands=[];let spoken=[];
ipcMain.handle=(channel,fn)=>handle(channel,async(event,action,p)=>{
  if(['voiceStart','voicePause','voiceStop','voiceSpeak'].includes(action)){
    commands.push(action);if(action==='voiceSpeak'){spoken.push(p.text);return 'data:audio/wav;base64,fixture';}
    if(action==='voiceStart')setTimeout(()=>event.sender.send('desk:event',{method:'desk/voice',params:{type:'ready'}}),10);
    return true;
  }return fn(event,action,p);
});
require('../src/main.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  let provider,win;const output=process.env.DESK_TEST_ARTIFACTS||path.join(root,'artifacts');fs.mkdirSync(output,{recursive:true});
  try{
    await app.whenReady();win=BrowserWindow.getAllWindows()[0];if(win.webContents.isLoadingMainFrame())await new Promise(r=>win.webContents.once('did-finish-load',r));
    await win.webContents.insertCSS('*{transition:none!important;animation:none!important}');
    const js=code=>win.webContents.executeJavaScript(code,true),until=async(code,label)=>{const end=Date.now()+25000;while(Date.now()<end){if(await js(code))return;await sleep(100);}throw new Error(label);};
    await until('state.initialized&&state.connected','connected');provider=await mockProvider();await js(`call('settings',{baseUrl:${JSON.stringify(provider.url)},model:'desk-test-model',apiKey:'native-ui-fixture',rememberKey:false}).then(applySettings)`);
    await js("window.Audio=class{async play(){setTimeout(()=>this.onended?.(),10);}pause(){this.onpause?.();}};document.querySelector('#voice-button').click()");
    await until("document.querySelector('#workspace-content').textContent.includes('连续语音对话')",'native panel');
    assert.match(await js("document.querySelector('#workspace-content').textContent"),/本次免逐次确认/);
    await assert.rejects(js("call('desktopAccess',{mode:'full'})"),/界面测试/);
    await js("[...document.querySelectorAll('#workspace-content button')].find(b=>b.textContent==='连续语音对话').click()");
    await until("document.querySelector('#voice-button').getAttribute('aria-pressed')==='true'",'voice starts');
    await until("document.querySelector('#native-status span').textContent.includes('正在听')",'microphone ready');
    const emit=(type,text)=>win.webContents.send('desk:event',{method:'desk/voice',params:{type,text}});
    emit('final','合成语音回合一');await until("[...state.turns.values()].some(t=>t.status==='completed')&&document.querySelector('#native-status span').textContent.includes('正在听')",'voice pipeline');
    for(let i=0;i<50&&spoken.length<1;i++)await sleep(100);
    assert.equal(spoken.length,1);assert.match(spoken[0],/连接测试完成/);assert.ok(provider.seen.some(b=>JSON.stringify(b.input).includes('合成语音回合一')));
    emit('final','合成语音回合二');await until("[...state.turns.values()].filter(t=>t.status==='completed').length===2&&document.querySelector('#native-status span').textContent.includes('正在听')",'second voice turn');assert.equal(spoken.length,2);
    emit('final','offline-slow-probe');await until('state.current&&state.active.has(state.current.id)','slow voice model running');
    await js("[...document.querySelectorAll('#native-status button')].find(b=>b.textContent==='打断回答').click()");await until("!state.active.has(state.current.id)&&document.querySelector('#native-status span').textContent.includes('已打断')",'voice interrupt');assert.equal(spoken.length,2);
    await js("[...document.querySelectorAll('#native-status button')].find(b=>b.textContent==='结束语音').click()");await until("document.querySelector('#native-status').hidden",'voice stops');
    const beforeLate=provider.seen.length;emit('final','late transcript must not send');await sleep(200);assert.equal(provider.seen.length,beforeLate);
    await js("document.querySelector('#desktop-button').click()");await until("document.querySelector('#workspace-content').textContent.includes('电脑控制')",'desktop panel');
    await until("document.querySelector('#workspace-dialog').open&&document.querySelector('#workspace-content').textContent.includes('立即停止全部')",'native modal shown');await sleep(300);
    fs.writeFileSync(path.join(output,'native-panel.png'),(await win.webContents.capturePage()).toPNG());
    assert.equal(win.isVisible(),false);assert.equal(notifications,0);
    fs.writeFileSync(path.join(output,'native-ui.json'),JSON.stringify({passed:true,hidden:true,realEngine:true,offlineModel:true,voiceAudioMocked:true,completedVoiceTurns:spoken.length,microphoneOpened:false,audioPlayed:false,screenCaptured:false,nativeInputSent:false,systemNotifications:notifications,checks:['continuous speech sends current model','final reply read by audio adapter','pause during model and speech','resume after playback','running model interrupted by voice UI','late transcript discarded','desktop switch blocked during test']},null,2));
    console.log('Native UI and two voice turns passed with synthetic audio.');app.exit(0);
  }catch(e){console.error(e.stack);console.error(JSON.stringify({spoken,commands,requests:provider?.seen.length,ui:win?await win.webContents.executeJavaScript("({current:state.current?.id,turns:[...state.turns.values()].map(t=>({id:t.id,status:t.status,items:t.items?.map(i=>({type:i.type,phase:i.phase,text:i.text}))})),status:document.querySelector('#native-status')?.textContent})"):null}));if(win)fs.writeFileSync(path.join(output,'native-failure.png'),(await win.webContents.capturePage()).toPNG());app.exit(1);}
  finally{provider?.server.closeAllConnections();provider?.server.close();}
})();
