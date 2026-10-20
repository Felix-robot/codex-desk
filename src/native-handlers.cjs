const fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {writePrivate}=require('./storage.cjs');
function installNative({store,handlers,send,app,systemPreferences,globalShortcut,powerMonitor,getWindow}) {
  const tools=[path.join(process.resourcesPath,'local-tools'),path.join(__dirname,'..','local-tools')].find(file=>fs.existsSync(path.join(file,'lib','native.cjs')));
  const {LocalVoice,execute}=require(path.join(tools,'lib','native.cjs'));
  const grantFile=path.join(store.directory,'desktop-access.json');
  let voice,voiceLoading,setupBusy=false,hotkey=false,voiceStarting=null,epoch=0;
  function access(){try{const value=JSON.parse(fs.readFileSync(grantFile,'utf8'));return value.expiresAt>Date.now()?value:null;}catch{return null;}}
  function revoke(){writePrivate(grantFile,JSON.stringify({mode:'off'}));send({method:'desk/desktop',params:{enabled:false}});}
  const stop=()=>{epoch++;revoke();voice?.stop();};revoke();
  async function localVoice(){if(!voiceLoading)voiceLoading=(async()=>{const {runtimePaths}=await import(pathToFileURL(path.join(tools,'lib','integrations.mjs')).href);voice=new LocalVoice({directory:store.directory,python:runtimePaths(path.join(store.directory,'tools')).python,send});return voice;})();return voiceLoading;}
  handlers.nativeStatus=async()=>({...await(await localVoice()).status(),desktop:access(),setupBusy,hotkey,platform:process.platform,permissions:process.platform==='darwin'?{screen:systemPreferences.getMediaAccessStatus('screen'),microphone:systemPreferences.getMediaAccessStatus('microphone'),accessibility:systemPreferences.isTrustedAccessibilityClient(false)}:{}});
  handlers.nativeSetup=async()=>{
    if(setupBusy)throw new Error('依赖正在安装');setupBusy=true;
    try{const v=await localVoice();await execute(v.python,['-B',path.join(tools,'native','setup.py'),store.directory],'',{timeout:600000});voice?.stop();voiceLoading=null;return await handlers.nativeStatus();}catch{throw new Error('本地依赖安装失败，请检查网络和独立 Python 环境后重试');}finally{setupBusy=false;}
  };
  handlers.desktopAccess=async p=>{
    if(p.mode==='off'){revoke();return null;}
    if(!['ask','full'].includes(p.mode))throw new Error('无效控制模式');
    if(process.env.CODEX_DESK_UI_TEST==='1')throw new Error('界面测试不启用真实电脑控制');
    const info=await handlers.nativeStatus();if(!info.modules.pyautogui)throw new Error('请先安装本地依赖');
    const value={id:randomUUID(),mode:p.mode,expiresAt:Date.now()+30*60*1000};writePrivate(grantFile,JSON.stringify(value));send({method:'desk/desktop',params:{enabled:true,...value}});return value;
  };
  handlers.nativeStop=async()=>{stop();return true;};
  handlers.voiceStart=async()=>{
    if(process.env.CODEX_DESK_UI_TEST==='1')throw new Error('界面测试不打开真实麦克风');
    if(voiceStarting)return voiceStarting;
    const requestEpoch=epoch;
    voiceStarting=(async()=>{if(process.platform==='darwin'&&!await systemPreferences.askForMediaAccess('microphone'))throw new Error('请在系统设置中允许 Codex Desk 使用麦克风');const instance=await localVoice();if(requestEpoch!==epoch)return false;await instance.start();return true;})();
    try{return await voiceStarting;}finally{voiceStarting=null;}
  };
  handlers.voicePause=async p=>{(await localVoice()).pause(!!p.paused);return true;};
  handlers.voiceInterrupt=async()=>{voice?.cancelSpeech();return true;};
  handlers.voiceStop=async()=>{epoch++;voice?.stop();return true;};
  handlers.voiceSpeak=async p=>{if(process.env.CODEX_DESK_UI_TEST==='1')throw new Error('界面测试不生成真实语音');return(await localVoice()).speech(p.text);};
  const timer=setInterval(()=>{try{if(fs.existsSync(grantFile)&&!access()){const value=JSON.parse(fs.readFileSync(grantFile,'utf8'));if(value.mode!=='off')revoke();}}catch{revoke();}},5000);timer.unref();
  if(process.env.CODEX_DESK_UI_TEST!=='1')hotkey=globalShortcut.register('CommandOrControl+Alt+Escape',stop);
  powerMonitor.on('suspend',stop);
  getWindow().on('hide',()=>voice?.stop());
  getWindow().webContents.on('did-start-loading',()=>{stop();});
  return{stop:()=>{clearInterval(timer);stop();if(hotkey)globalShortcut.unregister('CommandOrControl+Alt+Escape');powerMonitor.removeListener('suspend',stop);}};
}
module.exports={installNative};
